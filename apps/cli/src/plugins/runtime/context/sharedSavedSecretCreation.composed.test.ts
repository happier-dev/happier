import { expect, it } from 'vitest';

import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createSharedSavedSecretForPlugin } from './sharedSavedSecretCreation';

it('awaits asynchronous parent admission before creating a shared resource', async () => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Fixture credentials unavailable');
        const rejection = new Error('template_admission_retired');
        await expect(fixture.inHome(() => createSharedSavedSecretForPlugin({
            name: 'Database password', value: 'must-not-be-created', audience: { teamGrants: ['team-reviewed'] },
            expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            signal: new AbortController().signal, readCredentials: async () => credentials,
            assertCurrent() {
                const rejected = Promise.reject(rejection);
                // A deliberately ignored parent Promise must not create an
                // unhandled-rejection distraction from the actual effect.
                void rejected.catch(() => undefined);
                return rejected;
            },
        }))).rejects.toBe(rejection);
        expect(fixture.writes).toEqual([]);
    } finally { await fixture.close(); }
});

it('retains the opaque candidate reference after a lost create acknowledgement, without replaying creation', async () => {
    const fixture = await createSavedSecretsCliHttpFixture({ loseCreateResponse: true });
    try {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Fixture credentials unavailable');
        const result = fixture.inHome(() => createSharedSavedSecretForPlugin({
            name: 'Database password', value: 'lost-acknowledgement-fixture', audience: { teamGrants: ['team-reviewed'] },
            expectedScopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            signal: new AbortController().signal, readCredentials: async () => credentials, assertCurrent() {},
        }));
        await expect(result).rejects.toMatchObject({ code: 'outcome_unknown', details: {
            candidateRef: expect.stringMatching(/^happier:shared-secret:v1:/u),
        } });
        expect(fixture.writes).toHaveLength(1);
        await expect(result).rejects.toMatchObject({ details: {
            candidateRef: `happier:shared-secret:v1:${String(fixture.writes[0]?.resourceId)}`,
        } });
    } finally { await fixture.close(); }
});
