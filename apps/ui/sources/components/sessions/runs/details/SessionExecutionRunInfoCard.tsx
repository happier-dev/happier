import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { parsePermissionIntentAlias } from '@happier-dev/agents/permissions';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { formatRunDiscussionOriginLabel } from '@/components/sessions/agents/presentation/useSessionAgentRowOriginLabels';
import {
    readExecutionRunAgentActivityStatus,
    resolveAgentActivityStatusPresentation,
    type SessionAgentActivityAttentionPresentation,
} from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { ExecutionRunActionsMenu, type ExecutionRunMenuFact } from '@/components/sessions/runs/details/ExecutionRunActionsMenu';
import { DetailsTabHeader, type DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HEADER_BAND_SUBTITLE_TEXT } from '@/components/ui/layout/headerBand';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import type { AgentType } from '@/sync/domains/models/modelOptions';
import { getPermissionModeLabelForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { t } from '@/text';


const stylesheet = StyleSheet.create((theme) => ({
    live: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    elapsed: {
        ...Typography.default(),
        ...HEADER_BAND_SUBTITLE_TEXT,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
}));

function resolveAgentId(run: ExecutionRunPublicState): string | null {
    if (!run.backendTarget) return null;
    try {
        return readBackendTargetRefV2(run.backendTarget).backendId;
    } catch {
        return null;
    }
}

/** The permission mode in the agent's own words ("Read-only"), never the wire token. */
function resolvePermissionLabel(run: ExecutionRunPublicState, agentId: string | null): string | null {
    const raw = typeof run.permissionMode === 'string' ? run.permissionMode.trim() : '';
    if (!raw) return null;
    const mode = (parsePermissionIntentAlias(raw) ?? raw) as PermissionMode;
    if (agentId) {
        const label = getPermissionModeLabelForAgentType(agentId as AgentType, mode);
        if (label && label !== mode) return label;
    }
    if (mode === 'read-only') return t('executionRuns.newRun.permissionModes.readOnly');
    if (mode === 'default') return t('executionRuns.newRun.permissionModes.default');
    return mode;
}

/** Where the Run came from, in words — a conversation's title, another Session, a tool — never an id. */
function resolveLaunchOriginLabel(run: ExecutionRunPublicState, hostSessionId: string | null, originTitle: string | null): string | null {
    const origin = run.launchOrigin;
    if (!origin) return null;
    if (origin.kind === 'session_discussion') return formatRunDiscussionOriginLabel(originTitle);
    if (origin.kind === 'session') {
        if (origin.sessionId === hostSessionId) return null;
        return t('executionRuns.details.launchOrigin.crossSession', { sessionId: origin.sessionId });
    }
    if (origin.source === 'cli') return t('executionRuns.details.launchOrigin.externalCli');
    if (origin.source === 'mcp') return t('executionRuns.details.launchOrigin.externalMcp');
    if (origin.source === 'action') return t('executionRuns.details.launchOrigin.externalAction');
    return t('executionRuns.details.launchOrigin.externalUnknown');
}

function formatElapsed(totalSeconds: number): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatClockTime(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** The running time, ticking in its own leaf so the header around it never re-renders per second. */
const RunElapsed = React.memo((props: Readonly<{ startedAtMs: number }>) => {
    const elapsed = useElapsedTime(props.startedAtMs);
    return <Text testID="session-run-header-elapsed" style={stylesheet.elapsed}>{formatElapsed(elapsed)}</Text>;
});

/**
 * The head of a Run page (agents lab RP1; unified-work lab `convo-C1` for the pane): the agent's
 * mark, the Run titled by what it is for, then one line of facts in words — status, how long it has
 * been running (or took), agent · model, permissions and where it came from — and ⋯ (lab MN/C1):
 * Cancel run, cancel the current response, copy the result, show it in the transcript, send it to the
 * lead Session, and the Run's details with its id last.
 */
export const SessionExecutionRunInfoCard = React.memo((props: Readonly<{
    run: ExecutionRunPublicState;
    hostSessionId?: string | null;
    daemonProcessLine?: string | null;
    /** The title of the conversation this Run was started from, when known. */
    originTitle?: string | null;
    stopAction?: Readonly<{ stopping: boolean; onStop: () => void }> | null;
    cancelResponseAction?: Readonly<{ pending: boolean; onCancel: () => void }> | null;
    /** The Run's result as text, when it has one to copy. */
    copyResultText?: string | null;
    /** Jumps the session transcript to this Run, when its place there is known. */
    onShowInTranscript?: (() => void) | null;
    /** Hands the finished result to the lead Session (⋯ → Send to …). */
    sendToSession?: Readonly<{ sessionTitle: string; onSend: (resultText: string) => void }> | null;
    /**
     * What the Run is waiting on a person for, from the roster's canonical attention (the only owner
     * that observes pending prompts). Replaces the status while present — the agent is not working.
     */
    attention?: SessionAgentActivityAttentionPresentation | null;
}>) => {
    const styles = stylesheet;
    const status = readExecutionRunAgentActivityStatus(props.run.status);
    const attention = props.attention ?? null;
    const statusPresentation = attention ?? resolveAgentActivityStatusPresentation(status);
    const running = status === 'running';
    const agentId = resolveAgentId(props.run);
    const originLabel = resolveLaunchOriginLabel(props.run, props.hostSessionId ?? null, props.originTitle ?? null);
    const modelId = props.run.requestedConfiguration?.modelId?.trim() || null;
    const agentLabel = resolveExecutionRunBackendLabel(props.run.backendTarget);
    const agentAndModel = [agentLabel, modelId].filter((part): part is string => Boolean(part)).join(' · ') || null;
    const permissionLabel = resolvePermissionLabel(props.run, agentId);
    // `> 0`, not `typeof === 'number'`: an unrecorded start or finish arrives as 0, and a time or a
    // duration made from it would be presented as though it were a fact (D-8).
    const startedAtMs = typeof props.run.startedAtMs === 'number' && props.run.startedAtMs > 0 ? props.run.startedAtMs : null;
    const finishedAtMs = typeof props.run.finishedAtMs === 'number' && props.run.finishedAtMs > 0 ? props.run.finishedAtMs : null;
    const tookSeconds = !running && startedAtMs !== null && finishedAtMs !== null && finishedAtMs >= startedAtMs
        ? Math.round((finishedAtMs - startedAtMs) / 1000)
        : null;

    const facts = React.useMemo<readonly ExecutionRunMenuFact[]>(() => {
        const next: ExecutionRunMenuFact[] = [];
        if (agentAndModel) next.push({ id: 'agent', label: t('runPage.menu.agent'), value: agentAndModel });
        if (permissionLabel) next.push({ id: 'permissions', label: t('runPage.menu.permissions'), value: permissionLabel });
        if (props.run.runClass === 'bounded' || props.run.runClass === 'long_lived') {
            next.push({
                id: 'kind',
                label: t('runPage.menu.kind'),
                value: props.run.runClass === 'bounded' ? t('runPage.menu.finishesOnItsOwn') : t('runPage.menu.staysOpen'),
            });
        }
        if (startedAtMs !== null) {
            next.push({
                id: 'started',
                label: t('runPage.menu.started'),
                value: tookSeconds !== null
                    ? `${formatClockTime(startedAtMs)} · ${formatElapsed(tookSeconds)}`
                    : formatClockTime(startedAtMs),
            });
        }
        if (props.daemonProcessLine) next.push({ id: 'process', label: t('runPage.menu.process'), value: props.daemonProcessLine });
        next.push({ id: 'run', label: t('runPage.menu.run'), value: props.run.runId });
        return next;
    }, [agentAndModel, permissionLabel, props.daemonProcessLine, props.run.runClass, props.run.runId, startedAtMs, tookSeconds]);

    const meta: DetailsTabHeaderMetaFact[] = [];
    if (agentAndModel) meta.push({ key: 'agent', text: agentAndModel });
    if (permissionLabel) meta.push({ key: 'permissions', text: permissionLabel });
    if (originLabel) meta.push({ key: 'origin', text: originLabel });
    return (
        <DetailsTabHeader
            testID="session-run-header"
            title={resolveExecutionRunTitle(props.run)}
            meta={meta}
            metaLeading={<View style={styles.live}>
                <ExecutionRunAgentMark testID="session-run-header-mark" agentId={agentId} size={20} />
                <StatusPill variant={statusPresentation.variant} label={statusPresentation.label} labelVariant={attention ? 'phrase' : 'micro'} hideDot />
                {running && !attention && startedAtMs !== null ? <RunElapsed startedAtMs={startedAtMs} /> : null}
                {tookSeconds !== null ? <Text testID="session-run-header-elapsed" style={styles.elapsed}>{formatElapsed(tookSeconds)}</Text> : null}
            </View>}
            menu={<ExecutionRunActionsMenu
                    cancelRun={props.stopAction ? { pending: props.stopAction.stopping, onCancel: props.stopAction.onStop } : null}
                    cancelResponse={props.cancelResponseAction ? {
                        pending: props.cancelResponseAction.pending,
                        onCancel: props.cancelResponseAction.onCancel,
                    } : null}
                    copyResultText={props.copyResultText}
                    resultPending={running}
                    onShowInTranscript={props.onShowInTranscript}
                    sendToSession={props.sendToSession ?? null}
                    facts={facts}
            />}
        />
    );
});
