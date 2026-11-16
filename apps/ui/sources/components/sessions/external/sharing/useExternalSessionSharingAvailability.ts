import React, { useCallback, useRef } from 'react';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import type { SharingAuthoritySession } from '@/sync/domains/social/sessionSharingMutationAuthority';
import { useIsMachineListSettled, useServerScopedMachine } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { readExternalSessionOperationPresentationFromMetadata } from '@/components/sessions/transcript/items/externalSessionOperationMetadata';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { useExternalSessionOperationOwnerHydration } from '@/components/sessions/transcript/items/useExternalSessionOperationOwnerHydration';
import { createExternalSessionTranscriptLiveSourceKeyFromLink, readExternalSessionTranscriptStorageState, resolveExternalSessionTranscriptAuthorityState } from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { resolveExternalSessionSharingPresentation } from '@/components/sessions/sharing/externalSessionSharingPresentation';
import { useSessionListRuntimeNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { t } from '@/text';
import { getRandomBytes } from 'expo-crypto';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { HappyError } from '@/utils/errors/errors';
import { machineExternalSessionMaterializeStart, machineExternalSessionOperationResume } from '@/sync/ops/machineExternalSessions';
import { presentExternalSessionOperationActionError } from '@/components/sessions/external/progress/externalSessionOperationActionErrorPresentation';
import { presentExternalSessionOperationProgress, resolveExternalSessionOperationOriginAvailability } from '@/components/sessions/external/progress/externalSessionOperationProgressPresentation';

function createMaterializeIdempotencyKey(): string {
    return Array.from(getRandomBytes(16))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function useExternalSessionSharingAvailability({ serverId, sessionId, session, accountScopeKey }: Readonly<{
    serverId: string;
    sessionId: string;
    session: SharingAuthoritySession | null;
    accountScopeKey: string | null;
}>) {
    const presentationActiveSignal = useLayoutPresentationSignal();
    const requestControllerRef = useRef<AbortController | null>(null);
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const externalSessionLink = React.useMemo(
        () => readExternalSessionLink(ownerMetadata),
        [ownerMetadata],
    );
    const sourceKey = externalSessionLink ? createExternalSessionTranscriptLiveSourceKeyFromLink(externalSessionLink) : null;
    React.useEffect(() => {
        // Presentation only starts and stops this work: a subscription, so a show/hide renders nothing here.
        const start = (presentationActive: boolean): (() => void) | void => {
            const controller = new AbortController();
            requestControllerRef.current = controller;
            const retirement = captureActiveServerAccountScopeCurrentness().onRetire(() => controller.abort());
            if (!presentationActive) controller.abort();
            return () => { controller.abort(); retirement.dispose(); };
        };
        let current = presentationActiveSignal.get();
        let stop = start(current);
        const unsubscribe = presentationActiveSignal.subscribe(() => {
            if (presentationActiveSignal.get() === current) return;
            current = presentationActiveSignal.get();
            stop?.();
            stop = start(current);
        });
        return () => { unsubscribe(); stop?.(); };
    }, [accountScopeKey, serverId, sessionId, sourceKey, presentationActiveSignal]);
    const machineScopeServerId = serverId;
    // Only this Home's settled fact: another Machine's row publication is not an input here.
    const machineScopeSettled = useIsMachineListSettled(machineScopeServerId);
    const machine = useServerScopedMachine(
        machineScopeServerId,
        externalSessionLink?.machineId ?? '',
    );
    const operationPresentation = React.useMemo(
        () => readExternalSessionOperationPresentationFromMetadata(session?.metadata),
        [session?.metadata],
    );
    const operationMachineId = React.useMemo(
        () => resolveSessionMachineId(ownerMetadata),
        [ownerMetadata],
    );
    const operationMachine = useServerScopedMachine(
        machineScopeServerId,
        operationMachineId ?? '',
    );
    const [sourcePresence, operationPresence] = useMachinePresenceSummaries(machineScopeServerId, [
        externalSessionLink?.machineId ?? '', operationMachineId ?? '',
    ]);
    const sourceMachineReachability = !machineScopeSettled || machine === null || sourcePresence?.reachability === 'unknown'
        ? null
        : sourcePresence?.reachability === 'reachable';
    const operationMachineReachable = operationPresence?.reachability === 'reachable';
    const isExactOwner = session?.access?.role === 'owner';
    const operationOwnerHydration = useExternalSessionOperationOwnerHydration({
        isExactOwner,
        machineId: operationMachineId,
        machineOnline: machineScopeSettled
            && operationMachine !== null
            && operationMachineReachable,
        ownerScopeKey: accountScopeKey,
        presentation: operationPresentation,
        serverId: machineScopeServerId,
        sessionId,
    });
    const transcriptAuthorityState = resolveExternalSessionTranscriptAuthorityState({
        linked: externalSessionLink !== null,
        agentReachable: externalSessionLink === null
            ? false
            : sourceMachineReachability,
        liveSourceKey: sourceKey,
        currentStorageState: readExternalSessionTranscriptStorageState(session?.currentStorageState, externalSessionLink !== null),
        acceptedThroughServerSeq: session?.acceptedThroughServerSeq ?? null,
        publishedThroughServerSeq: session?.publishedThroughServerSeq ?? null,
        materializedThroughSourceAt: session?.materializedThroughSourceAt ?? null,
        transcriptShareable: session?.transcriptShareable ?? null,
        operationPresentation,
        operationProgress: operationOwnerHydration.progress,
    });
    const sharingPresentation = resolveExternalSessionSharingPresentation({
        machineName: getMachineDisplayName(machine) ?? externalSessionLink?.machineId ?? null,
        sharing: transcriptAuthorityState.sharing,
    });
    const sharingPresentationNowMs = useSessionListRuntimeNowMs(
        sharingPresentation.state === 'shared_snapshot_stale',
    );
    const sourceMachineOnline = sourceMachineReachability === true;
    const sourceMachineUnavailableReason = sourceMachineOnline
        ? null
        : sourceMachineReachability === false
            ? t('externalSessions.sharingSourceMachineOffline')
            : machineScopeSettled && machineScopeServerId !== null && machine === null
                ? t('externalSessions.sharingSourceMachineMissing')
                : t('externalSessions.sharingActionAwaitingAvailability');
    const updateSharedCopySubtitle = sourceMachineUnavailableReason
        ?? t('externalSessions.sharingUpdateSharedCopyDescription');
    const materializeIdempotencyKeyRef = useRef<string | null>(null);
    const [materializeInFlight, startMaterialization] = useHappyAction(
        useCallback(async () => {
            const signal = requestControllerRef.current?.signal;
            if (!signal || signal.aborted) return;
            if (!externalSessionLink) {
                throw new HappyError(t('externalSessions.sharingTranscriptUnavailable'), false);
            }
            const idempotencyKey = materializeIdempotencyKeyRef.current
                ?? createMaterializeIdempotencyKey();
            materializeIdempotencyKeyRef.current = idempotencyKey;
            const result = await machineExternalSessionMaterializeStart({
                machineId: externalSessionLink.machineId,
                request: {
                    v: 1,
                    idempotencyKey,
                    sessionId,
                    plan: 'materialize',
                    targetStorageMode: 'external-linked',
                    targetRuntimeMode: null,
                },
            }, { serverId, signal }).catch((error: unknown) => {
                if (signal.aborted) return null;
                throw error;
            });
            if (!result || signal.aborted) return;
            if (!result.ok) {
                throw new HappyError(
                    t(presentExternalSessionOperationActionError(result.error.code)),
                    false,
                );
            }
            materializeIdempotencyKeyRef.current = null;
        }, [externalSessionLink, serverId, sessionId]),
    );
    const operationProgressPresentation = React.useMemo(() => (
        operationOwnerHydration.progress
            ? presentExternalSessionOperationProgress(operationOwnerHydration.progress, {
                observationContext: 'hydrated',
                originAvailability: resolveExternalSessionOperationOriginAvailability({
                    machineStatusKnown: operationMachine !== null && operationPresence?.reachability !== 'unknown',
                    machineOnline: operationMachine !== null && operationMachineReachable,
                }),
            })
            : null
    ), [operationMachine, operationMachineReachable, operationPresence?.reachability, operationOwnerHydration.progress]);
    const canResumePartialImport = sharingPresentation.action === 'resume_awaiting_action_owner'
        && operationPresentation !== null
        && operationOwnerHydration.progress !== null
        && operationOwnerHydration.progress.operationId === operationPresentation.operationId
        && operationOwnerHydration.progress.revision === operationPresentation.revision
        && operationProgressPresentation?.actions.some(
            (action) => action.kind === 'resume' && action.enabled,
        ) === true
        && operationMachineId !== null;
    const [resumeInFlight, resumePartialImport] = useHappyAction(
        useCallback(async () => {
            const signal = requestControllerRef.current?.signal;
            if (!signal || signal.aborted) return;
            const progress = operationOwnerHydration.progress;
            if (!canResumePartialImport || !progress || !operationMachineId) {
                throw new HappyError(
                    t('externalSessions.operationActionErrorUnavailable'),
                    false,
                );
            }
            const result = await machineExternalSessionOperationResume({
                machineId: operationMachineId,
                sessionId,
                operationId: progress.operationId,
                revision: progress.revision,
            }, { serverId, signal }).catch((error: unknown) => {
                if (signal.aborted) return null;
                throw error;
            });
            if (!result || signal.aborted) return;
            if (!result.ok) {
                throw new HappyError(
                    t(presentExternalSessionOperationActionError(result.error.code)),
                    false,
                );
            }
            if (result.progress.operationId !== progress.operationId) {
                throw new HappyError(
                    t('externalSessions.operationActionErrorUnavailable'),
                    false,
                );
            }
            operationOwnerHydration.onActionResult(result.progress);
        }, [
            canResumePartialImport,
            operationMachineId,
            operationOwnerHydration,
            serverId,
            sessionId,
        ]),
    );

    return {
        sharingPresentation, sharingPresentationNowMs, sourceMachineOnline,
        sourceMachineUnavailableReason, updateSharedCopySubtitle,
        materializeInFlight, startMaterialization, canResumePartialImport,
        resumeInFlight, resumePartialImport,
    };
}

export type ExternalSessionSharingAvailability = ReturnType<typeof useExternalSessionSharingAvailability>;
