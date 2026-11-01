import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import { readResourceProposalApproval } from './readResourceProposalApproval';
import { describeResourceProposalInboxFacts } from './resourceProposalLabels';

const ref = (itemId: string) => ({ itemId, path: `/w/${itemId}`, identity: { dev: '1', ino: itemId, kind: 'directory' }, collectedAt: 1,
    collectedBy: { accountId: 'a', kind: 'agent' } });
const proposal = (verdicts: readonly ('safe' | 'caution')[]) => readResourceProposalApproval({
    actionId: 'machines.storage.trash.move',
    actionArgs: { machineId: 'm', items: verdicts.map((claimedVerdict, index) => ({
        ref: ref(`i${index}`), expect: 'e', claimedVerdict, reason: { code: index % 2 ? 'rebuilds' : 'merged_clean' },
    })) },
})!;

describe('describeResourceProposalInboxFacts', () => {
    it('says how many items, whether all are safe, and what kinds of things they are', () => {
        const allSafe = describeResourceProposalInboxFacts(proposal(['safe', 'safe', 'safe']));
        const mixed = describeResourceProposalInboxFacts(proposal(['safe', 'safe', 'caution']));
        expect(allSafe).not.toEqual(mixed);
        expect(allSafe).toContain('3');
        expect(mixed).toContain('2');
        expect(mixed).toContain('1');
        // The kinds come from the items' own reasons, once each.
        expect(allSafe.split(' · ')).toHaveLength(2);
        expect(allSafe.split(' · ')[1]).toBe([
            t('machineStorage.reasons.merged_clean'),
            t('machineStorage.reasons.rebuilds'),
        ].join(', '));
    });
});
