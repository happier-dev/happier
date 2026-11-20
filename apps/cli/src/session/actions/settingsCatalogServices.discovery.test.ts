import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { writeTextFileSync } from '@/testkit/fs/fileHelpers';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { accountSettingsParse, isBackendTargetDisabledByAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { ScmDiffSummaryModelCatalogObservationV1Schema, resolveScmDiffSummaryDefaultModelProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resetAgentModelsProbeCacheForTests } from '@/capabilities/probes/agentModelsProbe';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, isCustomAcpAgentContributionIdentityV1, listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { NO_TEAM_CAPABILITIES_V1, resolveTeamAdmissionProjectionV1, TeamsPageV1Schema } from '@happier-dev/protocol/teams';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { ProviderBrokerApplicationBindingV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

// This fixture activates the real native plugins. Load their source modules
// during collection so Vite's cold compilation is outside runtime admission.
import '@happier-dev/plugins-codex';
import '@happier-dev/plugins-claude';
import '@happier-dev/plugins-custom-acp';
import '@happier-dev/plugins-cliproxyapi';

async function createNativeCatalog() {
        const home = createTempDirSync('summary-native-discovery-');
        const modelFile = join(home, 'models.json');
        const signInFile = join(home, 'signed-in');
        const modelReadsFile = join(home, 'model-reads');
        writeTextFileSync(signInFile, 'yes');
        writeTextFileSync(modelReadsFile, '0');
        writeTextFileSync(modelFile, JSON.stringify([{ id: 'initial-model', displayName: 'Initial model', isDefault: true }]));
        const script = writeAcpTestAgentScript({ dir: home, fileName: 'native-catalog.cjs', source: `
            if (process.argv[2] === 'login') process.exit(require('node:fs').readFileSync(${JSON.stringify(signInFile)}, 'utf8') === 'yes' ? 0 : 1);
            if (process.argv[2] === '--version') { console.log('codex-cli 1.0.0'); process.exit(0); }
            let buffer = '';
            process.stdin.on('data', chunk => {
                buffer += chunk.toString(); const lines = buffer.split('\\n'); buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const request = JSON.parse(line);
                    if (request.id === undefined) continue;
                    if (request.method === 'model/list') {
                        const fs = require('node:fs');
                        fs.writeFileSync(${JSON.stringify(modelReadsFile)}, String(Number(fs.readFileSync(${JSON.stringify(modelReadsFile)}, 'utf8')) + 1));
                    }
                    const result = request.method === 'model/list'
                        ? { data: JSON.parse(require('node:fs').readFileSync(${JSON.stringify(modelFile)}, 'utf8')) }
                        : request.method === 'collaborationMode/list' ? { data: [] } : {};
                    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
                }
            });
        ` });
        const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
        const executable = writeExecutableShimSync({ dir: home, fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
            contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
                : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n` });
        for (const key of ['HOME', 'USERPROFILE', 'HAPPIER_HOME_DIR']) vi.stubEnv(key, home);
        vi.stubEnv('HAPPIER_CODEX_PATH', executable);
        const claudeExecutable = writeExecutableShimSync({ dir: home, fileName: process.platform === 'win32' ? 'claude.cmd' : 'claude',
            contents: process.platform === 'win32'
                ? '@echo off\r\nif defined ANTHROPIC_API_KEY (echo {"loggedIn":true}& exit /b 0)\r\necho {"loggedIn":false}\r\nexit /b 1\r\n'
                : '#!/bin/sh\nif [ -n "$ANTHROPIC_API_KEY" ]; then printf \'{"loggedIn":true}\'; exit 0; fi\nprintf \'{"loggedIn":false}\'\nexit 1\n' });
        vi.stubEnv('HAPPIER_CLAUDE_PATH', claudeExecutable);
        vi.stubEnv('CLAUDE_CONFIG_DIR', home);
        for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) vi.stubEnv(key, undefined);
        vi.stubEnv('PATH', `${home}${delimiter}${process.env.PATH ?? ''}`);
        const previous = getActiveAccountSettingsSnapshot();
        let purposeAvailable = true;
        let teamMember = false;
        let teamModelSupportsStructuredOutput = true;
        let personalAvailable = true;
        let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        const dispose = async () => {
            await admitted?.dispose();
            resetAgentModelsProbeCacheForTests();
            vi.restoreAllMocks();
            if (previous) setActiveAccountSettingsSnapshot(previous); else clearActiveAccountSettingsSnapshot();
            vi.unstubAllEnvs(); removeTempDirSync(home);
        };
        try {
            admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.claude', 'happier.agent.custom-acp', 'happier.provider.cliproxyapi'],
                // Account persistence is the real external boundary; an empty
                // record lets native plugin Settings resolve without live credentials.
                accountSettingsRecordAdapter: { bindOperation: async () => ({
                    readRecord: async () => ({ status: 'absent' }), writeRecord: async () => ({ status: 'unavailable' }),
                }) },
            } });
            resetAgentModelsProbeCacheForTests();
            expect([...readCurrentContributionRegistry().agentDefinitionsById.values()].some(entry => isCustomAcpAgentContributionIdentityV1(entry.identity)),
                JSON.stringify({ agents: [...readCurrentContributionRegistry().agentDefinitionsById.values()].map(entry => ({ id: entry.id, identity: entry.identity })),
                    diagnostics: admitted.registry.pluginDiagnosticsByPluginId['happier.agent.custom-acp'] })).toBe(true);
            const configuredTargetKey = buildBackendTargetKeyV2(listAgentExecutionTargetsV1(CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, ['missing-configured-agent'])[0]!);
            const rawSettings = { backendEnabledByTargetKey: { ...Object.fromEntries(
                [...readCurrentContributionRegistry().agentDefinitionsById.values()].flatMap(entry => entry.identity
                    ? listAgentExecutionTargetsV1(entry.identity).map(target => [buildBackendTargetKeyV2(target), entry.id === 'codex' || entry.id === 'claude']) : [])),
                [configuredTargetKey]: true } };
            const settings = accountSettingsParse(rawSettings);
            expect(isBackendTargetDisabledByAccountSettings(settings, configuredTargetKey)).toBe(false);
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'native-summary-account', tokenEpoch: 0 })).toString('base64url')}.signature`,
                encryption: null, credentialProvenance: 'stored_session' as const };
            const acpCatalog = { status: 'ready' as const, revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
                id: 'missing-configured-agent', name: 'missing-configured-agent', title: 'Missing Agent',
                launch: { kind: 'command' as const, command: join(home, 'absent-agent'), args: [] }, env: {},
                capabilities: { supportsLoadSession: false, supportsModes: 'unknown' as const, supportsModels: 'yes' as const,
                    supportsConfigOptions: 'unknown' as const, promptImageSupport: 'no' as const }, createdAt: 1, updatedAt: 1,
            }] }) };
            setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings, settingsVersion: 1,
                scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1, settingsSecretsReadKeys: [], acpCatalog });
            // Exercise the actual CLI factory: it creates invocation Account custody
            // from bootstrap, rather than a test-created operation context.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: rawSettings } } };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                    settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'native-summary-account',
                    connectedAccountsV4: (personalAvailable ? ['claude-one', 'claude-two'] : []).map(accountId => ({
                        ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId },
                        status: 'connected', authenticationModeId: 'oauth', configurationReady: true,
                        configurationRevision: null, kind: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_' + 'a'.repeat(22),
                    })),
                }) };
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 1,
                    content: { t: 'plain', v: acpCatalog.record } } };
                if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) {
                    if (!purposeAvailable) throw new Error('Fixture Account metadata is unavailable');
                    return { status: 200, data: { status: 'present', revision: 1,
                        content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') } } };
                }
                if (path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
                return { status: 404, data: {} };
            });
            const teamsRead = bindHomeDomainActionHttpRequestV1('teams.list', { v: 1, scope: 'member', archived: 'active' });
            const resourcesRead = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'team' });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const path = new URL(String(request.url)).pathname;
                if (path === teamsRead.path.split('?')[0]) return { status: 200, data: TeamsPageV1Schema.parse({ items: teamMember ? [{
                    id: 'team', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
                    policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
                        defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null },
                    viewerRole: 'member', capabilities: NO_TEAM_CAPABILITIES_V1,
                    admission: resolveTeamAdmissionProjectionV1(), counts: null,
                }] : [], nextCursor: null }) };
                if (path === resourcesRead.path.split('?')[0]) {
                    const application = ProviderBrokerApplicationBindingV1Schema.parse(request.data?.application);
                    expect(request.data?.executionMachineId).toBe('native-model-machine');
                    const resources = teamMember && application.agentTargetKey === 'agent:happier.agent.codex/codex'
                        && application.protocol === 'openai-responses' ? [TeamCredentialResourceCatalogEntryV1Schema.parse({
                            id: 'team-resource', teamId: 'team', resourceRevision: 7,
                            displayName: projectPrivateLabelForRecipientV1({
                                stored: sealPrivateLabelV1({ mode: 'plain', value: 'Shared model',
                                    binding: { entity: 'team_credential_resource', field: 'displayName', id: 'team-resource' } }),
                                recipientAccountId: 'native-summary-account',
                            }),
                            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
                            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
                            sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                            providerModels: [{ selection: { kind: 'team_credential_provider_model', resourceId: 'team-resource',
                                teamId: 'team', expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: application.agentTargetKey, modelId: 'gpt-5.6-luna' },
                                descriptor: { id: 'gpt-5.6-luna', name: 'Luna',
                                    ...(teamModelSupportsStructuredOutput ? { capabilities: { structuredOutput: 'supported' } } : {}) },
                                sourceRevision: 'source-7', availability: 'available', application,
                                sourceFacts: { endpoint: { id: application.endpointTemplateId, protocol: application.protocol,
                                    capabilities: { streaming: 'supported', toolRoundTrips: 'supported',
                                        statefulResponses: 'supported', reasoningControls: 'supported' } } },
                            }],
                        })] : [];
                    return { status: 200, data: { resources, nextCursor: null } };
                }
                throw new Error(`Unexpected fixture Action request: ${path}`);
            });
            const executor = createCliActionExecutorFromCredentials({ credentials,
                pluginActionExecutionOwner: 'current_process',
                machineActionDirectTargetTransport: { machineId: 'native-model-machine', invoke: async () => { throw new Error('Unexpected recursion'); } } });
            const observe = async (discoveryTargetKey?: string, modelSelector?: { backendTargetKey: string; modelId: string }) => {
                const result = await executor.execute('agents.models.list', { purpose: 'scm_diff_summary', machineId: 'native-model-machine',
                    ...(discoveryTargetKey ? { discoveryTargetKey } : {}), ...(modelSelector ? { modelSelector } : {}) }, { surface: 'cli', authority: 'present_user' });
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                if (!result.ok || !result.result || typeof result.result !== 'object' || !('scmDiffSummaryCatalog' in result.result)) throw new Error('Missing native catalog');
                return ScmDiffSummaryModelCatalogObservationV1Schema.parse(result.result.scmDiffSummaryCatalog);
            };
            return { executor, observe, configuredTargetKey,
                setNativeSignIn: (signedIn: boolean) => writeTextFileSync(signInFile, signedIn ? 'yes' : 'no'),
                setTeamMember: (member: boolean) => { teamMember = member; },
                setTeamModelStructuredOutput: (supported: boolean) => { teamModelSupportsStructuredOutput = supported; },
                setPersonalAvailable: (available: boolean) => { personalAvailable = available; },
                modelReads: () => Number(readFileSync(modelReadsFile, 'utf8')),
                writeModels: (modelId: string) => writeTextFileSync(modelFile, JSON.stringify([{ id: modelId, displayName: modelId, isDefault: true }])),
                disablePurposeMetadata: () => { purposeAvailable = false; }, dispose };
        } catch (error) {
            await dispose();
            throw error;
        }
}

