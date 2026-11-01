import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, deriveSessionCreationTagV1, formatQualifiedPluginActionId } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader } from './createCommittedContributedActionDeps';
import { executeContributedAction } from './executeContributedAction';

// Account credentials and HTTP/Machine transport are system boundaries. The
// bundled declaration, activation, dispatcher and Session-send owners stay real.
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: async () => ({ token: 'claude-parity-fixture', encryption: null }),
}));

// Source tests consume the current source through the workspace resolver;
// repository dependency publication is not part of Action admission.
vi.mock('@/subprocess/sourceDevSharedDepsPreflight', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/subprocess/sourceDevSharedDepsPreflight')>(),
    prepareSourceDevSharedDepsForBundledPluginRuntimeLoad: async () => ({
        type: 'ready' as const, checked: false, reason: 'not-source-dev' as const,
    }),
}));

const pluginId = 'happier.agent.claude';
const sessionId = 'c123456789012345678901234';
const machineId = 'claude-parity-machine';

afterEach(() => vi.unstubAllEnvs());

describe('Claude native team Action surface parity', () => {
    it.each(['cli', 'mcp'] as const)('discovers and invokes both existing Session launch handlers on %s', async (surface) => {
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
        const home = fastify();
        const origin = 'http://claude-parity-home.test';
        const session = createSessionRecordFixture({
            id: sessionId, active: true, encryptionMode: 'plain',
            metadata: JSON.stringify({ sessionCreationCorrespondenceV1: {
                v: 1,
                sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'claude-parity' }),
                recipe: {
                    execution: { machineId, directory: { kind: 'path', path: '/workspace' } },
                    organization: { folderId: null, tagIds: [] },
                    agentTarget: { kind: 'agent', identity: { pluginId, localId: 'claude' } },
                    modelSelection: null, profileId: null, requestedPermissionMode: null,
                    agentModeId: null, configuration: null, connectedServices: null,
                    capabilitySelection: null, transcriptStorage: null, terminal: null,
                    agentSessionStartupInstructionsMarkerV1: null, checkout: null,
                },
            } }),
        });
        home.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        home.get(`/v2/sessions/${sessionId}`, async () => ({ session }));
        const restoreHttp = installAxiosFastifyAdapter({ app: home, origin });
        const admissions: unknown[] = [];
        let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        try {
            const bundled = loadCurrentBundledPluginLocatorResult();
            // Source admission consumes the authored manifest through the real
            // normalizer. Bundled projection drift has its own canonical gate.
            // Unrelated app-preseed UI artifacts are outside this Action seam.
            const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: { loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.pluginId === pluginId)
                    .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) })), diagnosticsByPluginId: {} },
                provenance: 'first_party',
            }));
            fixture = await runWithServerHttpBaseUrl(origin, () => createAdmittedPluginRuntimeFixture({
                runtimeOptions: {
                    contributes,
                    pluginIds: [pluginId], resolveCurrentMachineId: () => machineId,
                    machineAdmissionTransport: async (request) => {
                        admissions.push(request);
                        return { status: 'accepted', localId: request.localId };
                    },
                },
            }));
            const runtime = fixture;
            const list = createCommittedContributedActionDefinitionLister({
                tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: runtime.controller }),
            });
            const executor = createActionExecutor({
                ...createUnavailableActionTransportDeps(), listContributedActionDefinitions: list,
                readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
                invokeContributedAction: createCommittedContributedActionInvoker({
                    acquireRuntimeRegistryLease: () => runtime.controller.acquireRuntimeRegistry(),
                }),
            });
            const cases = [{ localId: 'subagent-team-launch', input: { teamId: 'parity', description: 'Parity fixture' } }, {
                localId: 'subagent-member-launch', input: { teamId: 'parity', memberLabel: 'reader', instructions: 'Inspect the fixture' },
            }];
            for (const { localId, input } of cases) {
                const result = await runWithServerHttpBaseUrl(origin, () => executor.execute('action.invoke', {
                    action: { pluginId, localId }, input,
                }, { surface, defaultSessionId: sessionId }));
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'accepted', localId: expect.any(String) } });
                const id = formatQualifiedPluginActionId({ pluginId, localId });
                expect(await executor.execute('action.spec.search', { query: id }, { surface }))
                    .toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([expect.objectContaining({ id })]) } });
                expect(await executor.execute('action.spec.get', { id }, { surface }))
                    .toMatchObject({ ok: true, result: { actionSpec: { id, surfaces: expect.objectContaining({ cli: true, mcp: true, agent: true, ui: true }) } } });
            }
            expect(admissions).toHaveLength(2);
            expect(admissions).toEqual(expect.arrayContaining([
                expect.objectContaining({ sessionId, targetMachineId: machineId }),
            ]));
            // An advertised host surface must not open a plugin-to-plugin path.
            expect(await executeContributedAction({ runtimeRegistry: runtime.registry,
                actionId: `${pluginId}/subagent-team-launch`, input: { teamId: 'forbidden' },
                context: { surface: 'cli', invocationSurface: 'plugin', defaultSessionId: sessionId },
            })).toMatchObject({ matched: true, result: { ok: false, errorCode: 'plugin_action_unavailable', actionHandlerInvocation: 'notStarted' } });
            expect(await executor.execute('action.invoke', {
                action: { pluginId, localId: 'subagent-team-launch' }, input: { teamId: 'unbound' },
            }, { surface })).toMatchObject({ ok: false, errorCode: 'plugin_action_session_required' });
            expect(admissions).toHaveLength(2);
        } finally {
            await fixture?.dispose();
            restoreHttp();
            await home.close();
        }
    }, 60_000);
});
