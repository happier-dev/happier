import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { delimiter, join } from 'node:path';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createVoiceSettingsOwner } from '@happier-dev/protocol/voice/settings/voiceSettings';
import { createCliSettingsCatalogServices, projectCliProviderStateSharingRiskAgentIdsV1 } from './settingsCatalogServices';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { readProviderStateSharingRiskAgentIdsV1, prepareAgentProviderStateSharingChangeV1, prepareDefaultProviderStateSharingChangeV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';
import { encodeScmDiffSummaryModelOverride, scmDiffSummarySettingBinding, SCM_DIFF_SUMMARY_SETTING_KEYS, type ScmDiffSummaryCatalogProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRecordV1Schema, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ScmDiffSummaryModelCatalogObservationV1Schema, resolveScmDiffSummaryDefaultModelProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { createCliActionDeps } from './createCliActionDeps';
// Native sign-in is exercised through the real plugin; compile its source
// graph during collection rather than inside the catalog assertion's budget.
import '@happier-dev/plugins-claude';

// First-party declaration/schema preparation is fixture construction, not a
// native sign-in or Account request. Keep that cold work in collection too.
const nativeCatalogRawSettings = { backendEnabledByTargetKey: Object.fromEntries(
    [...readCurrentContributionRegistry().agentDefinitionsById.values()].flatMap(entry => entry.identity
        ? listAgentExecutionTargetsV1(entry.identity).map(target => [buildBackendTargetKeyV2(target), entry.id === 'claude']) : []),
) };
const nativeCatalogSettings = accountSettingsParse(nativeCatalogRawSettings);

describe('exact remote Voice Agent catalog admission', () => {
    it('offers executable automatic models from native sign-in and the canonical connected default', async () => {
        const home = createTempDirSync('summary-native-catalog-');
        const fileName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
        writeExecutableShimSync({ dir: home, fileName,
            contents: process.platform === 'win32'
                ? '@echo off\r\nif defined ANTHROPIC_API_KEY (echo {"loggedIn":true}& exit /b 0)\r\necho {"loggedIn":false}\r\nexit /b 1\r\n'
                : '#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY" ]; then printf \'{"loggedIn":true}\'; exit 0; fi\nprintf \'{"loggedIn":false}\'\nexit 1\n' });
        for (const key of ['HOME', 'USERPROFILE', 'HAPPIER_HOME_DIR', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(key, home);
        vi.stubEnv('HAPPIER_CLAUDE_PATH', join(home, fileName));
        vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
        vi.stubEnv('ANTHROPIC_API_KEY', undefined);
        vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
        vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
        const previous = getActiveAccountSettingsSnapshot();
        try {
            const services = createCliSettingsCatalogServices({});
            // Only Claude's native executable/auth is supplied by this OS
            // fixture; ambient worker Agent installations are not test input.
            const settings = nativeCatalogSettings;
            const isClaude = (profile: ScmDiffSummaryCatalogProfile) =>
                profile.modelSelector?.backendTargetKey === 'agent:happier.agent.claude/claude';
            const credentials = { token: 'summary-connected-route-fixture', encryption: null };
            setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: nativeCatalogRawSettings, settingsVersion: 1, loadedAtMs: 1,
                settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
            let purposeRecord = emptyConnectedAccountCatalogRecordV1('purposes');
            let purposeRevision = 1;
            // Every public Action has its Account HTTP boundary from its first
            // observation; the connected default arrives later through this row.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v2/account/settings') return { status: 200, data: {
                    version: 1, content: { t: 'plain', v: nativeCatalogRawSettings },
                } };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                    settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return { status: 200,
                    data: { status: 'present', revision: purposeRevision, content: { t: 'plain', v: purposeRecord } } };
                if (path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
                throw new Error(`Unexpected fixture Account read: ${path}`);
            });
            const observeActionCatalog = async (connected = false) => {
                const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, ...(connected ? { credentials } : {}),
                    sessionId: 'cli-global', mode: 'plain', ctx: null, machineActionDirectTargetTransport: {
                        machineId: 'summary-machine', invoke: async () => { throw new Error('Unexpected catalogue transport recursion'); },
                    } }));
                expect(await executor.execute('agents.models.list', { machineId: 'another-machine', purpose: 'scm_diff_summary' },
                    { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: { source: 'unavailable' } });
                const result = await executor.execute('agents.models.list', { machineId: 'summary-machine', purpose: 'scm_diff_summary' },
                    { surface: 'cli', authority: 'present_user' });
                expect(result.ok, JSON.stringify(result)).toBe(true);
                if (!result.ok) throw new Error(JSON.stringify(result));
                const outputSchema = getActionSpec('agents.models.list').outputSchema;
                if (!outputSchema) throw new Error('Missing agents.models.list output schema');
                outputSchema.parse(result.result);
                if (!result.result || typeof result.result !== 'object' || !('scmDiffSummaryCatalog' in result.result)) throw new Error('Missing machine catalog');
                return ScmDiffSummaryModelCatalogObservationV1Schema.parse(result.result.scmDiffSummaryCatalog);
            };
            const signedOutObservation = await observeActionCatalog();
            expect(signedOutObservation.automaticProfiles.filter(isClaude)).toEqual([]);
            expect(resolveScmDiffSummaryDefaultModelProfile(signedOutObservation.automaticProfiles)).toBeNull();
            expect(signedOutObservation.profiles.some(isClaude)).toBe(true);
            const purpose = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'claude',
                contributions: readCurrentContributionRegistry() })?.authorizedPurposes.find(declaration =>
                    declaration.serviceRefs.some(service => service.localId === 'claude-subscription'));
            if (!purpose?.serviceRefs[0]) throw new Error('Claude connected route declaration is unavailable');
            purposeRecord = ConnectedAccountCatalogRecordV1Schema.parse({ key: 'purposes', value: { v: 1, bindings: [{
                purpose: purpose.purpose, target: { kind: 'account', account: { service: purpose.serviceRefs[0], accountId: 'connected-summary' } },
            }] } });
            purposeRevision += 1;
            const connectedObservation = await observeActionCatalog(true);
            expect(connectedObservation.automaticProfiles.some(profile => isClaude(profile) && profile.costTier === 'low'
                && profile.structuredOutput === 'supported')).toBe(true);
            expect(resolveScmDiffSummaryDefaultModelProfile(connectedObservation.automaticProfiles)).toMatchObject({ costTier: 'low', structuredOutput: 'supported' });
            vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-api-key');
            const signedIn = await observeActionCatalog();
            expect(signedIn.automaticProfiles.some(profile => isClaude(profile) && profile.structuredOutput === 'supported')).toBe(true);
            expect(signedIn.automaticProfiles.some(profile => isClaude(profile) && profile.costTier === 'low'
                && profile.structuredOutput === 'supported')).toBe(true);
            const binding = scmDiffSummarySettingBinding<typeof settings>(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch);
            const prepared = await binding.prepare(settings, true, services);
            expect(prepared?.(settings)).toEqual({ [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: true });
            expect(settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]).toBe('');
        } finally {
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            removeTempDirSync(home);
        }
    });
    it('enumerates an admitted external Agent for an unset summary model without persisted identity resolution', async () => {
        const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            // The native preflight reads the plugin's Settings through its
            // real binding; this fixture has no persisted Account record.
            runtimeOptions: { accountSettingsRecordAdapter: { bindOperation: async () => ({
                readRecord: async () => ({ status: 'absent' }), writeRecord: async () => ({ status: 'unavailable' }),
            }) } },
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.summary-catalog', contributes: {
                agents: [{ id: 'claude', title: 'External Agent', primary: 'executionRuns', runtime: { kind: 'custom' },
                    capabilities: { executionRuns: { open: ['create'], stop: true, checkpoint: false },
                        structuredOutput: { formats: ['json'] } } }],
            } }), files: {
                'runner.mjs': `export function createAgent() { throw new Error('Catalog enumeration must not execute an Agent'); }`,
                'daemon.mjs': `import { createAgent } from './runner.mjs';
                    export function activate(api) {
                        api.agents.register('claude', createAgent, { sessionRunnerFactory: {
                            module: './runner.mjs', export: 'createAgent', runtimeApiVersion: 1
                        }, preflightSessionControls: {
                            probeModels: async () => [{ id: 'external-model', name: 'External model', costTier: 'low',
                                capabilities: { structuredOutput: 'supported' } }]
                        } });
                    }`,
            } }],
        });
        try {
            expect(admitted.registry.pluginDiagnosticsByPluginId['acme.summary-catalog'] ?? []).toEqual([]);
            const external = [...readCurrentContributionRegistry().agentDefinitionsById.values()]
                .find(entry => entry.identity?.pluginId === 'acme.summary-catalog');
            expect(external?.id).toBe('acme.summary-catalog/claude');
            const settings = accountSettingsParse({});
            const services = createCliSettingsCatalogServices({});
            const catalog = await services.readScmDiffSummaryCatalog!(settings, '', { includeConfigured: true });
            expect(catalog).not.toBeNull();
            expect(catalog?.isCurrent(settings)).toBe(true);
            const targetKey = 'agent:acme.summary-catalog/claude';
            const selected = await services.readScmDiffSummaryCatalog!(settings, encodeScmDiffSummaryModelOverride({
                backendTargetKey: targetKey, modelId: 'external-model',
            }));
            expect(selected).not.toBeNull();
            expect(selected?.profiles).toContainEqual(expect.objectContaining({
                modelSelector: { backendTargetKey: targetKey, modelId: 'external-model' },
            }));
            expect(selected?.profiles).toEqual(catalog?.profiles.filter(profile => profile.modelSelector?.backendTargetKey === targetKey));
            expect(settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]).toBe('');
        } finally {
            await admitted.dispose();
        }
    });
    it('refuses an unknown model target without treating the Custom ACP declaration as executable', async () => {
        const catalog = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        try {
            expect([...readCurrentContributionRegistry().agentDefinitionsById.values()].some(entry => entry.id === 'custom-acp')).toBe(true);
            const services = createCliSettingsCatalogServices({});
            await expect(services.readScmDiffSummaryCatalog!(accountSettingsParse({}), encodeScmDiffSummaryModelOverride({
                backendTargetKey: 'agent:missing.agent/missing', modelId: 'model',
            }))).resolves.toBeNull();
        } finally {
            await catalog.dispose();
        }
    });
    it('distinguishes an unactivated empty snapshot from a proven activated empty native catalog', () => {
        const empty = createResolvedContributionRegistry({});
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: false, unavailable: false })).toBeNull();
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: true, unavailable: false })).toEqual([]);
        expect(projectCliProviderStateSharingRiskAgentIdsV1(empty, { activated: true, unavailable: true })).toBeNull();
    });
    it('derives sharing risks from every current Agent declaration', async () => {
        // A previous external fixture retires to an authoritative empty catalog.
        const catalog = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        try {
            const entries = [...readCurrentContributionRegistry().agentDefinitionsById.values()];
            const services = createCliSettingsCatalogServices({});
            const risks = readProviderStateSharingRiskAgentIdsV1(entries.map(entry => ({ agentId: entry.id,
                capability: entry.richDefinition?.definition.capabilities.providerStateSharing,
            })));
            expect(services.readProviderStateSharingRiskAgentIds()).toEqual(risks);
            expect(risks).toContain('codex');
        } finally {
            await catalog.dispose();
        }
    });
    it('keeps bundled and default sharing writable beside an admitted external Agent, then refuses retirement', async () => {
        const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.sharing-catalog', contributes: {
                agents: [{ id: 'assistant', title: 'External Agent', primary: 'executionRuns', runtime: { kind: 'custom' },
                    capabilities: { executionRuns: { open: ['create'], stop: true, checkpoint: false } } }],
            } }), files: {
                'daemon.mjs': `export function createAgent() { throw new Error('Sharing settings must not execute an Agent'); }
                    export function activate(api) { api.agents.register('assistant', createAgent); }`,
            } }],
        });
        const services = createCliSettingsCatalogServices({});
        try {
            expect(readCurrentContributionRegistry().agentDefinitionsById.has('acme.sharing-catalog/assistant')).toBe(true);
            const settings = accountSettingsParse({ connectedServicesProviderStateSharingSettingsV1: {
                v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
            } }).connectedServicesProviderStateSharingSettingsV1;
            expect(services.readProviderStateSharingRiskAgentIds()).toContain('codex');
            for (const prepare of [
                () => prepareAgentProviderStateSharingChangeV1(settings, { agentId: 'codex', stateMode: 'shared' }, services),
                () => prepareDefaultProviderStateSharingChangeV1(settings, true, services),
            ]) {
                const consent = await prepare();
                expect(consent).toMatchObject({ status: 'confirmation_required', agentIds: expect.arrayContaining(['codex']) });
            }
            const admittedServices = { ...services, confirmProviderStateSharingRiskAgents: async () => true };
            const agent = await prepareAgentProviderStateSharingChangeV1(settings, { agentId: 'codex', stateMode: 'shared' }, admittedServices);
            const defaults = await prepareDefaultProviderStateSharingChangeV1(settings, true, admittedServices);
            expect(agent.status).toBe('prepared');
            expect(defaults.status).toBe('prepared');
            if (agent.status !== 'prepared' || defaults.status !== 'prepared') throw new Error('Sharing intent unavailable');
            expect(agent.mutate(settings)?.byAgentId.codex?.stateMode).toBe('shared');
            expect(defaults.mutate(settings)?.defaults.stateMode).toBe('shared');
            await admitted.dispose();
            expect(services.readProviderStateSharingRiskAgentIds()).toBeNull();
            expect(agent.mutate(settings)).toBeNull();
            expect(defaults.mutate(settings)).toBeNull();
        } finally {
            await admitted.dispose();
        }
    });
    it('uses the selected remote routing tuple and refuses its captured proof after a real projection generation change', async () => {
        const owner = createVoiceSettingsOwner({ bundledContributions: [] });
        const settings = { ...accountSettingsParse({}), voice: {
            ...owner.voiceSettingsDefaults, executionMachine: { mode: 'fixed' as const, machineId: 'remote-computer' },
        } };
        let generation = 7;
        const services = createCliSettingsCatalogServices({ credentials: { token: 'fixture', encryption: null },
            serverId: 'server', expectedAccountId: 'account', voiceOwner: owner,
            // The machine RPC is the external boundary; projection parsing and selection remain real.
            readMachineAgentProjection: async machineId => machineId === 'remote-computer'
                ? PluginProjectionV2Schema.parse({ v: 2, generation, familiesById: {}, agentsById: {
                    remote: { id: 'remote-routing-id', identity: { pluginId: 'acme.agent', localId: 'remote' }, isBuiltIn: false },
                } }) : null,
        });
        const catalog = await services.readAgentCatalog!(settings);
        expect(catalog?.entries).toEqual([{ agentId: 'remote-routing-id', backendTargetKey: 'agent:acme.agent/remote',
            identity: { pluginId: 'acme.agent', localId: 'remote' }, projectionGeneration: 7, isBuiltIn: false, enabled: true }]);
        expect(catalog?.isCurrent({ ...settings, voice: { ...settings.voice,
            executionMachine: { mode: 'fixed', machineId: 'other-computer' } } })).toBe(false);
        expect(await services.isCurrent()).toBe(true);
        generation = 8;
        expect(await services.isCurrent()).toBe(false);
        expect(await services.readAgentCatalog!({ ...settings, voice: { ...settings.voice,
            executionMachine: { mode: 'auto', machineId: null } } })).toBeNull();
    });
});