describe('Summary native model discovery', () => {
    let catalog: Awaited<ReturnType<typeof createNativeCatalog>>;
    beforeAll(async () => { catalog = await createNativeCatalog(); });
    afterAll(async () => { await catalog?.dispose(); });

    it('offers dynamic explicit Codex models without native sign-in or an Account default, through the picker catalog', async () => {
            const targetKey = 'agent:happier.agent.codex/codex';
            catalog.setNativeSignIn(false);
            try {
                const observed = await catalog.observe();
                expect(observed.profiles).toEqual(expect.arrayContaining([expect.objectContaining({
                    modelSelector: { backendTargetKey: targetKey, modelId: 'initial-model' }, structuredOutput: 'supported',
                })]));
                expect(observed.automaticProfiles.some(profile => profile.modelSelector?.backendTargetKey === targetKey)).toBe(false);
                expect(observed.unavailableTargets).toContainEqual({ backendTargetKey: targetKey, reason: 'native_sign_in_required' });
                const reads = catalog.modelReads();
                expect(reads).toBe(1);
                expect((await catalog.observe()).profiles).toEqual(observed.profiles);
                expect(catalog.modelReads()).toBe(reads);
            } finally { catalog.setNativeSignIn(true); }
    });

    it('offers a runnable Claude model with a personal connection and no purpose default', async () => {
            const { executor, observe } = catalog;
            const connections = await executor.execute('sessions.spawn.connected_services.list', { agentId: 'claude', includeUnavailable: false },
                { surface: 'cli', authority: 'present_user' });
            expect(connections).toMatchObject({ ok: true, result: { profileOptionsByServiceId: {
                'happier.agent.claude/claude-subscription': [
                    expect.objectContaining({ profileId: 'claude-one', status: 'connected' }),
                    expect.objectContaining({ profileId: 'claude-two', status: 'connected' }),
                ],
            } } });
            if (connections.ok) expect(connections.result).not.toHaveProperty('defaultBindings');
            const initial = await observe();
            const claudeTargetKey = 'agent:happier.agent.claude/claude';
            expect(initial.unavailableTargets?.some(target => target.backendTargetKey === claudeTargetKey)).toBeFalsy();
            expect(initial.discoveryTargetKeys).toContain(claudeTargetKey);
            const explicitClaude = initial.profiles.find(profile => profile.modelSelector?.backendTargetKey === claudeTargetKey
                && profile.structuredOutput === 'supported');
            expect(explicitClaude).toBeDefined();
            expect(initial.automaticProfiles).toContainEqual(expect.objectContaining({ modelSelector: expect.objectContaining({
                backendTargetKey: claudeTargetKey,
                connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': {
                    source: 'connected', selection: 'profile', profileId: 'claude-one',
                } } },
            }) }));
    });

    it.each(['discovery', 'selection'] as const)('keeps explicit Claude %s independent from automatic ranking', async mode => {
            const { observe } = catalog;
            const targetKey = 'agent:happier.agent.claude/claude';
            const initial = await observe();
            const explicit = initial.profiles.find(profile => profile.modelSelector?.backendTargetKey === targetKey
                && profile.structuredOutput === 'supported');
            expect(explicit).toBeDefined();
            const result = mode === 'discovery' ? await observe(targetKey)
                : await observe(undefined, { backendTargetKey: targetKey, modelId: explicit!.modelSelector!.modelId! });
            expect(result.profiles).toContainEqual(explicit);
            expect(result.automaticProfiles).toEqual(initial.automaticProfiles);
    });

    it('returns a brokered runner only while the requesting Account is entitled to the Team model', async () => {
        const { executor, observe, setNativeSignIn, setPersonalAvailable, setTeamMember, setTeamModelStructuredOutput } = catalog;
        const resolve = () => executor.execute('agents.models.list', { purpose: 'llm_task_runner', task: 'deploy_suggestion',
            machineId: 'native-model-machine' }, { surface: 'cli', authority: 'present_user' });
        setNativeSignIn(false);
        setPersonalAvailable(false);
        try {
            expect(await resolve()).toMatchObject({ ok: true, result: { llmTaskRunner: { ok: false, reason: 'no_ready_agent' } } });
            setTeamMember(true);
            expect(await resolve()).toMatchObject({ ok: true, result: { llmTaskRunner: { ok: true, source: 'auto', runner: {
                modelSelection: { source: 'team_resource', teamId: 'team', resourceId: 'team-resource',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', modelId: 'gpt-5.6-luna' },
            } } } });
            const readTeamModel = async () => (await observe()).automaticProfiles?.find(profile =>
                profile.modelSelector?.modelSelection?.source === 'team_resource');
            expect(await readTeamModel()).toMatchObject({ structuredOutput: 'supported' });
            setTeamModelStructuredOutput(false);
            expect(await readTeamModel()).toMatchObject({ structuredOutput: 'unknown' });
            setTeamMember(false);
            expect(await resolve()).toMatchObject({ ok: true, result: { llmTaskRunner: { ok: false, reason: 'no_ready_agent' } } });
        } finally {
            setNativeSignIn(true);
            setPersonalAvailable(true);
            setTeamMember(false);
            setTeamModelStructuredOutput(true);
        }
    });

    it('refreshes a native model through the public Action without changing Auto', async () => {
            const { observe, configuredTargetKey, writeModels } = catalog;
            const initial = await observe();
            expect(initial).toMatchObject({ probeFailures: [{ backendTargetKey: configuredTargetKey,
                spawnFailure: { reason: 'other', errno: 'ENOENT' } }] });
            expect(JSON.stringify(initial)).not.toContain('absent-agent');
            expect(initial.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ modelSelector: {
                backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'initial-model' }, structuredOutput: 'supported' })]));
            writeModels('discovered-model');
            expect((await observe()).profiles).toEqual(initial.profiles);
            const discovered = await observe('agent:happier.agent.codex/codex');
            expect(discovered.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ modelSelector: {
                backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'discovered-model' }, structuredOutput: 'supported' })]));
            expect(discovered.automaticProfiles).toEqual(initial.automaticProfiles);
    });

    it('keeps automatic admission at the native sign-in and Account metadata owners', async () => {
            const { observe, disablePurposeMetadata } = catalog;
            const claudeTargetKey = 'agent:happier.agent.claude/claude';
            // Authentication changes at the native boundary make the same real
            // catalog executable; authored cost evidence survives the strict DTO.
            vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-api-key');
            const signedIn = await observe();
            expect(signedIn).not.toHaveProperty('unavailableTargets');
            expect(resolveScmDiffSummaryDefaultModelProfile(signedIn.automaticProfiles)).toMatchObject({
                costTier: 'low', structuredOutput: 'supported', modelSelector: { backendTargetKey: claudeTargetKey },
            });
            disablePurposeMetadata();
            const metadataUnavailable = await observe();
            expect(metadataUnavailable).toMatchObject({ unavailableReason: 'account_metadata_unavailable',
                unavailableTargets: expect.arrayContaining([{ backendTargetKey: claudeTargetKey, reason: 'account_metadata_unavailable' }]),
            });
    });
});

