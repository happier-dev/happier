import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { FeaturesResponseSchema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { materializeMcpServerConfigRecord, listSelectedMcpSharedSecretReferences } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createExecutionRunAccountSettingsSnapshotResolver } from './resolveExecutionRunAccountSettingsSnapshot';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetInMemoryAccountSettingsContextForTests(); });

const credentials: StoredCredentials = {
    token: `e30.${Buffer.from(JSON.stringify({ sub: 'run-mcp-owner' })).toString('base64url')}.signature`, encryption: null,
};

function captureHomeReads(onCatalogRead?: () => void, sharedSecret = false) {
    // Home HTTP and the caller-supplied credential-file reader are the genuine
    // boundaries. Bootstrap, invocation custody and catalog admission stay real.
    return vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const target = new URL(String(url));
        expect(target.origin).toBe('https://run-owner.test');
        expect(options?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
        if (target.pathname === '/v2/account/settings') return { status: 200, data: {
            version: 7, content: { t: 'plain', v: { preferredLanguage: 'fr' } },
        } };
        if (target.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (target.pathname === '/v1/account/entity-rows/mcp') {
            onCatalogRead?.();
            return { status: 200, data: { status: 'present', revision: 2, content: { t: 'plain', v: { v: 1,
                servers: [{ id: 'wilson-brief', name: 'wilson-brief', transport: 'stdio', stdio: { command: 'brief-server', args: [] },
                    env: sharedSecret ? { WILSON_TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:wilson-token' } } : {},
                    createdAt: 1, updatedAt: 1 }, ...(sharedSecret ? [{
                        id: 'unselected', name: 'unselected', transport: 'stdio', stdio: { command: 'other-server', args: [] },
                        env: { OTHER_TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:unavailable-unselected' } },
                        createdAt: 1, updatedAt: 1,
                    }] : [])], bindings: [{ id: 'all', serverId: 'wilson-brief', enabled: true,
                        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }],
            } } } };
        }
        if (target.pathname === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [{
            resourceId: 'wilson-token', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'wilson-token', mode: 'plain',
                content: { v: 1, name: 'Wilson token', kind: 'token', value: 'synthetic-home-token' } }),
            entry: { ref: 'happier:shared-secret:v1:wilson-token', source: 'shared_resource', relationship: 'owner',
                ownerAccountId: 'run-mcp-owner', name: 'Wilson token', kind: 'token', revision: 1, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] } };
        return { status: 404, data: {} };
    });
}

describe('Machine Execution Run owner account snapshot', () => {
    it('keeps the captured Settings version when a reusable active snapshot is older', async () => {
        captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings() {} });
        try {
            const initial = await resolver();
            expect(initial.settingsVersion).toBe(7);
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
                settingsVersion: 5, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKey(credentials) });
            const incumbent = getActiveAccountSettingsSnapshot();
            const refreshed = await resolver();
            expect(refreshed.settingsVersion).toBe(7);
            expect(refreshed.settings.preferredLanguage).toBe('fr');
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        } finally { await resolver.dispose(); }
    });
    it('keeps an admitted Workflow requester snapshot separate from the Machine custodian and refuses retired custody', async () => {
        const f = await createProjectSessionRuntimeFixture({ serverId: 'session-home', serverUrl: 'https://session-home.test',
            machineAccess: { custodianAccountId: 'custodian', role: 'manage' }, accountSettings: { preferredLanguage: 'fr' } });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey({ token: 'custodian', encryption: null }) });
        const incumbent = getActiveAccountSettingsSnapshot();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'machine',
            serverHttpBaseUrl: 'https://session-home.test', readCredentials: async () => null,
            isOwnerCurrent: () => true, onSettings() {} });
        try {
            const read = resolver.forInvocation({ signal: f.signal, requesterSessionBootstrap: f.bootstrap });
            const snapshot = await read();
            expect(snapshot?.settings.preferredLanguage).toBe('fr');
            expect(snapshot?.scopeKey).toBe(resolveAccountSettingsScopeKey(f.bootstrap.credentials));
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
            f.retire();
            expect((await read())?.settings.preferredLanguage).toBe('fr');
            await f.bootstrap.dispose();
            await expect(read()).rejects.toMatchObject({ code: 'provider_authorization_changed' });
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        } finally { await resolver.dispose(); }
    });
    it('refuses a Run read after its owner retires even while the original credentials remain available', async () => {
        captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings() {} });
        await resolver();
        const operation = resolver.readOperationContext();
        expect(operation?.readSnapshot()).not.toBeNull();
        await resolver.dispose();
        await expect(resolver()).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(operation?.readSnapshot()).toBeNull();
    });

    it.each(['', '   ', 'run-machine'])('preserves the typed Account refusal with diagnostic Machine %j', async machineId => {
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId, serverHttpBaseUrl: 'https://run-owner.test',
            readCredentials: async () => null, isOwnerCurrent: () => true, onSettings() {} });
        try {
            await expect(resolver()).rejects.toMatchObject({ code: 'provider_authorization_changed', retryable: true, action: 'retry' });
            const refusal = ProviderErrorV1Schema.parse(await resolver().catch(error => error));
            expect(refusal.machineId).toBe(machineId.trim() || undefined);
        } finally { await resolver.dispose(); }
    });
    it('withdraws a demanded captured catalog when its Home refresh is unavailable', async () => {
        const reads = captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine', serverHttpBaseUrl: 'https://run-owner.test',
            readCredentials: async () => credentials, isOwnerCurrent: () => true, onSettings() {} });
        await resolver({ mcpServerCatalog: true });
        const operation = resolver.readOperationContext();
        reads.mockRejectedValueOnce(new Error('Home unavailable'));
        await expect(resolver.refreshDemandedMcpCatalog()).rejects.toThrow();
        expect(operation?.readSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'unavailable', reason: 'encryption-material-unavailable' });
        await resolver.refreshDemandedMcpCatalog();
        expect(operation?.readSnapshot()?.mcpServerCatalog?.status).toBe('ready');
        await resolver.dispose();
    });
    it('publishes demanded MCP rows in the captured invocation holder without retargeting the focused Account', async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 99,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'focused-other-account', encryption: null }) });
        const incumbent = getActiveAccountSettingsSnapshot();
        captureHomeReads();
        let current = true;
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine', serverHttpBaseUrl: 'https://run-owner.test',
            readCredentials: async () => current ? credentials : null, isOwnerCurrent: () => true, onSettings: () => {} });
        await resolver({ mcpServerCatalog: true });
        const operation = resolver.readOperationContext();
        expect(operation?.readSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 2 });
        await resolver({ mcpServerCatalog: true });
        expect(resolver.readOperationContext()).toBe(operation);
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        current = false;
        await expect(resolver.refreshDemandedMcpCatalog()).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(operation?.readSnapshot()).toBeNull();
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        current = true;
        await resolver({ mcpServerCatalog: true });
        expect(resolver.readOperationContext()).not.toBe(operation);
        expect(resolver.readOperationContext()?.readSnapshot()?.mcpServerCatalog?.status).toBe('ready');
        expect(operation?.readSnapshot()).toBeNull();
        await resolver.dispose();
    });
    it('admits only selected MCP shared-secret references through the owner Home before materializing', async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey({ token: 'focused-other-account', encryption: null }) });
        const incumbent = getActiveAccountSettingsSnapshot();
        captureHomeReads(undefined, true);
        const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {} });
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
            expect(new URL(String(url)).origin).toBe('https://run-owner.test');
            expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
            return Response.json(features);
        }));
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings: () => {} });
        const initial = await resolver({ mcpServerCatalog: true });
        const select = (snapshot: typeof initial) => resolveSessionCapabilitiesForDirectory({
            settings: readMcpServersSettingsFromAccountSettings(snapshot), machineId: 'run-machine', directory: '/repo',
            selection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['wilson-brief'], forceExcludeServerIds: [] } },
        });
        const references = listSelectedMcpSharedSecretReferences(select(initial).selectedServersByName);
        expect(references).toEqual([{ ref: 'happier:shared-secret:v1:wilson-token' }]);
        const admitted = await resolver({ mcpServerCatalog: true, savedSecretReferences: references });
        const materialized = await materializeMcpServerConfigRecord({
            resolved: { directory: '/repo', strictMode: true, serversByName: select(admitted).selectedServersByName },
            savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(admitted), processEnv: {}, tmpDir: null,
        });
        try {
            const configPath = materialized.mcpServers['wilson-brief']?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
            if (!configPath) throw new Error('Missing owned MCP launcher configuration');
            // The real stdio materializer protects secret values in this file,
            // rather than publishing them in the Agent-facing launcher env.
            const launch: unknown = JSON.parse(await readFile(configPath, 'utf8'));
            expect(launch).toMatchObject({ env: { WILSON_TOKEN: 'synthetic-home-token' } });
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        } finally {
            materialized.cleanup();
            await resolver.dispose();
        }
    });

    it('admits the demanded MCP catalog from the exact owner Home without borrowing focused Account state', async () => {
        const focusedCredentials: StoredCredentials = { token: 'focused-other-account', encryption: null };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(focusedCredentials) });
        const incumbent = getActiveAccountSettingsSnapshot();
        captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings: () => {} });
        const snapshot = await resolver({ mcpServerCatalog: true });
        expect(snapshot.settings.preferredLanguage).toBe('fr');
        expect(snapshot.mcpServerCatalog).toMatchObject({ status: 'ready', catalog: { servers: [{ id: 'wilson-brief' }] } });
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    });

    it('rejects owner credential replacement during demanded catalog admission', async () => {
        let current: StoredCredentials | null = credentials;
        captureHomeReads(() => { current = null; });
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => current,
            isOwnerCurrent: () => true, onSettings: () => {} });
        await expect(resolver({ mcpServerCatalog: true })).rejects.toMatchObject({ code: 'scope-retired' });
    });
});
