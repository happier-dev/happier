import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import {
    createSessionBoardActionsPort,
    type SessionBoardActionsPort,
} from '@/sync/domains/session/board';
import { useAuth } from '@/auth/context/AuthContext';
import { openAccountSecurityForHome } from '@/components/settings/account/openAccountSecurityForHome';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { openRouteWithEstablishedHome } from '@/sync/domains/server/selection/openRouteWithEstablishedHome';
import { useSessionBoardFeatureEnabled } from './useSessionBoardFeatureEnabled';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { FocusReturnRef, FocusReturnTarget } from '@/keyboard/focusReturn';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useSessionPluginPolicyContext } from '@/components/sessions/plugins/useSessionPluginPolicyContext';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { useSessionCallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useSessionBoardComposerSuggestion } from './useSessionBoardComposerSuggestion';

import {
    SessionBoardContinuityProvider,
    useSessionBoardContinuity,
} from './SessionBoardContinuity';
import {
    createSessionBoardSourceAvailabilityResolver,
} from './sessionBoardItemPresentation';
import { useSessionBoardSnapshot } from './useSessionBoardSnapshot';
import {
    useSessionBoardController,
    type SessionBoardController,
    type SessionBoardControllerInput,
} from './useSessionBoardController';
import { showSessionBoardViewRemovalDisposition } from './showSessionBoardViewRemovalDisposition';
import {
    selectCurrentSessionWidgetCandidates,
    type WidgetCandidate,
} from '@/components/widgets/widgetCatalog';
import type { SessionBoardBinding } from './observeSessionBoard';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionBoardMutationApproval } from './sessionBoardMutationApproval';


export type MountedSessionBoardController = Readonly<{
    address: SessionAddress;
    controller: SessionBoardController;
    binding: SessionBoardBinding & Readonly<{ refresh?: () => void }>;
    actions: SessionBoardActionsPort;
    approvalPending: boolean;
    requestApprovalContinuation?: ReturnType<typeof useSessionBoardMutationApproval>['request'];
    pluginRuntime: SessionPluginRuntimeState;
    callerHostedHtmlRuntime: CallerHostedHtmlRuntime | null;
    /** One exact-session policy selection shared by Add visibility and picker rows. */
    installedWidgetCandidates: readonly WidgetCandidate[];
    /** Actual open Board/Companion inventory consumers share this content demand. */
    acquireContent?: () => () => void;
    /** Demanded transcript occurrences; visibility withdraws the exact occurrence. */
    reportInlineTranscriptDemand: (itemId: string, occurrence: string, seq: number | null) => () => void;
    /** The selected demanded occurrence, otherwise the latest demanded occurrence. */
    resolveInlineTranscriptOccurrence: (itemId: string) => string | null;
    /** Select an exact demanded occurrence through the existing presentation Action. */
    showInlineTranscriptItem: (itemId: string, occurrence?: string) => 'applied' | 'unchanged' | 'unavailable';
    /** Registers the real workspace tab hosts consumed by Board removal dialogs. */
    onViewFocusTargetChange: (viewId: string, target: FocusReturnTarget) => void;
    /** Registers the workspace's surviving Board-view action control fallback. */
    onViewActionsFocusTargetChange: (target: FocusReturnTarget) => void;
    /** Absent for direct/test owners that register no workspace action control. */
    viewActionsFocusTargetRef?: FocusReturnRef;
}>;

const NO_INSTALLED_WIDGET_CANDIDATES: readonly WidgetCandidate[] = Object.freeze([]);
type TranscriptVisualOccurrence = Readonly<{ id: string; seq: number | null }>;
const NO_INLINE_TRANSCRIPT_DEMAND: ReadonlyMap<string, readonly TranscriptVisualOccurrence[]> = new Map();
const NO_INLINE_TRANSCRIPT_SELECTION: ReadonlyMap<string, string> = new Map();

function latestTranscriptOccurrence(occurrences: readonly TranscriptVisualOccurrence[] | undefined): string | null {
    return occurrences?.reduce<TranscriptVisualOccurrence | null>((latest, occurrence) => {
        if (!latest) return occurrence;
        if (occurrence.seq === null) return latest.seq === null ? occurrence : latest;
        return latest.seq === null || occurrence.seq >= latest.seq ? occurrence : latest;
    }, null)?.id ?? null;
}

const SessionBoardControllerContext = React.createContext<MountedSessionBoardController | null>(null);

