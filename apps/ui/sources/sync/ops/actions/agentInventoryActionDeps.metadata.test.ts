import { afterEach, describe, expect, it, vi } from 'vitest';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { connectedServiceProfileKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

installConnectedServicesCommonModuleMocks();
afterEach(() => { resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('captured Account connected-service Action inventory', () => {
    it('projects the requested Home profile and canonical labels without borrowing ambient Settings or profile', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const target = await home.addHome({ name: 'Inventory target', serverUrl: 'https://inventory-target.test',
            accountId: 'target-owner', currentAccount: true, active: false });
        home.answer(target, 'GET /v1/account/encryption/currentness', { body: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        await home.addHome({ name: 'Ambient Home', serverUrl: 'https://inventory-ambient.test',
            accountId: 'ambient-owner', currentAccount: true });
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const account = { service, accountId: 'work' };
        const connectedAccount = { ref: account, displayName: 'Native target name', status: 'connected' as const,
            authenticationModeId: 'oauth', revisionSemantics: 'revisioned' as const,
            credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false,
            configurationRevision: null, scopes: [] };
        home.answer(target, '/v1/account/profile', { body: { ...profileDefaults, id: 'target-owner',
            connectedAccountsV4: [connectedAccount], connectedAccountGroupsV4: [] } });
        home.answer(target, 'GET /v1/account/entity-rows/connected-metadata/presentation', { body: {
            status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, entries: [
                { v: 1, subject: { kind: 'account', account }, label: 'Canonical target name' },
            ] } },
        } });
        home.answer(target, 'GET /v1/account/entity-rows/connected-metadata/acknowledgements', { body: {
            status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, entries: [] } },
        } });
        const { storage } = await import('@/sync/domains/state/storage');
        const original = storage.getState();
        const ambientSettings = { ...original.settings, connectedServicesProfileLabelByKey: {
            [connectedServiceProfileKey({ serviceId: buildQualifiedPluginContributionKey(service), profileId: account.accountId })]: 'Ambient Settings name',
        } };
        storage.setState({ profile: { ...profileDefaults, id: 'ambient-owner',
            connectedAccountsV4: [{ ...connectedAccount, displayName: 'Ambient private name' }], connectedAccountGroupsV4: [] },
            settings: ambientSettings });
        try {
            const { listSpawnConnectedServicesForActions } = await import('./agentInventoryActionDeps');
            const result = await listSpawnConnectedServicesForActions({ agentId: 'codex', serverId: target });
            expect(result).toMatchObject({ profileOptionsByServiceId: {
                'happier.agent.codex/openai-codex': [expect.objectContaining({ profileId: 'work', label: 'Canonical target name' })],
            } });
            expect(JSON.stringify(result)).not.toContain('Ambient');
            expect(home.requestsFor('/v1/account/profile')).toEqual([expect.objectContaining({ serverId: target })]);
        } finally {
            storage.setState({ profile: original.profile, settings: original.settings });
            await home.reset();
        }
    });
});
