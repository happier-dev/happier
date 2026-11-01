import { describe, expect, it, onTestFinished } from 'vitest';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { scmDiffSummarySettingBinding, SCM_DIFF_SUMMARY_SETTING_KEYS, type ScmDiffSummaryCatalogProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { projectAgentModelChoices } from '@/components/settings/pickers/projectAgentModelChoices';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { createScmDiffSummarySettingsCatalogReader } from './scmDiffSummarySettingsCatalog';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineFixture } from '@/dev/testkit';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';

describe('Summary settings machine catalog admission', () => {
    it('returns no catalog without a captured Account', async () => {
        const before = storage.getState();
        onTestFinished(() => storage.setState(before, true));
        storage.setState({ settings: settingsDefaults });
        expect(await createScmDiffSummarySettingsCatalogReader(null)(settingsDefaults, '')).toBeNull();
    });

    it('uses the exact machine Action observation for signed-out, connected-only and empty picker/default admission', async () => {
        const before = storage.getState();
        const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const beforeApplied = runtime.getAppliedActiveServerSnapshot();
        const beforeAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
        onTestFinished(() => {
            runtime.publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState(before, true);
            runtime.publishAppliedActiveServerSnapshot(beforeApplied, beforeAvailable);
        });
        const network = await installSessionOpsNetworkBoundary();
        onTestFinished(() => network.dispose());
        const accountId = 'summary-account';
        const token = `test.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.test`;
        const home = await network.addHome('https://summary-settings.example.test', accountId, { credentials: { token } });
        await setServerProfileIdentityForUrl(home.serverUrl, 'srv_summary_settings');
        const machine = createMachineFixture({ activeAt: Date.now() });
        let profiles: readonly ScmDiffSummaryCatalogProfile[] = [];
        let unavailable = false;
        let catalogRequests = 0;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: home.serverUrl,
            serverIdentityId: 'srv_summary_settings', accountId, machineId: machine.id, actionId: 'agents.models.list', tokenEpoch: 1,
            execute(input, context) {
                catalogRequests += 1;
                expect(input).toEqual({ purpose: 'scm_diff_summary', machineId: machine.id });
                expect(context.target).toEqual({ kind: 'machine', machineId: machine.id });
                return unavailable ? { items: [], source: 'unavailable' } : { items: [], scmDiffSummaryCatalog: { profiles, automaticProfiles: profiles,
                    discoveryTargetKeys: profiles.flatMap(profile => profile.modelSelector?.backendTargetKey ?? []) } };
            } });
        network.setHttpResponder(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/account/encryption/currentness')
                return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return await boundary.handle(new URL(String(url)), init);
        });
        const account = await captureLazyActionAccountContext(home.id);
        onTestFinished(() => account.dispose());
        storage.setState({ settings: settingsDefaults, profileScope: account.accountLifetime.scope, isDataReady: true });
        const reader = createScmDiffSummarySettingsCatalogReader(account);
        expect(await reader(settingsDefaults, '')).toBeNull();
        expect(catalogRequests).toBe(0);

        const settings = { ...settingsDefaults, machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.sourceControl]: { serverIdentityId: 'srv_summary_settings', machineId: machine.id },
        } };
        runtime.publishAppliedActiveServerRuntimeAvailability(false);
        storage.setState({ settings, profileScope: account.accountLifetime.scope, isDataReady: true, machines: { [machine.id]: machine },
            machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        runtime.publishAppliedActiveServerSnapshot({ serverId: account.serverId, serverUrl: home.serverUrl, generation: beforeApplied.generation + 1 });
        const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds(settings), backendEnabledByTargetKey: settings.backendEnabledByTargetKey });
        const sources = entries.map(entry => ({ entry, models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
            catalogModels: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
            agentFormats: getAgentCore(entry.agentId)?.structuredOutput?.formats, runnerCapable: true, discoverable: true }));
        const binding = scmDiffSummarySettingBinding<typeof settings>(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch);
        const signedOut = await reader(settings, '');
        expect(catalogRequests).toBe(1);
        const empty = projectAgentModelChoices({ purpose: 'walkthrough', sources, executableProfiles: signedOut?.profiles, defaultModelTitle: 'Default' });
        expect(empty.defaultProfile).toBeNull();
        expect(empty.selections.size).toBe(0);
        expect(await binding.prepare(settings, true, { readScmDiffSummaryCatalog: reader })).toBeNull();
        const source = sources.find(source => source.entry.agentId === 'claude');
        if (!source) throw new Error('Expected bundled catalog metadata');
        profiles = buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(source.entry.backendTarget),
            models: source.models, agentFormats: source.agentFormats });
        const connected = await reader(settings, '');
        expect(connected?.profiles).toEqual(profiles);
        const offered = projectAgentModelChoices({ purpose: 'walkthrough', sources, executableProfiles: connected?.profiles,
            automaticProfiles: profiles, defaultModelTitle: 'Default' });
        expect(offered.defaultProfile).toMatchObject({ costTier: 'low', structuredOutput: 'supported' });
        expect(offered.catalogProfiles).toEqual(profiles);
        const prepared = await binding.prepare(settings, true, { readScmDiffSummaryCatalog: reader });
        expect(prepared?.(settings)).toEqual({ [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: true });
        const disabled = { ...settings, backendEnabledByTargetKey: { [source.entry.backendTargetKey]: false } };
        expect(connected?.isCurrent(disabled)).toBe(false);
        profiles = [];
        expect((await reader(settings, ''))?.profiles).toEqual([]);
        unavailable = true;
        expect(await reader(settings, '')).toBeNull();
        storage.setState({ settings: settingsDefaults });
        expect(connected?.isCurrent(settings)).toBe(false);
    });
});
