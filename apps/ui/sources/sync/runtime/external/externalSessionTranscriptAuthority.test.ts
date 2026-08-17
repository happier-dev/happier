import { describe, expect, it } from 'vitest';
import {
    projectExternalSessionOperationSharedPresentationV1,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol';

import {
    createExternalSessionTranscriptLeaseScopeKeyFromLink,
    createExternalSessionTranscriptLiveSourceKey,
    createExternalSessionTranscriptLiveSourceKeyFromLink,
    externalSessionTranscriptAuthorityKey,
    resolveExternalSessionTranscriptAuthority,
    resolveExternalSessionTranscriptAuthorityState,
} from './externalSessionTranscriptAuthority';

const liveSourceKey = 'live-source-key';
const acceptedPartialOperationProgress = {
    v: 1,
    operationId: 'operation-1',
    revision: 4,
    request: {
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
    },
    status: 'awaiting_user_resume',
    phase: 'importing',
    timeline: ['validating', 'staging', 'importing', 'publishing'],
    updatedAtMs: 1_700_000_000_000,
    priorStableStorage: { state: 'machine_only' },
    currentStorageState: 'server_partial',
    checkpoint: {
        sourcePagesRead: 1,
        stagedItemCount: 8,
        importedItemCount: 8,
        requiredItemFailures: {
            total: 0,
            record: 0,
            media: 0,
            conversion: 0,
            diagnosticsTruncated: false,
        },
        acceptedThroughServerSeq: 8,
    },
    fence: {
        kind: 'initial_server_partial',
        acceptedThroughServerSeq: 8,
    },
    retryTargetPhase: 'importing',
} satisfies ExternalSessionOperationProgressV1;
const acceptedPartialOperationPresentation =
    projectExternalSessionOperationSharedPresentationV1(
        acceptedPartialOperationProgress,
    );

describe('resolveExternalSessionTranscriptAuthority', () => {
    it('projects sharing from the same canonical authority decision without changing the live transcript source', () => {
        const common = {
            linked: true,
            agentReachable: true,
            liveSourceKey,
            acceptedThroughServerSeq: null,
            transcriptShareable: null,
            operationPresentation: null,
            operationProgress: null,
        } as const;

        expect(resolveExternalSessionTranscriptAuthorityState({
            ...common,
            currentStorageState: 'machine_only',
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
        })).toEqual({
            authority: { kind: 'live_agent', sourceKey: liveSourceKey },
            sharing: { kind: 'requires_persisted_import' },
        });
        expect(resolveExternalSessionTranscriptAuthorityState({
            ...common,
            currentStorageState: 'snapshot_complete',
            publishedThroughServerSeq: 12,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: true,
        })).toEqual({
            authority: { kind: 'live_agent', sourceKey: liveSourceKey },
            sharing: {
                kind: 'published_snapshot',
                materializedThroughSourceAt: 1_700_000_000_000,
            },
        });
        expect(resolveExternalSessionTranscriptAuthorityState({
            ...common,
            currentStorageState: 'snapshot_complete',
            publishedThroughServerSeq: 12,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: false,
        })).toEqual({
            authority: { kind: 'live_agent', sourceKey: liveSourceKey },
            sharing: { kind: 'unavailable', reason: 'invalid_publication' },
        });
        expect(resolveExternalSessionTranscriptAuthorityState({
            ...common,
            currentStorageState: 'snapshot_complete',
            publishedThroughServerSeq: 12,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: null,
        })).toEqual({
            authority: { kind: 'live_agent', sourceKey: liveSourceKey },
            sharing: { kind: 'unavailable', reason: 'invalid_publication' },
        });
    });

    it('prefers the live Agent source for every linked non-hosted state while reachable', () => {
        for (const currentStorageState of ['machine_only', 'server_partial', 'snapshot_complete'] as const) {
            expect(resolveExternalSessionTranscriptAuthority({
                linked: true,
                agentReachable: true,
                liveSourceKey,
                currentStorageState,
                acceptedThroughServerSeq: currentStorageState === 'server_partial' ? 8 : null,
                publishedThroughServerSeq: currentStorageState === 'snapshot_complete' ? 12 : null,
                materializedThroughSourceAt: currentStorageState === 'snapshot_complete' ? 1_700_000_000_000 : null,
                transcriptShareable: currentStorageState === 'snapshot_complete' ? true : null,
                operationPresentation: null,
                operationProgress: null,
            })).toEqual({ kind: 'live_agent', sourceKey: liveSourceKey });
        }
    });

    it('uses only a complete published snapshot while its linked Agent is offline', () => {
        expect(resolveExternalSessionTranscriptAuthority({
            linked: true,
            agentReachable: false,
            liveSourceKey,
            currentStorageState: 'snapshot_complete',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 12,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: true,
            operationPresentation: null,
            operationProgress: null,
        })).toEqual({
            kind: 'server_snapshot',
            maxServerSeq: 12,
            materializedThroughSourceAt: 1_700_000_000_000,
        });

        expect(resolveExternalSessionTranscriptAuthority({
            linked: true,
            agentReachable: false,
            liveSourceKey,
            currentStorageState: 'snapshot_complete',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: false,
            operationPresentation: null,
            operationProgress: null,
        })).toEqual({ kind: 'unavailable', reason: 'invalid_publication' });
    });

    it('preserves unknown Agent reachability as a live presentation input', () => {
        expect(resolveExternalSessionTranscriptAuthority({
            linked: true,
            agentReachable: null,
            liveSourceKey,
            currentStorageState: 'snapshot_complete',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 12,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: true,
            operationPresentation: null,
            operationProgress: null,
        })).toEqual({ kind: 'live_agent', sourceKey: liveSourceKey });
    });

    it('selects live → published snapshot → live across an offline round trip', () => {
        const stablePublication = {
            linked: true,
            currentStorageState: 'snapshot_complete' as const,
            liveSourceKey,
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: 12,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: true,
            operationPresentation: null,
            operationProgress: null,
        };
        expect([
            resolveExternalSessionTranscriptAuthority({ ...stablePublication, agentReachable: true }).kind,
            resolveExternalSessionTranscriptAuthority({ ...stablePublication, agentReachable: false }).kind,
            resolveExternalSessionTranscriptAuthority({ ...stablePublication, agentReachable: true }).kind,
        ]).toEqual(['live_agent', 'server_snapshot', 'live_agent']);
    });

    it('serves accepted partial rows only when pushed operation progress matches the server bound', () => {
        const input = {
            linked: true,
            agentReachable: false,
            liveSourceKey,
            currentStorageState: 'server_partial' as const,
            acceptedThroughServerSeq: 8,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
            transcriptShareable: false,
        };

        expect(resolveExternalSessionTranscriptAuthority({
            ...input,
            operationPresentation: acceptedPartialOperationPresentation,
            operationProgress: null,
        })).toEqual({ kind: 'unavailable', reason: 'initial_partial_not_permitted' });
        expect(resolveExternalSessionTranscriptAuthority({
            ...input,
            operationPresentation: acceptedPartialOperationPresentation,
            operationProgress: acceptedPartialOperationProgress,
        })).toEqual({
            kind: 'server_partial',
            maxServerSeq: 8,
            operationKey: JSON.stringify([
                1,
                'operation-1',
                4,
                'materialize',
                'awaiting_user_resume',
                'importing',
            ]),
        });
        expect(resolveExternalSessionTranscriptAuthority({
            ...input,
            operationPresentation: {
                ...acceptedPartialOperationPresentation,
                revision: acceptedPartialOperationPresentation.revision + 1,
            },
            operationProgress: acceptedPartialOperationProgress,
        })).toEqual({ kind: 'unavailable', reason: 'initial_partial_not_permitted' });
        expect(resolveExternalSessionTranscriptAuthority({
            ...input,
            operationPresentation: acceptedPartialOperationPresentation,
            operationProgress: {
                ...acceptedPartialOperationProgress,
                checkpoint: {
                    ...acceptedPartialOperationProgress.checkpoint,
                    acceptedThroughServerSeq: 7,
                },
                fence: {
                    kind: 'initial_server_partial',
                    acceptedThroughServerSeq: 7,
                },
            },
        })).toEqual({ kind: 'unavailable', reason: 'initial_partial_not_permitted' });
    });

    it('switches converted sessions to hosted authority even while link metadata remains', () => {
        expect(resolveExternalSessionTranscriptAuthority({
            linked: true,
            agentReachable: true,
            liveSourceKey,
            currentStorageState: 'hosted',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
            transcriptShareable: null,
            operationPresentation: null,
            operationProgress: null,
        })).toEqual({ kind: 'hosted' });
    });

    it('fails closed for legacy or inconsistent states', () => {
        expect(resolveExternalSessionTranscriptAuthority({
            linked: true,
            agentReachable: false,
            liveSourceKey,
            currentStorageState: 'legacy_external_unknown',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
            transcriptShareable: false,
            operationPresentation: null,
            operationProgress: null,
        })).toEqual({ kind: 'unavailable', reason: 'legacy_external_unknown' });

        expect(resolveExternalSessionTranscriptAuthority({
            linked: false,
            agentReachable: false,
            liveSourceKey: null,
            currentStorageState: 'machine_only',
            acceptedThroughServerSeq: null,
            publishedThroughServerSeq: null,
            materializedThroughSourceAt: null,
            transcriptShareable: false,
            operationPresentation: null,
            operationProgress: null,
        })).toEqual({ kind: 'unavailable', reason: 'invalid_authority_state' });
    });

    it('binds live, partial-operation, and snapshot cache identities to their authority generations', () => {
        const firstLiveKey = createExternalSessionTranscriptLiveSourceKey({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'thread-1',
            linkGeneration: '1',
            pluginId: 'happier.codex',
            pluginAgentLocalId: 'codex',
            sourceKind: 'codexHome',
            sourceContractVersion: 1,
        });
        const nextLiveKey = createExternalSessionTranscriptLiveSourceKey({
            machineId: 'machine-1',
            agentId: 'codex',
            remoteSessionId: 'thread-2',
            linkGeneration: '2',
            pluginId: 'happier.codex',
            pluginAgentLocalId: 'codex',
            sourceKind: 'codexHome',
            sourceContractVersion: 1,
        });
        expect(firstLiveKey).not.toBeNull();
        expect(nextLiveKey).not.toBe(firstLiveKey);
        expect(externalSessionTranscriptAuthorityKey({
            kind: 'live_agent',
            sourceKey: firstLiveKey!,
        })).not.toBe(externalSessionTranscriptAuthorityKey({
            kind: 'live_agent',
            sourceKey: nextLiveKey!,
        }));
        expect(externalSessionTranscriptAuthorityKey({
            kind: 'server_snapshot',
            maxServerSeq: 8,
            materializedThroughSourceAt: 100,
        })).not.toBe(externalSessionTranscriptAuthorityKey({
            kind: 'server_snapshot',
            maxServerSeq: 8,
            materializedThroughSourceAt: 101,
        }));
        expect(externalSessionTranscriptAuthorityKey({
            kind: 'server_partial',
            maxServerSeq: 8,
            operationKey: 'operation-1:revision-4',
        })).not.toBe(externalSessionTranscriptAuthorityKey({
            kind: 'server_partial',
            maxServerSeq: 8,
            operationKey: 'operation-1:revision-6',
        }));
    });

    it('binds live cache identity to the complete canonical source and link data', () => {
        const baseIdentity = {
            machineId: 'machine-1',
            agentId: 'claude',
            remoteSessionId: 'native-thread-1',
            linkGeneration: '17',
            pluginId: 'happier.claude',
            pluginAgentLocalId: 'claude',
            sourceKind: 'claudeConfig',
            sourceContractVersion: 1,
        } as const;

        const first = createExternalSessionTranscriptLiveSourceKey({
            ...baseIdentity,
            sourceIdentity: { kind: 'claudeConfig', projectId: 'project-a' },
            linkData: { projectId: 'project-a', workspace: { root: '/a' } },
        });
        const relinkedSource = createExternalSessionTranscriptLiveSourceKey({
            ...baseIdentity,
            sourceIdentity: { kind: 'claudeConfig', projectId: 'project-b' },
            linkData: { projectId: 'project-a', workspace: { root: '/a' } },
        });
        const relinkedData = createExternalSessionTranscriptLiveSourceKey({
            ...baseIdentity,
            sourceIdentity: { projectId: 'project-a', kind: 'claudeConfig' },
            linkData: { workspace: { root: '/b' }, projectId: 'project-a' },
        });
        const sameIdentityDifferentObjectOrder = createExternalSessionTranscriptLiveSourceKey({
            ...baseIdentity,
            sourceIdentity: { projectId: 'project-a', kind: 'claudeConfig' },
            linkData: { workspace: { root: '/a' }, projectId: 'project-a' },
        });

        expect(relinkedSource).not.toBe(first);
        expect(relinkedData).not.toBe(first);
        expect(sameIdentityDifferentObjectOrder).toBe(first);
    });

    it('fails closed when linked metadata has no transcript-authority generation', () => {
        expect(createExternalSessionTranscriptLiveSourceKeyFromLink({
            machineId: 'machine-legacy',
            agentId: 'claude',
            remoteSessionId: 'native-thread-1',
            source: {
                kind: 'claudeConfig',
            },
        })).toBeNull();
    });

    it('keeps a legacy transcript lease scope stable across policy changes but replaces it for source changes', () => {
        const baseLink = {
            machineId: 'machine-legacy',
            agentId: 'opencode',
            remoteSessionId: 'native-thread-1',
            source: {
                kind: 'opencodeServer',
                directory: '/workspace/a',
            },
        } as const;
        const firstLink = {
            ...baseLink,
            followPolicyV1: {
                v: 1,
                policy: 'foreground_only',
                updatedAtMs: 1,
            },
        } as const;
        const policyChangedLink = {
            ...baseLink,
            followPolicyV1: {
                v: 1,
                policy: 'background_follow',
                updatedAtMs: 2,
            },
        } as const;
        const sourceChangedLink = {
            ...baseLink,
            source: {
                ...baseLink.source,
                directory: '/workspace/b',
            },
        } as const;
        const first = createExternalSessionTranscriptLeaseScopeKeyFromLink(firstLink);
        const policyChanged = createExternalSessionTranscriptLeaseScopeKeyFromLink(policyChangedLink);
        const sourceChanged = createExternalSessionTranscriptLeaseScopeKeyFromLink(sourceChangedLink);

        expect(policyChanged).toBe(first);
        expect(sourceChanged).not.toBe(first);
    });

    it('fails closed for a present but invalid transcript-authority generation', () => {
        expect(createExternalSessionTranscriptLeaseScopeKeyFromLink({
            machineId: 'machine-invalid',
            agentId: 'opencode',
            remoteSessionId: 'native-thread-1',
            linkedAtMs: -1,
            source: {
                kind: 'opencodeServer',
            },
        })).toBeNull();
    });
});
