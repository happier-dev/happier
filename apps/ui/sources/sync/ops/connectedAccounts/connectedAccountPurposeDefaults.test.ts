import { expect, it } from 'vitest';
import { writeAgentDefaultChoice } from '@happier-dev/protocol/connect/agentDefaultChoices';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { mutateConnectedAccountPurposeDefaultsInContext } from './connectedAccountPurposeDefaults';

installDisconnectedServerSocketBoundary();

it('retires a genuine legacy default only with the purpose row acknowledgement, preserving Team and unrelated Settings', async () => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('purpose-paired');
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const agent = { agentId: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, connectedAccounts: [{ purpose: 'model', service }] };
    const team = { purpose: { consumer: { pluginId: 'com.acme.resource', localId: 'worker' }, purpose: 'api' }, teamId: 'work',
        selection: { source: 'team_resource' as const, resourceId: 'cloud', deliveryMode: 'brokered' as const } };
    let purposeBindings: ConnectedPurposeCatalogV1 = { v: 1, bindings: [], teamResourceSelections: [team] };
    let raw: Record<string, unknown> = { futurePreference: { preserved: true }, connectedServicesDefaultAuthByAgentIdV1: {
        v: 1, bindingsByAgentId: { codex: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } },
    } };
    const initialRaw = raw;
    const initialPurposes = purposeBindings;
    let settingsVersion = 7;
    let revision = 3;
    let refuse = true;
    let acknowledge!: () => void;
    let issued!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const dispatched = new Promise<void>(resolve => { issued = resolve; });
    // HTTP persistence is the substituted boundary; canonical migration, Settings
    // preparation, envelope codecs and the captured Account remain real.
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://purpose-paired.test', accountId: 'purpose-paired', request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v2/account/settings') {
            if (init?.method === 'POST') throw new Error('purpose_edit_must_not_write_settings_separately');
            return Response.json({ content: { t: 'plain', v: raw }, version: settingsVersion });
        }
        if (path !== '/v1/account/entity-rows/connected-accounts/purposes') return http.request(input, init);
        if (init?.method !== 'POST') return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value: purposeBindings } } });
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
        expect(mutation.expectedRevision).toBe(revision);
        expect(mutation.settingsMutation?.expectedSettingsVersion).toBe(settingsVersion);
        if (refuse) return Response.json({ status: 'settings-conflict', revision }, { status: 409 });
        issued();
        await ack;
        if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'purposes' || mutation.settingsMutation?.content?.t !== 'plain') throw new Error('Expected paired plain Account envelopes');
        purposeBindings = mutation.content.v.value;
        raw = mutation.settingsMutation.content.v;
        settingsVersion += 1; revision += 1;
        return Response.json({ status: 'updated', revision, cursor: revision, settingsVersion });
    } });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const remove: Parameters<typeof mutateConnectedAccountPurposeDefaultsInContext>[1] = (current, settings) => {
        const written = writeAgentDefaultChoice({ agents: [agent], purposeBindings: current, settings,
            target: { kind: 'account', account: { service, accountId: 'work' } }, agentId: 'codex', makeDefault: false });
        if (!written) return null;
        const { connectedAccountPurposeBindingsV1, ...legacySettingsDelta } = written;
        return { purposeBindings: connectedAccountPurposeBindingsV1, legacySettingsDelta };
    };
    try {
        await expect(mutateConnectedAccountPurposeDefaultsInContext(account, remove)).rejects.toMatchObject({ code: 'account_settings_mutation_conflict' });
        expect(raw).toBe(initialRaw);
        expect(purposeBindings).toBe(initialPurposes);
        refuse = false;
        let settled = false;
        const pending = mutateConnectedAccountPurposeDefaultsInContext(account, remove).then(() => { settled = true; });
        await dispatched;
        expect(settled).toBe(false);
        expect(raw).toBe(initialRaw);
        acknowledge();
        await pending;
        expect(purposeBindings).toEqual({ v: 1, bindings: [], teamResourceSelections: [team] });
        expect(raw).toMatchObject({ futurePreference: { preserved: true }, connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} } });
        expect(raw).not.toHaveProperty('connectedAccountPurposeBindingsV1');
    } finally {
        account.dispose(); await connection.dispose(); bridge.dispose();
    }
});
