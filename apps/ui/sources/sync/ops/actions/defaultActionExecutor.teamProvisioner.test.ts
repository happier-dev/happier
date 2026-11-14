import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineProvisionerOptionsFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { createDefaultActionExecutor } from './defaultActionExecutor';

installApprovalCommonModuleMocks();
beforeAll(loadSyncSingletonForTests);
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); });

it.each(['agent37', 'boat'].flatMap(provider => ['check', 'options'].flatMap(role =>
    ['owner', 'member'].flatMap(relationship => (['ui', 'voice'] as const).map(surface => ({ provider, role, relationship, surface }))))))(
    'retains $surface $relationship authority for $provider $role on the installed controller', async ({ provider, role, relationship, surface }) => {
    const serverUrl = `https://team-options-${provider}-${role}-${relationship}-${surface}.test`;
    const homeId = `srv_team_options_${provider}_${role}_${relationship}`;
    const accountId = 'member';
    const profile = await upsertServerProfile({ serverUrl });
    await setServerProfileIdentityForUrl(serverUrl, homeId);
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
        token: createAccountTokenForTests(accountId, { currentAccount: true }),
    });
    const actionId = role === 'options' ? 'machines.provisioners.options' : 'machines.provisioners.check';
    const output = role === 'options' ? createMachineProvisionerOptionsFixture() : { available: true };
    const contribution = { pluginId: `happier.machine.${provider}`, localId: provider };
    const input = { homeId, controller: { machineId: 'controller', installationId: 'installation' }, contribution,
        selectors: {}, credentials: [{ purpose: { consumer: contribution, purpose: 'cloud-api' }, teamId: 'team',
            selection: { source: 'team_resource', resourceId: `shared-${provider}`, deliveryMode: 'brokered' } }] };
    let received = 0;
    let boundaryFailure: unknown;
    // HTTP/installed-Machine boundary only: real capture, issuer codec, sealed
    // requester invocation and public Action dispatch run above this adapter.
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId, accountId,
        ...(relationship === 'member' ? { custodian: { accountId: 'controller-owner', displayName: 'Owner' } } : {}),
        machineId: 'controller',
        installationId: 'installation', actionId, tokenEpoch: 0,
        execute: (body, context) => {
            received++;
            expect(body).toEqual(input);
            expect(context.authorization.binding.accountId).toBe(accountId);
            expect(context.invocation).toMatchObject({ caller: { kind: 'host' }, surface,
                authority: surface === 'voice' ? 'account_automation' : 'present_user' });
            expect(context.invocation.presentUserConfirmation).toBeUndefined();
            return output;
        } });
    setRuntimeFetch(async (rawUrl, init) => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        const response = await boundary.handle(url, init).catch(error => { boundaryFailure = error; throw error; });
        if (response) return response;
        return Response.json({ error: 'unsupported' }, { status: 404 });
    });
    const result = await createDefaultActionExecutor().execute(actionId, input, {
        serverId: profile.id, expectedAccountId: accountId, surface,
        ...(surface === 'voice' ? { authority: 'account_automation' as const } : {}),
    });
    expect(boundaryFailure).toBeUndefined();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: output });
    expect(received).toBe(1);
});