function SessionBoardWidgetCandidateSelection(props: Readonly<{
    session: Session | null;
    runtime: SessionPluginRuntimeState;
    boardFeatureEnabled: boolean;
    canEdit: boolean;
    hostedHtmlRendererAvailable: boolean;
    children: (selection: Readonly<{
        candidates: readonly WidgetCandidate[];
        resolveSourceAvailability: ReturnType<typeof createSessionBoardSourceAvailabilityResolver>;
    }>) => React.ReactElement;
}>): React.ReactElement {
    if (!props.session) return props.children({
        candidates: NO_INSTALLED_WIDGET_CANDIDATES,
        resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver({
            hostedHtmlRendererAvailable: props.hostedHtmlRendererAvailable,
        }),
    });
    return (
        <SessionBoardWidgetCandidateSelectionReady
            session={props.session}
            runtime={props.runtime}
            boardFeatureEnabled={props.boardFeatureEnabled}
            canEdit={props.canEdit}
            hostedHtmlRendererAvailable={props.hostedHtmlRendererAvailable}
        >
            {props.children}
        </SessionBoardWidgetCandidateSelectionReady>
    );
}

function SessionBoardWidgetCandidateSelectionReady(props: Readonly<{
    session: Session;
    runtime: SessionPluginRuntimeState;
    boardFeatureEnabled: boolean;
    canEdit: boolean;
    hostedHtmlRendererAvailable: boolean;
    children: (selection: Readonly<{
        candidates: readonly WidgetCandidate[];
        resolveSourceAvailability: ReturnType<typeof createSessionBoardSourceAvailabilityResolver>;
    }>) => React.ReactElement;
}>): React.ReactElement {
    const policyContext = useSessionPluginPolicyContext({
        session: props.session,
        runtime: props.runtime,
    });
    // The policy context follows the Session's live state (working, waiting), which moves every turn; the
    // candidates it admits usually do not, and an equal list keeps its identity so the Board owner stays put.
    const previousCandidatesRef = React.useRef<readonly WidgetCandidate[] | undefined>(undefined);
    const candidates = React.useMemo(() => {
        const next = retainIfEqual(previousCandidatesRef.current, selectCurrentSessionWidgetCandidates({
            runtime: props.runtime,
            boardFeatureEnabled: props.boardFeatureEnabled,
            canEdit: props.canEdit,
            policyContext,
        }));
        previousCandidatesRef.current = next;
        return next;
    }, [policyContext, props.boardFeatureEnabled, props.canEdit, props.runtime]);
    const resolveSourceAvailability = React.useMemo(
        () => createSessionBoardSourceAvailabilityResolver({
            hostedHtmlRendererAvailable: props.hostedHtmlRendererAvailable,
        }),
        [props.hostedHtmlRendererAvailable],
    );
    const { children } = props;
    return React.useMemo(() => children({ candidates, resolveSourceAvailability }), [candidates, children, resolveSourceAvailability]);
}

/**
 * Mount the one viewer-local Board controller for an exact Session destination or standalone shell.
 *
 * Board panes are projections of this owner. They never construct controllers,
 * snapshots, CAS/recovery refs, draft state, or active-view state themselves.
 * Nothing here is global or persisted: removing this exact Session shell drops
 * its local presentation state naturally.
 */
export function SessionBoardControllerProvider(props: React.PropsWithChildren<Readonly<{
    sessionId: string;
    serverId?: string | null;
    /**
     * The exact Session shell may already own the plugin runtime so its pane
     * driver, Board, Companion, and full-screen surfaces all observe the same
     * projection instance. Direct/test hosts may omit it and resolve here.
     */
    pluginRuntime?: SessionPluginRuntimeState;
}>>): React.ReactElement {
    const existingOwner = React.useContext(SessionBoardControllerContext);
    const address = React.useMemo(
        () => normalizeSessionAddress(props.serverId ?? null, props.sessionId),
        [props.serverId, props.sessionId],
    );
    if (!address) return <>{props.children}</>;
    if (existingOwner && sessionAddressKey(existingOwner.address) === sessionAddressKey(address)) {
        return <>{props.children}</>;
    }

    const addressKey = sessionAddressKey(address);
    const content = (
        <SessionBoardContinuityProvider
            key={addressKey}
            sessionId={address.sessionId}
            serverId={address.serverId}
        >
            <SessionBoardControllerRuntimeOwner
                address={address}
                pluginRuntime={props.pluginRuntime}
            >
                {props.children}
            </SessionBoardControllerRuntimeOwner>
        </SessionBoardContinuityProvider>
    );
    return content;
}

