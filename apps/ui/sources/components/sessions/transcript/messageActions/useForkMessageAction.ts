import * as React from 'react';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import type { TranscriptForkCommon } from '../transcriptSessionCommon';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveTranscriptMessageServerId } from '../source/resolveTranscriptMessageServerId';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { openSessionForkStrategyFlow } from '@/components/sessions/fork/openSessionForkStrategyFlow';

/** One launcher for the row and menu; the strategy modal owns execution/progress. */
export function useForkMessageAction(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    upToSeqInclusive: number;
    restoredDraftText: string | null;
    messageId: string;
    forkCommon: TranscriptForkCommon;
    isForkAllowed: () => boolean;
}>) {
    const source = useSessionTranscriptSource();
    return React.useCallback(() => {
        if (!props.isForkAllowed() || source.navigate === null) return;
        const forkSource = props.forkCommon.sessionForkSupportSource;
        const ownerMetadata = forkSource ? readSessionOwnerMetadataView(forkSource) : null;
        const reachableTarget = readMachineTargetForSession(props.serverId
            ? { serverId: props.serverId, sessionId: props.sessionId }
            : props.sessionId);
        const serverId = resolveTranscriptMessageServerId(props.sessionId, props.serverId, forkSource?.serverId);
        openSessionForkStrategyFlow({
            navigation: { push: (href) => source.navigate?.(String(href)) },
            sessionId: props.sessionId,
            forkSupportSource: forkSource,
            serverId,
            machineId: reachableTarget?.machineId ?? ownerMetadata?.machineId ?? null,
            forkPoint: { type: 'seq', upToSeqInclusive: props.upToSeqInclusive },
            settings: {
                sessionReplayEnabled: props.forkCommon.sessionReplayEnabled,
                sessionReplayMaxSeedChars: props.forkCommon.sessionReplayMaxSeedChars,
                sessionReplayStrategy: props.forkCommon.sessionReplayStrategy,
                sessionReplaySummaryRunnerV1: props.forkCommon.sessionReplaySummaryRunnerV1,
            },
            replayEnabled: props.forkCommon.sessionReplayEnabled,
            currentAgentCapabilities: props.forkCommon.currentAgentCapabilities,
            executionRunsEnabled: props.forkCommon.executionRunsEnabled,
            agentSwitchingEnabled: props.forkCommon.agentSwitchingEnabled,
            restoredDraftText: props.restoredDraftText,
            sourceMessageId: props.messageId,
            sourcePreview: props.restoredDraftText,
            writeForkInitialPrompt: true,
            navigateToSession: (sessionId, options) => source.navigate?.(buildScopedSessionRouteHref({
                sessionId, serverId: options?.serverId ?? serverId,
            })),
            navigateToNewSession: (route) => {
                const query = new URLSearchParams(route.params).toString();
                source.navigate?.(query ? `${route.pathname}?${query}` : route.pathname);
            },
        });
    }, [props.sessionId, props.serverId, props.upToSeqInclusive, props.restoredDraftText,
        props.messageId, props.forkCommon, props.isForkAllowed, source]);
}
