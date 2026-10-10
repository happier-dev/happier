import {
    HappierPresenceCapsule,
    type HappierPresenceCapsuleCopy,
    type HappierPresenceCapsulePlacement,
    type HappierPresenceCapsuleProps,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { CORE_CAPSULE_HOST, useCoreCapsuleColors } from '@/components/ui/status/capsuleHost';
import type { BrowserAgentActivity, BrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import { t } from '@/text';

const ACTIVITY_KEY: Record<BrowserAgentActivity, Parameters<typeof t>[0]> = {
    click: 'browserPresence.doing.click',
    type: 'browserPresence.doing.type',
    fill: 'browserPresence.doing.fill',
    scroll: 'browserPresence.doing.scroll',
    navigate: 'browserPresence.doing.navigate',
    history: 'browserPresence.doing.history',
    reload: 'browserPresence.doing.reload',
    press: 'browserPresence.doing.press',
    select: 'browserPresence.doing.select',
    drag: 'browserPresence.doing.drag',
    upload: 'browserPresence.doing.upload',
    look: 'browserPresence.doing.look',
    other: 'browserPresence.doing.other',
};

export type BrowserPresenceAgent = Readonly<{
    /** Catalog agent id for the mark; omitted when the host cannot name the agent. */
    agentId?: string | null;
    /** The agent's display name ("Claude"). */
    name: string;
}>;

export type BrowserPresenceCapsuleProps = Readonly<{
    presence: BrowserCopresence;
    agent: BrowserPresenceAgent;
    /** Absent when this surface has no route to take control. */
    onTakeControl?: HappierPresenceCapsuleProps['onTakeControl'];
    /** Absent when the owner offers no hand back from this surface. */
    onHandBack?: () => void;
    /**
     * A fresh look at the surface, which is what confirms an unconfirmed stop (computer use). Absent
     * where the owner has no unconfirmed state.
     */
    onCheckAgain?: () => void;
    /** The fresh look is in flight. */
    checking?: boolean;
    /**
     * What the agent is doing, said for this surface ("Claude is browsing"). Other streamed
     * surfaces (the desktop) pass their own; the browser's is the default.
     */
    agentTitle?: string;
    /** Phone and narrow panes: the capsule spans the frame in thumb reach. */
    compact?: boolean;
    /**
     * `dock` (default) floats it over the surface it narrates; `inline` sits in flow, for the
     * session-wide line that says who is using a shared window wherever the person is in the session.
     */
    placement?: HappierPresenceCapsulePlacement;
    /** The agent's line when no activity is known ("on MacBook Pro"). */
    agentDetail?: string;
    /**
     * A standing fact about this surface that the person must read instead of the narration
     * ("Mouse and keyboard control aren't allowed"): it takes the agent's line while it holds.
     */
    agentNote?: string;
    /** This surface's words for the person's control ("Claude is paused · You have control of Safari"). */
    humanTitle?: string;
    humanDetail?: string;
    /** The takeover control's label where the surface says it differently ("Stop" in the session strip). */
    takeControlLabel?: string;
    /** Opens the surface this capsule narrates (the session-wide line's Watch). */
    onWatch?: () => void;
    testID: string;
}>;

/** The agent's narration for its current action ("Clicking “Sign in”"), or the surface's own line. */
function resolveAgentDetail(presence: BrowserCopresence, fallback: string | undefined): string | null {
    if (presence.kind !== 'agent') return null;
    if (!presence.activity) return fallback ?? null;
    const label = presence.target?.label;
    if (presence.activity === 'click' && label) return t('browserPresence.clickTarget', { target: label });
    return label ? `${t(ACTIVITY_KEY[presence.activity])} · ${label}` : t(ACTIVITY_KEY[presence.activity]);
}

/**
 * Happier core's binding of the one presence capsule (`HappierPresenceCapsule` in
 * `@happier-dev/plugin-ui/presentation`, the same owner plugins draw): who is driving the page or the
 * shared window, the narration, and the one control (Take control → Stopping → You have control ·
 * Hand back, or Couldn't confirm the stop · Check again). This binding supplies only what the app
 * owns: the copy in the app's locale, the agent's catalog mark, the app's leaves (glass, type roles,
 * round button, step transition, overlay motion) and its colour tokens. Takeover itself stays with the
 * controller owner the caller wires `onTakeControl` / `onHandBack` to.
 */
export function BrowserPresenceCapsule(props: BrowserPresenceCapsuleProps): React.ReactElement | null {
    const colors = useCoreCapsuleColors();
    const agentName = props.agent.name;
    const copy: HappierPresenceCapsuleCopy = {
        agentTitle: props.agentTitle ?? t('browserPresence.agentBrowsing', { agent: agentName }),
        agentDetail: props.presence.kind === 'agent' && props.agentNote
            ? props.agentNote
            : resolveAgentDetail(props.presence, props.agentDetail),
        stopping: t('browserPresence.stopping', { agent: agentName }),
        stoppingDetail: t('browserPresence.stoppingDetail'),
        humanTitle: props.humanTitle ?? t('browserPresence.youHaveControl'),
        humanDetail: props.humanDetail ?? null,
        pausedUntilHandBack: t('browserPresence.pausedUntilHandBack', { agent: agentName }),
        stopUnconfirmed: t('browserPresence.stopUnconfirmed'),
        lastActionMayHaveLanded: t('browserPresence.lastActionMayHaveLanded', { agent: agentName }),
        takeControl: props.takeControlLabel ?? t('browserPresence.takeControl'),
        handBack: t('browserPresence.handBack'),
        checkAgain: t('browserPresence.checkAgain'),
        watch: t('browserTool.watch'),
    };
    const agentId = props.agent.agentId;
    const renderAgentMark = React.useMemo(
        () => (agentId ? (size: number) => <AgentIcon agentId={agentId} size={size} /> : undefined),
        [agentId],
    );
    return (
        <HappierPresenceCapsule
            presence={props.presence}
            copy={copy}
            renderAgentMark={renderAgentMark}
            onTakeControl={props.onTakeControl}
            onHandBack={props.onHandBack}
            onCheckAgain={props.onCheckAgain}
            checking={props.checking}
            onWatch={props.onWatch}
            compact={props.compact}
            placement={props.placement}
            colors={colors}
            host={CORE_CAPSULE_HOST}
            testID={props.testID}
        />
    );
}
