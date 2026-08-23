import { configuration } from '@/configuration';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { createConnectedServiceForkLaunchContext } from '@/session/fork/connectedServiceForkLaunchContext';
import { logger } from '@/ui/logger';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';
import { buildForkSessionMetadata } from '@/session/fork/providerNativeForkDispatch';
import { applyAgentAuthoredSessionStateUpdatesToMetadata } from '@/agent/runtime/state/agentAuthoredSessionStateUpdates';

import type {
    ForkBackendResolution,
    ForkBridgeSurface,
    ForkInheritedOverrides,
    ForkLifecycleCredentials,
    ForkLifecycleMetadata,
    ForkLifecycleResult,
    ForkSpawnSession,
} from './forkLifecycleTypes';
import type { SessionLifecycleMachineDeps } from '../sessionLifecycleTypes';

type ReplaySummaryRunner = NonNullable<Parameters<typeof resolveReplaySeedDraft>[0]['summaryRunner']>;

export async function createReplayForkSession(params: Readonly<{
    credentials: ForkLifecycleCredentials;
    parentSessionId: string;
    parentMetadata: ForkLifecycleMetadata;
    directory: string;
    effectiveCutoffSeqInclusive: number;
    requestId?: string | null;
    spawnNonce: string;
    forkPointType: 'seq' | 'latest';
    replaySummaryRunner: ReplaySummaryRunner | null | undefined;
    replayMaxSeedChars: number | undefined;
    maxTextChars: number | undefined;
    forkBackendResolution: ForkBackendResolution;
    inheritedForkOverrides: ForkInheritedOverrides;
    forkSurface: ForkBridgeSurface;
    spawnSession: ForkSpawnSession;
    deps?: SessionLifecycleMachineDeps;
}>): Promise<ForkLifecycleResult> {
    const replayForkContinuation = params.forkSurface?.resolveReplayChildLaunch
        ? await params.forkSurface.resolveReplayChildLaunch({
            parentSessionId: params.parentSessionId,
            parentMetadata:
                buildForkSessionMetadata(params.parentMetadata),
            directory: params.directory,
            forkPoint: params.forkPointType === 'seq'
                ? { kind: 'message_seq', upToSeqInclusive: params.effectiveCutoffSeqInclusive }
                : { kind: 'latest' },
        })
        : null;
    const replayLaunchMetadata = applyAgentAuthoredSessionStateUpdatesToMetadata(
        {},
        replayForkContinuation?.sessionStateUpdates ?? [],
        'fork.replayLaunch.sessionStateUpdates',
    );
    const replayChildDirectory = replayForkContinuation?.directory ?? params.directory;
    const replayRuntimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(replayLaunchMetadata) ?? undefined;
    const connectedServiceForkLaunchContext = createConnectedServiceForkLaunchContext({
        inherited: params.inheritedForkOverrides,
    });
    const inheritedForkOverrides = connectedServiceForkLaunchContext.inherited;
    const recipeResult = await buildReplaySeededSpawnRecipe({
        credentials: params.credentials,
        cwd: params.directory,
        source: {
            sourceSessionId: params.parentSessionId,
            // "Latest" is resolved ONCE, by the fork lifecycle, and this is that
            // answer. Leaving the retrieval to re-resolve it made the child's
            // CONTENT and its recorded LINEAGE answer to two different reads of
            // the same live parent: a row committed between them entered the
            // seed while the boundary still named the admitted cutoff.
            forkPoint: { type: 'seq', upToSeqInclusive: params.effectiveCutoffSeqInclusive },
        },
        agentHintAgentId: params.forkBackendResolution.agentHintAgentId,
        // The fork lifecycle already admitted this exact cutoff; persisted
        // lineage must keep naming it rather than a retrieval-resolved one.
        lineageCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
        requestId: params.requestId,
        extraMetadata: {
            ...inheritedForkOverrides.metadata,
            ...params.forkBackendResolution.metadataOverlay,
            ...replayLaunchMetadata,
        },
        // No count bound: the fork seed is bounded by CHARACTERS. Passing the
        // page-size knob here as a message count is what capped the window at
        // 500 turns in front of a 120k-character budget.
        recentMessagesCount: null,
        maxSeedChars: typeof params.replayMaxSeedChars === 'number'
            ? params.replayMaxSeedChars
            : configuration.replaySeedMaxChars,
        candidateLimit: configuration.replaySeedCandidateLimit,
        ...(typeof params.maxTextChars === 'number' ? { maxTextChars: params.maxTextChars } : {}),
        summaryRunner: params.replaySummaryRunner ?? null,
        ...(params.deps?.runReplaySummaryForDialog
            ? { deps: { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog } }
            : {}),
    });
    if (!recipeResult.ok) {
        return {
            ok: false,
            errorCode: recipeResult.errorCode,
            errorMessage: recipeResult.errorMessage,
        };
    }
    const recipe = recipeResult.recipe;

    const parentMachineId = typeof params.parentMetadata.machineId === 'string'
        ? params.parentMetadata.machineId.trim()
        : '';

    try {
        // Row creation, create-or-rejoin settlement and orphan cleanup all
        // belong to the canonical creator. This branch contributes only the
        // fork's own retry identity and its inherited launch configuration.
        const created = await createSpawnedSession({
            credentials: params.credentials,
            directory: replayChildDirectory,
            backendTarget: params.forkBackendResolution.backendTargetV2,
            ...(parentMachineId ? { machineId: parentMachineId } : {}),
            approvedNewDirectoryCreation: true,
            spawnNonce: params.spawnNonce,
            replaySeededCreation: {
                tag: params.spawnNonce,
                flavor: params.forkBackendResolution.replayFlavor,
                metadata: recipe.metadata,
                sourceRecipe: {
                    sourceSessionId: params.parentSessionId,
                    cutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                },
            },
            connectedServiceChildLaunch: connectedServiceForkLaunchContext.childLaunch,
            directTransport: {
                spawn: async (request) => await params.spawnSession({
                    ...request,
                    backendTarget: params.forkBackendResolution.backendTargetV2,
                    ...(replayRuntimeDescriptorV1 ? { runtimeDescriptorV1: replayRuntimeDescriptorV1 } : {}),
                    ...(replayForkContinuation?.environmentVariables
                        ? { environmentVariables: { ...replayForkContinuation.environmentVariables } }
                        : {}),
                    ...inheritedForkOverrides.spawn,
                    // A rejoined child keeps the identity persisted by its
                    // first creation; the canonical creator supplies it on
                    // the request after authenticating that row.
                    ...(request.connectedServiceMaterializationIdentityV1
                        ? { connectedServiceMaterializationIdentityV1: request.connectedServiceMaterializationIdentityV1 }
                        : {}),
                } satisfies SpawnSessionOptions),
                resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
            },
        });

        if (created.sessionId === params.parentSessionId) {
            return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
        }
        return { ok: true, childSessionId: created.sessionId };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        const errorCode = error && typeof error === 'object'
            && typeof (error as { code?: unknown }).code === 'string'
            && (error as { code: string }).code.trim().length > 0
            ? (error as { code: string }).code
            : SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
        const errorMessage = error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Failed to create fork session';
        logger.debug('[API MACHINE] Failed to create fork session for replay', { errorCode, errorMessage });
        return { ok: false, errorCode, errorMessage };
    }
}
