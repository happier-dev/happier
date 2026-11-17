import { describe, expect, it } from 'vitest';
import { isProjectSessionDefaultsEditUnchanged } from './projectSessionDefaultsActions';

describe('project defaults editor intent', () => {
    it('does not write inherited picks or merely reordered defaults', () => {
        expect(isProjectSessionDefaultsEditUnchanged(null, {})).toBe(true);
        expect(isProjectSessionDefaultsEditUnchanged({ approvalProfileId: 'review', defaultAgentTarget: {
            kind: 'agent', identity: { pluginId: 'example.agent', localId: 'example' },
        } }, { defaultAgentTarget: { kind: 'agent', identity: { localId: 'example', pluginId: 'example.agent' } }, approvalProfileId: 'review' })).toBe(true);
    });

    it('preserves deliberate Automatic and explicit profile clears as changed picks', () => {
        expect(isProjectSessionDefaultsEditUnchanged(null, { approvalProfileId: null })).toBe(false);
        expect(isProjectSessionDefaultsEditUnchanged({ approvalProfileId: 'review' }, null)).toBe(false);
    });
});
