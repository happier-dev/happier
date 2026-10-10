import { describe, expect, it } from 'vitest';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';

describe('headless settings conditional writes', () => {
    it.each([
        { actionId: 'settings.get', input: { anchor: 'delegation.workDepthLimit', includeVersion: true } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, expectedSettingsVersion: 4 } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, reversal: { kind: 'capture' } } },
    ] as const)('keeps exact reversal client-owned and requires Account credentials for versioned reads/CAS', async request => {
        const action = createCliSettingsDeclarationAction({});
        expect(await action({ ...request, context: { surface: 'agent' } })).toMatchObject('reversal' in request.input
            ? { ok: false, errorCode: 'unavailable', details: { reason: 'client_unavailable', recovery: { kind: 'connect_client' } } }
            : { ok: false, errorCode: 'not_authenticated' });
    });
    it('never borrows daemon credentials for an external conditional preference read', async () => {
        const action = createCliSettingsDeclarationAction({ credentials: { token: 'daemon', encryption: null } });
        expect(await action({ actionId: 'settings.get', input: { anchor: 'usage.coachPreferences', includeVersion: true },
            context: { surface: 'agent', externalActionCredential: { accountId: 'account', principalId: 'principal',
                credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } } }))
            .toMatchObject({ ok: false, errorCode: 'unavailable' });
    });
});