function SessionBoardControllerRuntimeOwner(props: React.PropsWithChildren<Readonly<{
    address: SessionAddress;
    pluginRuntime?: SessionPluginRuntimeState;
}>>): React.ReactElement {
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(props.address.serverId);
    const [contentDemand, setContentDemand] = React.useState(0);
    const acquireContent = React.useCallback(() => {
        setContentDemand(value => value + 1);
        return () => setContentDemand(value => value - 1);
    }, []);
    const binding = useSessionBoardSnapshot({
        serverId: props.address.serverId,
        sessionId: props.address.sessionId,
        boardFeatureEnabled,
        demanded: contentDemand > 0,
    });
    const actions = React.useMemo<SessionBoardActionsPort>(
        () => createSessionBoardActionsPort(props.address),
        [props.address],
    );
    const approval = useSessionBoardMutationApproval({
        address: props.address,
        onExecuted: binding.refresh,
    });
    const resolvedPluginRuntime = useSessionPluginRuntime({
        address: props.pluginRuntime ? null : props.address,
    });
    const pluginRuntime = props.pluginRuntime ?? resolvedPluginRuntime;
    const session = useSessionViewShellSession(props.address.sessionId, props.address.serverId);
    const callerHostedHtmlRuntime = useSessionCallerHostedHtmlRuntime(
        props.address.serverId,
        props.address.sessionId,
        pluginRuntime,
    );
    const viewFocusTargetsRef = React.useRef(new Map<string, FocusReturnTarget>());
    const viewActionsFocusTargetRef = React.useRef<FocusReturnTarget>(null);
    const onViewFocusTargetChange = React.useCallback((viewId: string, target: FocusReturnTarget) => {
        if (target == null) viewFocusTargetsRef.current.delete(viewId);
        else viewFocusTargetsRef.current.set(viewId, target);
    }, []);
    const onViewActionsFocusTargetChange = React.useCallback((target: FocusReturnTarget) => {
        viewActionsFocusTargetRef.current = target;
    }, []);
    const focusReturnRefForView = React.useCallback((viewId: string): FocusReturnRef => ({
        get current() {
            return viewFocusTargetsRef.current.get(viewId) ?? viewActionsFocusTargetRef.current;
        },
    }), []);
    const promptViewTitle = React.useCallback(async (request: Readonly<{
        title: string;
        defaultValue?: string;
    }>): Promise<string | null> => await Modal.prompt(request.title, undefined, {
        ...(request.defaultValue === undefined ? {} : { defaultValue: request.defaultValue }),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
    }), []);
    const chooseViewRemovalDisposition = React.useCallback((request: Parameters<
        typeof showSessionBoardViewRemovalDisposition
    >[0]) => showSessionBoardViewRemovalDisposition(
        request,
        focusReturnRefForView(request.source.viewId),
    ), [focusReturnRefForView]);
    const continuity = useSessionBoardContinuity(props.address);

    // Recovery navigation belongs to the controller, not to a placement.
    //
    // Every Board host renders the same typed unavailable states, and the Board's
    // OWN locked layout card asks `controller.supports('item.prepareEncryption')`
    // for its action. While these handlers lived in `SessionBoardPane`, that
    // question was permanently `false` in production: a locked shared layout drew
    // a recovery card with no way out, even though the identical per-item card in
    // the same surface had a working handler. One owner, one answer, every host.
    const router = useRouter();
    const auth = useAuth();
    const presentRecoveryNavigationError = React.useCallback(() => {
        Modal.alert(t('common.error'), t('errors.unknownError'));
    }, []);
    const openRecoveryRoute = React.useCallback(async (navigate: () => void): Promise<void> => {
        try {
            const result = await openRouteWithEstablishedHome({
                serverId: props.address.serverId,
                refreshAuth: auth.refreshFromActiveServer,
                navigate,
            });
            if (result === 'blocked') presentRecoveryNavigationError();
        } catch {
            presentRecoveryNavigationError();
        }
    }, [auth.refreshFromActiveServer, presentRecoveryNavigationError, props.address.serverId]);
    const bindingRef = React.useRef(binding);
    bindingRef.current = binding;
    const managePluginForItem = React.useCallback(async (itemId: string): Promise<void> => {
        const current = bindingRef.current;
        const projected = current.status === 'ready' ? current.snapshot.itemsById.get(itemId) : null;
        if (projected?.state.kind !== 'ready') return;
        const source = projected.state.item.source;
        if (source.kind !== 'widget' || source.instance.definition.kind !== 'installed') return;
        const pluginId = source.instance.definition.surface.pluginId;
        await openRecoveryRoute(() => { router.push(buildPluginDetailRoute('settings', pluginId)); });
    }, [openRecoveryRoute, router]);

    // Board records use the Session's existing Plain/E2EE owner. A locked row
    // therefore recovers through the incumbent Account security screen after
    // establishing this exact Session Home; no Board-local key flow exists.
    const prepareEncryption = React.useCallback(async (): Promise<void> => {
        try {
            const opened = await openAccountSecurityForHome({
                serverId: props.address.serverId,
                router,
                refreshAuth: auth.refreshFromActiveServer,
            });
            if (!opened) presentRecoveryNavigationError();
        } catch {
            presentRecoveryNavigationError();
        }
    }, [auth.refreshFromActiveServer, presentRecoveryNavigationError, props.address.serverId, router]);

    const askAgent = useSessionBoardComposerSuggestion(props.address);

    return (
        <SessionBoardWidgetCandidateSelection
            session={session}
            runtime={pluginRuntime}
            boardFeatureEnabled={boardFeatureEnabled}
            canEdit={binding.status === 'ready' && binding.snapshot.canEdit}
            hostedHtmlRendererAvailable={callerHostedHtmlRuntime !== null}
        >
            {({ candidates: installedWidgetCandidates, resolveSourceAvailability }) => (
                <SessionBoardControllerOwner
                    address={props.address}
                    input={{
                        sessionId: props.address.sessionId,
                        serverId: props.address.serverId,
                        binding,
                        actions,
                        approvalPending: approval.pending,
                        requestApprovalContinuation: approval.request,
                        resolveSourceAvailability,
                        chooseViewRemovalDisposition,
                        promptViewTitle,
                        onManagePlugin: managePluginForItem,
                        onPrepareEncryption: prepareEncryption,
                        // Absent when no mounted composer of this exact Home/Session can
                        // accept it, so the Add row never draws a control that does nothing.
                        ...(askAgent ? { onAskAgent: askAgent } : {}),
                        ...(continuity
                            ? { beforeReplaceNoteDraft: (replace: () => void | Promise<void>) => continuity.draftGuard.run(replace) }
                            : {}),
                        callerHostedHtmlAvailable: callerHostedHtmlRuntime !== null,
                    }}
                    binding={binding}
                    actions={actions}
                    approvalPending={approval.pending}
                    requestApprovalContinuation={approval.request}
                    pluginRuntime={pluginRuntime}
                    callerHostedHtmlRuntime={callerHostedHtmlRuntime}
                    installedWidgetCandidates={installedWidgetCandidates}
                    acquireContent={acquireContent}
                    onViewFocusTargetChange={onViewFocusTargetChange}
                    onViewActionsFocusTargetChange={onViewActionsFocusTargetChange}
                    viewActionsFocusTargetRef={viewActionsFocusTargetRef}
                >
                    {props.children}
                </SessionBoardControllerOwner>
            )}
        </SessionBoardWidgetCandidateSelection>
    );
}

