import { describe, expect, it } from 'vitest';

import {
    updateMetadataWithExternalSessionFollowPolicy,
    updateMetadataWithExternalSessionFollowStatus,
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
            directSessionV1: {
                providerId: 'claude',
                followStatusV1: {
                    v: 1,
                    status: 'error',
                    reason: 'lease_acquire_failed',
                    updatedAtMs: 100,
                },
            },
        });
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
            { policy: 'background_follow', updatedAtMs: 100 },
        )).toThrow('linked_session_reconciliation_required');
    });
});
