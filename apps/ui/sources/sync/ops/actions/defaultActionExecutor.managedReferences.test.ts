import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createDefaultActionExecutor } from './defaultActionExecutor';

installApprovalCommonModuleMocks();
afterEach(() => {
    retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks();
});

describe('managed dependency read through the originating Account', () => {
    it('discloses partial requester coverage in the saved Home without native dispatch or mutation', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-references.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_references');
        await upsertAndActivateServer({ serverUrl: 'https://other-references.test', scope: 'tab' });
        const token = createAccountTokenForTests('requester', { currentAccount: true });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const machine = ManagedMachineV1Schema.parse({
            id: 'managed-a', homeId: 'srv_managed_references', custodianAccountId: 'other-owner',
            controller: { machineId: 'controller-a', installationId: 'installation-a' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, value: { id: 'resource-a' } },
            allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest-a',
            desired: 'start', desiredWhen: 'now', intentRevision: 2,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        });
        const requests: string[] = [];
        setRuntimeFetch(async (raw, init) => {
            const url = new URL(String(raw));
            expect(url.origin).toBe(target.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            requests.push(url.pathname);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.references.get', {
            homeId: machine.homeId, managedId: machine.id,
        }, { serverId: target.id, expectedAccountId: 'requester', surface: 'ui' });
        expect(result).toMatchObject({ ok: true, result: {
            homeId: machine.homeId, machineId: 'guest-a', coverage: 'partial', references: [],
            unavailable: expect.arrayContaining(['artifacts', 'profiles', 'pools', 'assignments']),
        } });
        expect(requests).toContain('/v1/machines/managed/actions/get');
        expect(requests.some(path => path.startsWith('/v1/actions/'))).toBe(false);
    });
});