/** Focused owner seam used by mounted tests without reconstructing runtime boundaries. */
export function SessionBoardControllerOwner(props: React.PropsWithChildren<Readonly<{
    address: SessionAddress;
    input: Omit<SessionBoardControllerInput, 'installedWidgetsAvailable'>;
    binding: SessionBoardBinding & Readonly<{ refresh?: () => void }>;
    actions: SessionBoardActionsPort;
    approvalPending?: boolean;
    requestApprovalContinuation?: ReturnType<typeof useSessionBoardMutationApproval>['request'];
    pluginRuntime: SessionPluginRuntimeState;
    callerHostedHtmlRuntime: CallerHostedHtmlRuntime | null;
    installedWidgetCandidates?: readonly WidgetCandidate[];
    acquireContent?: () => () => void;
    onViewFocusTargetChange?: (viewId: string, target: FocusReturnTarget) => void;
    onViewActionsFocusTargetChange?: (target: FocusReturnTarget) => void;
    viewActionsFocusTargetRef?: FocusReturnRef;
}>>): React.ReactElement {
    const installedWidgetCandidates = props.installedWidgetCandidates ?? NO_INSTALLED_WIDGET_CANDIDATES;
    const controllerInput = React.useMemo<SessionBoardControllerInput>(() => ({
        ...props.input,
        // This exact list is the availability fact. Deriving the menu intent
        // here prevents direct/test hosts from diverging from picker contents.
        installedWidgetsAvailable: installedWidgetCandidates.length > 0,
    }), [installedWidgetCandidates, props.input]);
    const controller = useSessionBoardController(controllerInput);
    // Sequence belongs to the transcript row, so recycling an older row cannot move the body.
    const [inlineTranscriptDemand, setInlineTranscriptDemand] = React.useState(NO_INLINE_TRANSCRIPT_DEMAND);
    const [inlineTranscriptSelection, setInlineTranscriptSelection] = React.useState(NO_INLINE_TRANSCRIPT_SELECTION);
    const reportInlineTranscriptDemand = React.useCallback((itemId: string, occurrence: string, seq: number | null) => {
        setInlineTranscriptDemand((current) => {
            const occurrences = current.get(itemId) ?? [];
            if (occurrences.some(candidate => candidate.id === occurrence)) return current;
            return new Map(current).set(itemId, [...occurrences, { id: occurrence, seq }]);
        });
        return () => setInlineTranscriptDemand((current) => {
            const occurrences = current.get(itemId);
            if (!occurrences?.some(candidate => candidate.id === occurrence)) return current;
            const next = new Map(current);
            const remaining = occurrences.filter(candidate => candidate.id !== occurrence);
            if (remaining.length > 0) next.set(itemId, remaining);
            else next.delete(itemId);
            return next;
        });
    }, []);
    const resolveInlineTranscriptOccurrence = React.useCallback(
        (itemId: string) => {
            const occurrences = inlineTranscriptDemand.get(itemId);
            const selected = inlineTranscriptSelection.get(itemId);
            return selected && occurrences?.some(candidate => candidate.id === selected)
                ? selected : latestTranscriptOccurrence(occurrences);
        },
        [inlineTranscriptDemand, inlineTranscriptSelection],
    );
    const showInlineTranscriptItem = React.useCallback<MountedSessionBoardController['showInlineTranscriptItem']>((itemId, occurrence) => {
        const occurrences = inlineTranscriptDemand.get(itemId);
        const target = occurrence ?? latestTranscriptOccurrence(occurrences);
        if (!target || !occurrences?.some(candidate => candidate.id === target)) return 'unavailable';
        if (inlineTranscriptSelection.get(itemId) === target) return 'unchanged';
        setInlineTranscriptSelection(current => new Map(current).set(itemId, target));
        return 'applied';
    }, [inlineTranscriptDemand, inlineTranscriptSelection]);
    React.useEffect(() => {
        setInlineTranscriptSelection(current => {
            const kept = [...current].filter(([itemId, occurrence]) => inlineTranscriptDemand.get(itemId)
                ?.some(candidate => candidate.id === occurrence));
            return kept.length === current.size ? current : new Map(kept);
        });
    }, [inlineTranscriptDemand]);
    const value = React.useMemo<MountedSessionBoardController>(() => ({
        address: props.address,
        controller,
        binding: props.binding,
        actions: props.actions,
        approvalPending: props.approvalPending === true,
        ...(props.requestApprovalContinuation
            ? { requestApprovalContinuation: props.requestApprovalContinuation }
            : {}),
        pluginRuntime: props.pluginRuntime,
        callerHostedHtmlRuntime: props.callerHostedHtmlRuntime,
        installedWidgetCandidates,
        ...(props.acquireContent ? { acquireContent: props.acquireContent } : {}),
        reportInlineTranscriptDemand,
        resolveInlineTranscriptOccurrence,
        showInlineTranscriptItem,
        onViewFocusTargetChange: props.onViewFocusTargetChange ?? (() => {}),
        onViewActionsFocusTargetChange: props.onViewActionsFocusTargetChange ?? (() => {}),
        viewActionsFocusTargetRef: props.viewActionsFocusTargetRef,
    }), [props.acquireContent, props.actions, props.address, props.approvalPending, props.binding, props.callerHostedHtmlRuntime, installedWidgetCandidates, props.onViewActionsFocusTargetChange, props.onViewFocusTargetChange, props.pluginRuntime, props.requestApprovalContinuation, props.viewActionsFocusTargetRef, controller, reportInlineTranscriptDemand, resolveInlineTranscriptOccurrence, showInlineTranscriptItem]);
    return (
        <SessionBoardControllerContext.Provider value={value}>
            {props.children}
        </SessionBoardControllerContext.Provider>
    );
}

/** Exact-address consumer; a pane can never borrow another retained Session's controller. */
export function useMountedSessionBoardController(address: SessionAddress | null): MountedSessionBoardController | null {
    const mounted = React.useContext(SessionBoardControllerContext);
    if (!mounted || !address) return null;
    return sessionAddressKey(mounted.address) === sessionAddressKey(address) ? mounted : null;
}
