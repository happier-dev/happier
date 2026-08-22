import { describe, expect, it } from 'vitest';

import {
    updateMetadataWithExternalSessionFollowPolicy,
    updateMetadataWithExternalSessionFollowStatus,
    updateMetadataWithExternalSessionObservedProgress,
} from './externalSessionBackgroundFollowMetadata';

describe('externalSessionBackgroundFollowMetadata', () => {
    it('writes follow lifecycle truth through the canonical immutable link merge only', () => {
        const metadata = {
            active: true,
            thinking: true,
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                linkedAtMs: 1,
            },
        };

        const updated = updateMetadataWithExternalSessionFollowStatus(metadata as never, {
            followStatusV1: {
                v: 1,
                status: 'error',
                reason: 'lease_acquire_failed',
                updatedAtMs: 100,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_lease_acquire_failed',
                retryable: true,
                observedAtMs: 100,
            },
            expectedLinkGeneration: '1',
        } as Parameters<typeof updateMetadataWithExternalSessionFollowStatus>[1] & {
            expectedLinkGeneration: string;
        });

        expect(updated).toMatchObject({
            active: true,
            thinking: true,
            externalSessionV1: {
                agentId: 'claude',
                followStatusV1: {
                    v: 1,
                    status: 'error',
                    reason: 'lease_acquire_failed',
                    updatedAtMs: 100,
                },
                lastFollowIssueV1: {
                    v: 1,
                    code: 'follow_lease_acquire_failed',
                    retryable: true,
                    observedAtMs: 100,
                },
            },
        });
        // The canonical merge owner emits only `externalSessionV1`; it strips the
        // released mirror rather than dual-writing it.
        expect(updated).not.toHaveProperty('directSessionV1');
    });

    it('rejects a stale follow-status generation without mutating canonical or rollback metadata', () => {
        const canonical = {
            v: 1,
            agentId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
            linkedAtMs: 2,
            followStatusV1: {
                v: 1,
                status: 'active',
                reason: 'viewer_attached',
                updatedAtMs: 90,
            },
        } as const;
        const metadata = {
            externalSessionV1: canonical,
            directSessionV1: {
                providerId: canonical.agentId,
                v: canonical.v,
                machineId: canonical.machineId,
                remoteSessionId: canonical.remoteSessionId,
                source: canonical.source,
                linkedAtMs: canonical.linkedAtMs,
                followStatusV1: canonical.followStatusV1,
            },
        };
        const before = structuredClone(metadata);

        expect(() => updateMetadataWithExternalSessionFollowStatus(
            metadata as never,
            {
                followStatusV1: {
                    v: 1,
                    status: 'error',
                    reason: 'lease_release_failed',
                    updatedAtMs: 100,
                },
                expectedLinkGeneration: '1',
            } as Parameters<typeof updateMetadataWithExternalSessionFollowStatus>[1] & {
                expectedLinkGeneration: string;
            },
        )).toThrow('linked_session_identity_mismatch');
        expect(metadata).toEqual(before);
    });

    it('rejects canonical and rollback disagreement even when the expected generation matches canonical', () => {
        const metadata = {
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                linkedAtMs: 2,
            },
            directSessionV1: {
                v: 1,
                providerId: 'claude',
                machineId: 'machine-1',
                remoteSessionId: 'rollback-disagrees',
                source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
                linkedAtMs: 2,
            },
        };
        const before = structuredClone(metadata);

        expect(() => updateMetadataWithExternalSessionFollowStatus(
            metadata as never,
            {
                followStatusV1: {
                    v: 1,
                    status: 'active',
                    reason: 'viewer_attached',
                    updatedAtMs: 100,
                },
                expectedLinkGeneration: '2',
            } as Parameters<typeof updateMetadataWithExternalSessionFollowStatus>[1] & {
                expectedLinkGeneration: string;
            },
        )).toThrow('linked_session_identity_mismatch');
        expect(metadata).toEqual(before);
    });

    it('refuses a follow-policy write when canonical and rollback metadata disagree', () => {
        const shared = {
            v: 1,
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
            linkedAtMs: 1,
        } as const;
        const metadata = {
            externalSessionV1: {
                ...shared,
                agentId: 'claude',
            },
            directSessionV1: {
                ...shared,
                providerId: 'claude',
                remoteSessionId: 'different-remote',
            },
        };

        expect(() => updateMetadataWithExternalSessionFollowPolicy(
            metadata as never,
            {
                policy: 'background_follow',
                updatedAtMs: 100,
                expectedLinkGeneration: '1',
            },
        )).toThrow('linked_session_reconciliation_required');
    });

    it('refuses to apply an admitted follow-policy write after the link generation changes', () => {
        const metadata = {
            externalSessionV1: {
                v: 1,
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: {
                    kind: 'opencodeServer',
                    directory: '/tmp/relinked',
                },
                linkedAtMs: 2,
            },
        };

        expect(() => updateMetadataWithExternalSessionFollowPolicy(
            metadata as never,
            {
                policy: 'background_follow',
                updatedAtMs: 100,
                expectedLinkGeneration: '1',
            },
        )).toThrow('linked_session_identity_mismatch');
    });

    it('refuses to silently complete an admitted follow-policy write after unlink', () => {
        expect(() => updateMetadataWithExternalSessionFollowPolicy(
            {} as never,
            {
                policy: 'background_follow',
                updatedAtMs: 100,
                expectedLinkGeneration: '1',
            },
        )).toThrow('linked_session_identity_mismatch');
    });

    it('refuses observed progress from a retired link generation', () => {
        const metadata = {
            externalSessionV1: {
                v: 1,
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: {
                    kind: 'opencodeServer',
                    directory: '/tmp/relinked',
                },
                linkedAtMs: 2,
            },
        };

        expect(() => updateMetadataWithExternalSessionObservedProgress(
            metadata as never,
            {
                observedProgress: {
                    token: 'stale-progress',
                    atMs: 100,
                },
                expectedLinkGeneration: '1',
            },
        )).toThrow('linked_session_identity_mismatch');
    });

    it('keeps observed progress ephemeral for a hosted projection without a persisted link', () => {
        const metadata = { flavor: 'codex' };

        expect(updateMetadataWithExternalSessionObservedProgress(
            metadata as never,
            {
                observedProgress: {
                    token: 'hosted-progress',
                    atMs: 100,
                },
                expectedLinkGeneration: 'session-hosted',
            },
        )).toBe(metadata);
    });
});
