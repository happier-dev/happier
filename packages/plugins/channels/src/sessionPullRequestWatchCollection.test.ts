import { describe, expect, it } from 'vitest';
import { migrateChannelStateV11ToV12, withChannelStateSessionIdentity } from './collectionMigrations.js';

describe('PR watch Account candidate selector', () => {
    it('indexes only PR binding membership and removes it on retarget without indexing chat bodies', () => {
        const row = { id: 'binding-1', 'record-kind': 'binding', payload: { deletionState: 'none', enabled: false } };
        const linked = { kind: 'session', sessionId: 'session-1', pullRequestLink: { repository: 'acme/widgets', number: 12 } };
        expect(withChannelStateSessionIdentity(row, linked)).toMatchObject({ 'session-id': 'session-1', 'pr-binding': true });
        const scoped = { kind: 'automation', scopedTrigger: { sessionId: 'session-1', pullRequest: linked.pullRequestLink } };
        expect(withChannelStateSessionIdentity(row, scoped)).toMatchObject({ 'session-id': 'session-1', 'pr-binding': true });
        expect(withChannelStateSessionIdentity({ ...row, 'pr-binding': true }, { kind: 'session', sessionId: 'session-2' }))
            .not.toHaveProperty('pr-binding');
        expect(withChannelStateSessionIdentity({ ...row, 'record-kind': 'ingress-obligation' }, linked)).not.toHaveProperty('pr-binding');
        const deleted = { ...row, 'pr-binding': true, payload: { ...row.payload, target: linked, deletionState: 'finalizingDelete' } };
        expect(withChannelStateSessionIdentity(deleted, linked)).not.toHaveProperty('pr-binding');
        expect(migrateChannelStateV11ToV12(deleted)).not.toHaveProperty('pr-binding');
    });
});
