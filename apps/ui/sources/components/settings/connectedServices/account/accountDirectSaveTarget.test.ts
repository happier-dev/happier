import { describe, expect, it } from 'vitest';

import { resolveAccountDirectSaveTarget } from './accountDirectSaveTarget';

const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
const revisioned = { ref: { service, accountId: 'work' }, authenticationModeId: 'api-key',
    revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' };

describe('Account-direct save target', () => {
    it('adds a new account under a fresh identity', () => {
        expect(resolveAccountDirectSaveTarget({ intent: { kind: 'add' }, service, modeId: 'api-key', accounts: [revisioned], newAccountId: () => 'new-id' }))
            .toEqual({ kind: 'save', account: { service, accountId: 'new-id' } });
    });

    it('re-entering a key edits the exact viewed credential through the one-record owner (convert on edit)', () => {
        expect(resolveAccountDirectSaveTarget({ intent: { kind: 'reconnect', accountId: 'work' }, service, modeId: 'api-key',
            accounts: [revisioned], newAccountId: () => 'unused' }))
            .toEqual({ kind: 'save', account: { service, accountId: 'work' }, expectedCredentialRevision: revisioned.credentialRevision });
    });

    it('re-entering the key of a converted account rotates its one existing Saved Secret record, never a second one', () => {
        const converted = { ...revisioned, savedSecretResourceIds: ['record-1'] };
        expect(resolveAccountDirectSaveTarget({ intent: { kind: 'reconnect', accountId: 'work' }, service, modeId: 'api-key',
            accounts: [converted], newAccountId: () => 'unused' }))
            .toEqual({ kind: 'rotate', resourceId: 'record-1' });
        // A key held by several records cannot be mapped field by field here; it is refused, not re-minted.
        expect(resolveAccountDirectSaveTarget({ intent: { kind: 'reconnect', accountId: 'work' }, service, modeId: 'api-key',
            accounts: [{ ...converted, savedSecretResourceIds: ['record-1', 'record-2'] }], newAccountId: () => 'unused' }))
            .toEqual({ kind: 'unavailable' });
    });

    it('refuses an edit it cannot fence or that changes the sign-in method', () => {
        const unfenced = { ...revisioned, revisionSemantics: 'legacy_unfenced' as const, credentialRevision: null };
        expect(resolveAccountDirectSaveTarget({ intent: { kind: 'reconnect', accountId: 'work' }, service, modeId: 'api-key',
            accounts: [unfenced], newAccountId: () => 'unused' })).toEqual({ kind: 'unavailable' });
        expect(resolveAccountDirectSaveTarget({ intent: { kind: 'reconnect', accountId: 'work' }, service, modeId: 'other-mode',
            accounts: [revisioned], newAccountId: () => 'unused' })).toEqual({ kind: 'unavailable' });
        expect(resolveAccountDirectSaveTarget({ intent: { kind: 'reconnect', accountId: 'missing' }, service, modeId: 'api-key',
            accounts: [revisioned], newAccountId: () => 'unused' })).toEqual({ kind: 'unavailable' });
    });
});
