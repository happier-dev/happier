import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { TEAM_PRINCIPAL_ROLES_V1 } from '@happier-dev/protocol/teams';
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from './sessionRecipients';

describe('Session recipient transport bind budget', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('keeps every Session/share/Team/Group acquisition below the portable bind boundary without losing recipients', async () => {
        vi.stubEnv('HAPPIER_FEATURE_SHARING__SESSION_ENABLED', '1');
        const sessionIds = Array.from({ length: 1100 }, (_, index) => `session-${index}`);
        const acquisitions: Array<{ kind: string; ids: readonly string[] }> = [];
        const selected = (kind: string, input: { where: { id?: { in: readonly string[] }; sessionId?: { in: readonly string[] }; teamId?: { in: readonly string[] } } }) => {
            const ids = input.where.id?.in ?? input.where.sessionId?.in ?? input.where.teamId?.in ?? [];
            acquisitions.push({ kind, ids });
            return ids;
        };
        // The persistent database is the only substituted boundary; publication, feature and recipient logic stay real.
        const tx = {
            session: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Session', input).map(id => ({
                id, accountId: 'owner', seq: 0, currentStorageState: 'hosted', acceptedThroughServerSeq: null,
                materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null,
                account: { status: 'active' },
            })) },
            sessionShare: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Share', input)
                .map(sessionId => ({ sessionId, sharedWithUserId: 'direct' })) },
            sessionTeamGrant: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Team', input)
                .map(sessionId => ({ sessionId, teamId: `team-${sessionId}`, effectiveAt: new Date(1) })) },
            sessionGroupGrant: { findMany: async (input: Parameters<typeof selected>[1]) => selected('Group', input)
                .map(sessionId => ({ sessionId, teamGroupId: 'group-id', effectiveAt: new Date(1) })) },
            teamMembership: { findMany: async (input: Parameters<typeof selected>[1]) => selected('TeamMembership', input)
                .map(teamId => ({ teamId, accountId: 'team', sessionAccessStartsAt: new Date(0) })) },
            teamGroupMembership: { findMany: async () => [{ teamGroupId: 'group-id', teamMembership: { accountId: 'group' },
                sessionAccessStartsAt: new Date(0) }] },
        } as unknown as Tx;
        const result = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(tx, { sessionIds: ['', ...sessionIds, sessionIds[0]!] });
        expect(result.size).toBe(sessionIds.length);
        for (const id of sessionIds) expect(result.get(id)).toEqual(['direct', 'group', 'owner', 'team']);
        for (const kind of ['Session', 'Share', 'Team', 'Group']) {
            const reads = acquisitions.filter(read => read.kind === kind);
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.flatMap(read => read.ids)).toEqual(sessionIds);
            // Session/share/grant acquisitions retain their existing portable transport allowance.
            expect(Math.max(...reads.map(read => read.ids.length + 4))).toBeLessThanOrEqual(999);
        }
        const membershipReads = acquisitions.filter(read => read.kind === 'TeamMembership');
        expect(membershipReads.flatMap(read => read.ids)).toEqual(sessionIds.map(id => `team-${id}`));
        // Membership status, Account status and Prisma OFFSET accompany the canonical role bindings.
        const membershipFixedBindings = 3 + TEAM_PRINCIPAL_ROLES_V1.length;
        expect(Math.max(...membershipReads.map(read => read.ids.length + membershipFixedBindings))).toBeLessThanOrEqual(999);
    });
});
