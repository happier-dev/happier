import type { HappierAgentPageRect, HappierPresenceTakeControlResult } from '@happier-dev/plugin-ui/presentation';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { type ActionExecuteResult, type BrowserCommandV1 } from '@happier-dev/protocol';
import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { useSession } from '@/sync/domains/state/storage';
import { readBrowserAgentPoint, selectBrowserAgentPoint, selectBrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import { t } from '@/text';

import { BrowserFrameStatusCapsule } from '@/components/browser/frame/BrowserFrameStatusCapsule';
import {
    usePublishSessionViewerPresence,
    usePublishSessionViewerSourceFacts,
    useSessionViewerBodyPresentation,
    type SessionViewerPresence,
    type SessionViewerSourceNavigation,
} from '@/components/sessions/viewer/SessionViewerController';

import { BrowserAgentCursor } from './BrowserAgentCursor';
import { BrowserPresenceFooter } from './BrowserPresenceCapsule';

/**
 * The session whose agent drives this browser. The leaf reads the session's agent (for its mark and
 * name) and its canonical activity (`thinking`: is the turn running) itself, so the chrome around it
 * never subscribes to the session record.
 */
export type BrowserShellAgentPresence = Readonly<{
    sessionId: string;
    serverId?: string | null;
    /**
     * The agent's catalog id when the host already knows it without a Session record in this
     * client's store (a dev specimen; a surface opened from another Home). The Session's own agent,
     * when its record is here, always wins.
     */
    knownAgentId?: string | null;
}>;

function resolveAgentName(agentId: string | null | undefined): string {
    const core = agentId ? getAgentCore(agentId as AgentId) : null;
    return core ? t(core.displayNameKey) : t('browserPresence.agentFallbackName');
}

/**
 * The session's agent as the browser surfaces name it: its catalog id (for the mark), its display
 * name, and whether its turn is running (`thinking`, the session's canonical activity). Read in the
 * leaf that renders it, so the chrome never subscribes to the session record.
 */
export function useBrowserSessionAgentIdentity(agent: BrowserShellAgentPresence | null): Readonly<{
    agentId: string | null;
    name: string;
    turnActive: boolean | undefined;
}> {
    const session = useSession(agent?.sessionId ?? '', agent?.serverId ?? null);
    const turnActive = session ? session.thinking === true : undefined;
    const sessionMetadata = session?.metadata;
    const sessionLayoutVersion = session?.metadataLayoutVersion;
    const agentId = React.useMemo(
        () => (session ? readSessionPresentationAgentId(session) : null),
        // The agent identity changes only with the session's metadata.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sessionMetadata, sessionLayoutVersion],
    );
    const resolvedAgentId = agentId ?? agent?.knownAgentId ?? null;
    return React.useMemo(
        () => ({ agentId: resolvedAgentId, name: resolveAgentName(resolvedAgentId), turnActive }),
        [resolvedAgentId, turnActive],
    );
}

/**
 * The presence capsule's data leaf. It alone subscribes to the automation owner, so a controller
 * change or a finished action re-renders this capsule and not the browser chrome around it.
 *
 * Take control, Hand back and Check again use the host's Browser Action ingress. The existing runtime adapter
 * reaches the controller owner; only its authoritative evidence changes who controls the page.
 */
export function BrowserShellPresence(props: Readonly<{
    view: BrowserControlViewState;
    /** The in-app automation owner, for views the app renders itself. */
    controlService: BrowserAutomationControlService | null;
    onCommand?: (command: BrowserCommandV1) => void | Promise<ActionExecuteResult>;
    onCheckAgain?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => Promise<ActionExecuteResult>;
    agent: BrowserShellAgentPresence | null;
    /** Where the page is drawn when it does not fill the frame (a fitted stream). */
    pageRect?: HappierAgentPageRect | null;
    compact?: boolean;
    /** In the Session viewer: the page's Back, Forward and Reload, offered in the viewer's menu. */
    viewerNavigation?: SessionViewerSourceNavigation | null;
    /** Closing the page is what ends a confidential hold (the source owner drops it with the page). */
    onClosePage?: () => void;
    nowMs?: () => number;
    testID: string;
}>): React.ReactElement | null {
    const { controlService, view } = props;
    const presentation = useSessionViewerBodyPresentation();
    const inViewer = presentation === 'viewer';
    const viewerSource = presentation !== null;
    // A daemon-owned view's controller is the daemon's (its `controllerChanged` events, ingested into
    // the view state); an in-app view's is the in-app automation owner. One projection, two owners,
    // never a third copy here.
    const daemonOwned = isDaemonAuthoritativeBrowserView(view);
    const [version, setVersion] = React.useState(0);
    React.useEffect(() => {
        if (!controlService || daemonOwned) return undefined;
        return controlService.subscribe(() => setVersion((current) => current + 1));
    }, [controlService, daemonOwned]);

    const viewKey = React.useMemo(
        () => ({ browserSessionId: view.browserSessionId, viewId: view.viewId }),
        [view.browserSessionId, view.viewId],
    );
    const identity = useBrowserSessionAgentIdentity(props.agent);
    const agentTurnActive = identity.turnActive;
    const daemonController = daemonOwned ? view.automationController ?? null : null;
    // Presentation of this admitted request only; the controller's uncertainty is never reset here.
    const [checking, setChecking] = React.useState(false);

    const presence = React.useMemo(() => selectBrowserCopresence({
        snapshot: !daemonOwned && controlService ? controlService.getSnapshot() : null,
        controllerState: daemonController,
        view: viewKey,
        agentTurnActive,
        timeline: !daemonOwned && controlService ? controlService.getActionTimeline(viewKey) : [],
    }), [agentTurnActive, controlService, daemonController, daemonOwned, version, viewKey]);

    const agentPoint = React.useMemo(() => selectBrowserAgentPoint({
        lastPoint: daemonOwned ? view.agentPoint : !controlService ? null : readBrowserAgentPoint(controlService.getSnapshot(), viewKey),
        presence,
    }), [controlService, daemonOwned, presence, view.agentPoint, viewKey]);

    const agent = React.useMemo(
        () => ({ agentId: identity.agentId, name: identity.name }),
        [identity.agentId, identity.name],
    );

    const nowMs = props.nowMs;
    const takeControl = React.useCallback(async (): Promise<HappierPresenceTakeControlResult> => {
        const result = await props.onCommand?.({ kind: 'takeControl', commandId: `take-control:${view.viewId}:${nowMs?.() ?? Date.now()}`, ...viewKey });
        if (!result) return { status: 'failed' };
        if (!result.ok) return { status: result.errorCode === 'browser_control_unconfirmed' ? 'unknown' : 'failed' };
        const dispatched = BrowserCommandDispatchResultV1Schema.safeParse(result.result);
        return { status: dispatched.success && dispatched.data.status === 'dispatched' ? 'accepted' : 'failed' };
    }, [nowMs, props.onCommand, view.viewId, viewKey]);
    const handBack = React.useCallback(() => {
        void props.onCommand?.({ kind: 'handBack', commandId: `hand-back:${view.viewId}:${nowMs?.() ?? Date.now()}`, ...viewKey });
    }, [nowMs, props.onCommand, view.viewId, viewKey]);
    const canControl = Boolean(props.onCommand) && (daemonOwned || controlService !== null);
    const checkAgain = React.useCallback(async () => {
        if (!props.onCheckAgain) return;
        setChecking(true);
        try { await props.onCheckAgain(viewKey); } catch {
            // A failed fresh look does not change the owner's existing recovery evidence.
        } finally { setChecking(false); }
    }, [props.onCheckAgain, viewKey]);
    // The source owner holds Agent reading and recording while a confidential entry stays on the page;
    // only closing the page ends it (navigating or handing back does not).
    const confidentialityHeld = daemonController?.confidentialityHeld === true;

    // The Session viewer draws who acts below the picture and moves by the picture while it is only
    // watched; this leaf stays the one owner of the takeover it hands over.
    // Fit checks in the dock predict the same floating footer. Its source fact must
    // survive that handoff even though the pane draws its own capsule.
    const viewerPresence = React.useMemo<SessionViewerPresence | null>(() => (viewerSource ? {
        presence,
        agent,
        onTakeControl: canControl ? takeControl : undefined,
        onHandBack: canControl ? handBack : undefined,
        onCheckAgain: props.onCheckAgain ? checkAgain : undefined,
        checking,
    } : null), [agent, canControl, handBack, viewerSource, presence, takeControl, props.onCheckAgain, checkAgain, checking]);
    usePublishSessionViewerPresence('browser', viewerPresence);
    usePublishSessionViewerSourceFacts('browser', inViewer ? {
        machineName: null,
        personInControl: presence.kind === 'human',
        watching: presence.kind === 'agent' || presence.kind === 'stopping' || presence.kind === 'unconfirmed',
        navigation: props.viewerNavigation ?? null,
    } : null);

    return (
        <>
            <BrowserAgentCursor
                testID={`${props.testID}-cursor`}
                target={presence.kind === 'agent' ? presence.target : null}
                point={agentPoint}
                pageRect={props.pageRect}
                agentId={agent.agentId}
            />
            {confidentialityHeld ? (
                <BrowserFrameStatusCapsule
                    testID={`${props.testID}-confidential-hold`}
                    text={t('browserPresence.confidentialHeld', { agent: agent.name })}
                    action={props.onClosePage ? { label: t('browserPresence.closePage'), onPress: props.onClosePage } : undefined}
                />
            ) : null}
            {inViewer ? null : (
                <BrowserPresenceFooter
                    frameTestID={`${props.testID}-frame`}
                    testID={props.testID}
                    presence={presence}
                    agent={agent}
                    compact={props.compact}
                    onTakeControl={canControl ? takeControl : undefined}
                    onHandBack={canControl ? handBack : undefined}
                    onCheckAgain={props.onCheckAgain ? checkAgain : undefined}
                    checking={checking}
                />
            )}
        </>
    );
}
