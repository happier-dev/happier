import axios from '@/api/client/credentialAxios';
import { afterEach, expect, it, vi } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { normalizeCliActionThrownError } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountProjectionsV4';
import { readCliClientUpgradeRequired } from './clientCompatibility/cliClientCompatibility';
import { fetchAccountProfile } from './accountProfile';

afterEach(() => vi.restoreAllMocks());

it('reads only the self profile without coupling requester identity to pool policy V2', async () => {
    const group = QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1, ref: { service: { pluginId: 'acme.connected-accounts', localId: 'git/hosting' }, groupId: 'pool' },
        incarnation: 'pool-incarnation', displayName: null, activeConnectedAccountId: null,
        generation: 0, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1, members: [], policy: { v: 2 },
    });
    const data = { id: 'bob', connectedAccountGroupsV4: [group] };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data });
    const selfRead = { token: 'never-record-bearer', projection: 'self' as const };
    const self = await fetchAccountProfile(selfRead);
    expect(self).toMatchObject({ id: 'bob' });
    expect(self).not.toHaveProperty('connectedAccountGroupsV4');
    expect(await fetchAccountProfile({ token: selfRead.token })).toMatchObject({ connectedAccountGroupsV4: [group] });

    // A future catalog shape is unrelated to the self-profile identity contract.
    get.mockResolvedValue({ status: 200,
        data: { ...data, connectedAccountGroupsV4: [{ ...group, policy: { v: 3 } }] } });
    await expect(fetchAccountProfile(selfRead)).resolves.toMatchObject({ id: 'bob' });
    await expect(fetchAccountProfile({ token: selfRead.token })).rejects.toThrow();
});

it.each(['full', 'self'] as const)('preserves a validated profile upgrade requirement for the %s projection', async projection => {
    const upgrade = { error: 'client-upgrade-required',
        requirement: { v: 1, kind: 'account-stored-content', minimumProtocolVersion: 4 } };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 426,
        data: { ...upgrade, secretResponseBody: 'never-record-private-response' } });
    const opts = { token: 'never-record-bearer', projection };
    let refusal: unknown;
    try { await fetchAccountProfile(opts); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ response: { status: 426 } });
    // Unknown response fields cannot make the closed upgrade contract valid.
    expect(readCliClientUpgradeRequired(refusal)).toBeNull();

    get.mockResolvedValue({ status: 426, data: upgrade });
    try { await fetchAccountProfile(opts); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'client-upgrade-required', response: { status: 426 } });
    expect(readCliClientUpgradeRequired(refusal)).toEqual(upgrade);
    expect(JSON.stringify(refusal)).not.toMatch(/never-record/u);
});

it('retains a signed profile purpose refusal through the public Action failure projection', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 401,
        data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } });
    let refusal: unknown;
    try {
        await fetchAccountProfile({ token: 'never-record-bearer', authorizeRequest: () => ({
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'never-record-proof',
        }) });
    } catch (error) { refusal = error; }
    const result = normalizeCliActionThrownError(refusal);
    expect(result.failure).toMatchObject({ errorCode: 'action_forbidden', details: {
        requiredFact: 'verification_purpose', remedy: expect.any(String),
    }, failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } });
    expect(JSON.stringify(result)).not.toMatch(/never-record/u);
});

it.each([401, 403])('keeps ordinary bearer profile authentication recovery (%s)', async status => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status,
        data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } });
    await expect(fetchAccountProfile({ token: 'never-record-bearer' }))
        .rejects.toMatchObject({ code: 'not_authenticated', response: { status } });
});
