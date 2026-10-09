import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createDefaultActionExecutor } from './defaultActionExecutor';

installApprovalCommonModuleMocks();
const initialState = getStorage().getState();
afterEach(() => {
    retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests(); getStorage().setState(initialState, true); vi.restoreAllMocks();
});

describe('preset Actions through the captured Home', () => {
    it('refuses acquisition from the captured Account preference while retained reads stay usable', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://creation-off.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_creation');
        const token = createAccountTokenForTests('creation-owner');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const requests: string[] = [];
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            requests.push(path);
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path.endsWith('/list')) return Response.json({ machines: [] });
            return Response.json({ code: 'permission_denied' }, { status: 403 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: target.id, surface: 'ui', bypassApprovals: true, managedMachineCreationEnabled: true } as const;
        expect(await executor.execute('machines.managed.acquire', { selection: { kind: 'one-off', homeId: 'srv_creation',
            controller: { machineId: 'host', installationId: 'installation' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } }, context)).toEqual({ ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' });
        expect(await executor.prepare('machines.managed.acquire', { selection: { kind: 'one-off', homeId: 'srv_creation',
            controller: { machineId: 'host', installationId: 'installation' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } }, context)).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'creation_disabled' } });
        expect(await executor.execute('machines.managed.list', { homeId: 'srv_creation' }, context))
            .toEqual({ ok: true, result: { machines: [] } });
        expect(requests.some(path => path.endsWith('/acquire'))).toBe(false);
    });
    it('reads managed inventory through its captured Home and fails native admission closed', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-target.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed');
        await upsertAndActivateServer({ serverUrl: 'https://managed-focused.test', scope: 'tab' });
        const token = createAccountTokenForTests('managed-owner');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const requested: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-target.test');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            requested.push(url.pathname);
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname.endsWith('/list')) return Response.json({ machines: [] });
            return Response.json({ code: 'permission_denied' }, { status: 403 });
        });
        const execute = createDefaultActionExecutor().execute;
        const context = { serverId: target.id, surface: 'ui', bypassApprovals: true } as const;
        expect(await execute('machines.managed.list', { homeId: 'srv_managed' }, context)).toEqual({ ok: true, result: { machines: [] } });
        expect(await execute('machines.managed.get', { homeId: 'srv_managed', managedId: 'hidden' }, context))
            .toMatchObject({ ok: false, errorCode: 'permission_denied' });
        expect(await execute('machines.managed.list', { homeId: target.id }, context))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(await execute('machines.managed.inspect', { homeId: 'srv_managed', managedId: 'retained' }, context))
            .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(requested.filter(path => path.startsWith('/v1/machines/managed/')))
            .toEqual(['/v1/machines/managed/actions/list', '/v1/machines/managed/actions/get']);
    });
    it('uses stable Home identity and exact captured credentials for all six intents while another Home is focused', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://preset-target.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_preset');
        await upsertAndActivateServer({ serverUrl: 'https://preset-focused.test', scope: 'tab' });
        const token = createAccountTokenForTests('preset-owner');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const requests: Array<{ path: string; body: unknown }> = [];
        const preset = {
            id: 'preset-a', homeId: 'srv_preset', revision: 1, name: 'Guest',
            owner: { kind: 'account', accountId: 'preset-owner' },
            recipe: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'guest', choices: { cores: 2 } },
            controller: { machineId: 'host-a', installationId: 'installation-a' },
        } as const;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://preset-target.test');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname.endsWith('/list')) return Response.json({ kind: 'listed', presets: [preset] });
            if (url.pathname.endsWith('/get')) return Response.json({ kind: 'found', preset });
            if (url.pathname.endsWith('/update')) return Response.json({ kind: 'conflict', currentRevision: 2 }, { status: 409 });
            if (url.pathname.endsWith('/archive')) return Response.json({ kind: 'refused', code: 'permission_denied' }, { status: 403 });
            if (url.pathname.startsWith('/v1/machines/presets/')) return Response.json({ kind: 'saved', preset });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: target.id, surface: 'ui', bypassApprovals: true } as const;
        const inputs = {
            'machines.presets.list': { homeId: 'srv_preset' },
            'machines.presets.get': { homeId: 'srv_preset', id: 'preset-a' },
            'machines.presets.update': { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1, patch: { name: 'Draft' } },
            'machines.presets.archive': { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1 },
            'machines.presets.restore': { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1 },
        } as const;
        const { revision: _revision, ...create } = preset;
        expect(await executor.execute('machines.presets.list', inputs['machines.presets.list'], context))
            .toMatchObject({ ok: true, result: { kind: 'listed', presets: [preset] } });
        expect(await executor.execute('machines.presets.get', inputs['machines.presets.get'], context))
            .toMatchObject({ ok: true, result: { kind: 'found', preset } });
        expect(await executor.execute('machines.presets.create', create, context)).toMatchObject({ ok: true, result: { kind: 'saved', preset } });
        expect(await executor.execute('machines.presets.update', inputs['machines.presets.update'], context))
            .toEqual({ ok: true, result: { kind: 'conflict', currentRevision: 2 } });
        expect(await executor.execute('machines.presets.archive', inputs['machines.presets.archive'], context))
            .toEqual({ ok: true, result: { kind: 'refused', code: 'permission_denied' } });
        expect(await executor.execute('machines.presets.restore', inputs['machines.presets.restore'], context)).toMatchObject({ ok: true });
        expect(await executor.execute('machines.presets.list', { homeId: target.id }, context))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(requests.filter(({ path }) => path.startsWith('/v1/machines/presets/')).map(({ path }) => path))
            .toEqual(['list', 'get', 'create', 'update', 'archive', 'restore'].map(verb => `/v1/machines/presets/${verb}`));
        expect(requests.some(({ path }) => path.includes('/acquire'))).toBe(false);
    });
});
