import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => left === right,
    resolveServerProfileForPortableIdentity: (serverIdentityId: string) => serverIdentityId === 'stable-home-h'
        ? {
            kind: 'resolved' as const,
            serverIdentityId,
            profile: { id: 'profile-decider-b', serverIdentityId },
        }
        : { kind: 'missing' as const, serverIdentityId },
}));

import {
    isApprovalExecutionOriginCurrentForAccountContext,
} from './defaultActionExecutor';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';

describe('approval execution-origin Account currentness', () => {
    it('accepts an immutable creator profile through the deciding profile for the same stable Home', () => {
        expect(isApprovalExecutionOriginCurrentForAccountContext({
            origin: {
                serverId: 'profile-creator-a',
                serverIdentityId: 'stable-home-h',
                accountId: 'account-1',
            },
            accountServerId: 'profile-decider-b',
            accountId: 'account-1',
        })).toBe(true);
    });

    it('rejects a different stable Home or Account', () => {
        expect(isApprovalExecutionOriginCurrentForAccountContext({
            origin: {
                serverId: 'profile-creator-a',
                serverIdentityId: 'stable-home-other',
                accountId: 'account-1',
            },
            accountServerId: 'profile-decider-b',
            accountId: 'account-1',
        })).toBe(false);
        expect(isApprovalExecutionOriginCurrentForAccountContext({
            origin: {
                serverId: 'profile-creator-a',
                serverIdentityId: 'stable-home-h',
                accountId: 'account-other',
            },
            accountServerId: 'profile-decider-b',
            accountId: 'account-1',
        })).toBe(false);
    });

    it('treats a present stable Home identity as authoritative even when local profile ids match', () => {
        expect(isApprovalExecutionOriginCurrentForAccountContext({
            origin: {
                serverId: 'profile-decider-b',
                serverIdentityId: 'stable-home-other',
                accountId: 'account-1',
            },
            accountServerId: 'profile-decider-b',
            accountId: 'account-1',
        })).toBe(false);
    });

    it('retains local-profile currentness only for legacy origins without a stable Home identity', () => {
        expect(isApprovalExecutionOriginCurrentForAccountContext({
            origin: { serverId: 'profile-decider-b', accountId: 'account-1' },
            accountServerId: 'profile-decider-b',
            accountId: 'account-1',
        })).toBe(true);
        expect(isApprovalExecutionOriginCurrentForAccountContext({
            origin: { serverId: 'profile-creator-a', accountId: 'account-1' },
            accountServerId: 'profile-decider-b',
            accountId: 'account-1',
        })).toBe(false);
    });

    it('routes a trusted-plugin Account approval to the approving app', () => {
        expect(resolveApprovalExecutor({
            v: 2,
            status: 'approved',
            createdAtMs: 1,
            updatedAtMs: 2,
            createdBy: { surface: 'system', pluginId: 'acme.reviewer', contributionLocalId: 'review' },
            executionOriginV1: {
                v: 1,
                authority: 'account_automation',
                surface: 'plugin',
                caller: {
                    kind: 'plugin',
                    pluginId: 'acme.reviewer',
                    contributionLocalId: 'review',
                    sourceCustody: {
                        kind: 'managed',
                        immutableGenerationId: 'generation-1',
                        installSource: 'archive',
                    },
                },
                serverId: 'profile-creator-a',
                serverIdentityId: 'stable-home-h',
                accountId: 'account-1',
                machineId: 'machine-1',
                sessionId: 'session-1',
                actionId: 'session.title.set',
                requestId: 'request-1',
            },
            actionId: 'session.title.set',
            actionArgs: { sessionId: 'session-1', title: 'Reviewed title' },
            summary: 'Set title',
            decision: { kind: 'approve', decidedAtMs: 2 },
        })).toEqual({ kind: 'app', placement: 'account' });
    });
});
