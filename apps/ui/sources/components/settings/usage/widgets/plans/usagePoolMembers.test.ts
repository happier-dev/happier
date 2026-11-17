import { describe, expect, it } from 'vitest';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';

import { readUsagePoolMembers } from './UsagePoolOrder';
import type { UsagePlanPool } from './usagePlansModel';

const service = { pluginId: 'dev.happier.codex', localId: 'codex' };
const pool: UsagePlanPool = { key: 'pool', service, groupId: 'pool', accountKeys: [] };

describe('readUsagePoolMembers', () => {
    it.each([
        { activeAccountId: null, inUse: [] },
        { activeAccountId: 'current', inUse: ['current'] },
        { activeAccountId: 'preferred', inUse: ['preferred'] },
    ])('marks only the actual active account in use: $activeAccountId', ({ activeAccountId, inUse }) => {
        const candidate = (profileId: string, priority: number) => ({
            profileId, priority, createdAtMs: 1, enabled: true, leastLimitedScore: null,
        });
        // A selection read proposes a preferred candidate without activating it.
        const response = ConnectedServicePoolSelectionGetResponseV1Schema.parse({
            group: { service, groupId: pool.groupId }, observedAtMs: 100,
            activeAccountRef: activeAccountId ? { service, accountId: activeAccountId } : null,
            activeSince: null,
            selection: {
                selected: candidate('preferred', 0), reason: 'selected', excluded: [],
                decisionTrace: {
                    activeProfileId: activeAccountId, reason: 'selected', strategy: 'priority',
                    selectionBasis: 'preference', sticky: false,
                    orderedEligibleCandidates: [candidate('preferred', 0), candidate('current', 1)],
                    candidates: [
                        { profileId: 'preferred', decision: 'selected', quotaEvidence: { status: 'stale_or_missing' } },
                        { profileId: 'current', decision: 'eligible', quotaEvidence: { status: 'stale_or_missing' } },
                    ],
                },
            },
        });
        if ('status' in response) throw new Error('Expected a selection read');

        const members = readUsagePoolMembers(pool, [], response.selection, response.activeAccountRef);

        expect(members.filter(member => member.selected).map(member => member.accountId)).toEqual(inUse);
        expect(members.map(member => [member.accountId, member.rank, member.evidence?.decision])).toEqual([
            ['preferred', 1, 'selected'], ['current', 2, 'eligible'],
        ]);
    });
});
