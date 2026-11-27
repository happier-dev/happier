import { readIndexedBundledDeclarationManifest } from '../../plugins/projection/registry/builtIn/declarationAssetFormat.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, realpath, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createBoundedAgentExternalSessionsContribution } from './agentExternalSessionsInvocation';
import { loadRetainedAgentRuntimeLeaf } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { coldConnectedHome } from './configuredSourceMaterializer.coldCatalog.testkit';
import { resolveConfiguredExternalSessionFollowTarget, resolveConfiguredExternalSessionSourceAtAdmission } from './configuredSourceMaterializer';

afterEach(() => vi.unstubAllEnvs());

async function retainedConnectedHome() {
    const bundled = ingestPluginManifestV2(readIndexedBundledDeclarationManifest(new URL('../../../assets/bundled-plugin-manifests/codex.json', import.meta.url)));
    if (!bundled.ok) throw new Error('Expected the canonical source declaration');
    const declaration = bundled.manifest.contributes.agents[0]?.surfaces?.externalSession?.sources[0];
    if (!declaration) throw new Error('Expected the canonical connected-home source');
    const pluginId = 'acme.retained-follow';
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        coldStart: true,
        plugins: [{
            // Both follow and connected profiles are in the bytes admitted to
            // the immutable generation, before any retained binding is minted.
            manifest: createPluginManifestV2Fixture({ id: pluginId,
                runtime: { apiVersion: 1, agentFactories: [{ localAgentId: 'fixture',
                    locator: { module: './factory', export: 'createFixtureAgentRuntime', runtimeApiVersion: 1,
                        externalSessionsExport: 'externalSessions' },
                    normalizedModulePath: 'factory.mjs', loadMode: 'immutable-js',
                }] },
                hostAccess: { required: [{ id: 'fixture-home', capability: 'environment',
                    reason: 'Read the fixture native home.', scope: { keys: ['CODEX_HOME'] } }], optional: [] },
                contributes: {
                    agents: [{ id: 'fixture', title: 'Retained follow fixture', runtime: { kind: 'custom' }, primary: 'sessions',
                        capabilities: { surfaces: ['externalSessions'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                        connectedAccounts: [{ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                            purpose: 'model_upstream', required: false,
                            credentialKinds: ['oauth'], materializationKinds: ['files'] }],
                        surfaces: { externalSession: { sources: [{ ...declaration,
                            terminalFollow: { userRowClassification: 'explicitV1' },
                        }] } },
                    }],
                },
            }),
            files: {
                'factory.mjs': [
                    'import { readFile } from "node:fs/promises";',
                    'import { join } from "node:path";',
                    'export function createFixtureAgentRuntime() { return { sessions: {} }; }',
                    'export const externalSessions = {',
                    '  async resolveSource({ source }) { return { ok: true, value: { source } }; },',
                    '  async listCandidates() { return { ok: true, value: { candidates: [], nextCursor: null } }; },',
                    '  async resolveLinkIdentity({ source, remoteSessionId }) {',
                    '    const text = await readFile(join(source.homePath, "sessions", `rollout-${remoteSessionId}.jsonl`), "utf8");',
                    '    const header = JSON.parse(text.split("\\n")[0]);',
                    '    if (header.payload.id !== remoteSessionId) throw new Error("Wrong retained transcript");',
                    '    return { ok: true, value: { source, remoteSessionId, linkData: {} } };',
                    '  },',
                    '  async resolveLinkedIdentity({ source, remoteSessionId, linkData }) { return { ok: true, value: { source, remoteSessionId, linkData } }; },',
                    '  async pageTranscript() { return { ok: true, value: { items: [], nextCursor: null } }; },',
                    '  async readAfterTranscript() { return { ok: true, value: { outcome: "already_current" } }; },',
                    '};',
                ].join('\n'),
                'daemon.mjs': [
                    'import { createFixtureAgentRuntime, externalSessions } from "./factory.mjs";',
                    'export function activate(api) {',
                    '  api.agents.register("fixture", createFixtureAgentRuntime, {',
                    '    sessionRunnerFactory: { module: "./factory", export: "createFixtureAgentRuntime", runtimeApiVersion: 1, externalSessionsExport: "externalSessions" },',
                    '    connectedAccountLaunch: { stateSharingDescriptor: {',
                    '      providerSupportStatus: "supported",',
                    '      config: { supported: true, modes: ["isolated"], entries: [] },',
                    '      state: { supported: true, modes: ["isolated"], entries: [], symlinkUnavailableDegradePolicy: "block_continuity" },',
                    '      authIsolation: { mode: "materialized_home", secretEntries: [] },',
                    '      nativeHome: { environmentKey: "CODEX_HOME", defaultRelativePath: ".codex", materializedDirectoryName: "codex-home" },',
                    '    } },',
                    '  });',
                    '  api.agents.registerExternalSessions("fixture", externalSessions);',
                    '}',
                ].join('\n'),
            },
        }],
    });
    return await coldConnectedHome({ runtime, agentId: `${pluginId}/fixture`, serviceId: 'openai-codex' });
}

describe('retained connected-home catalog convergence', () => {
    it('resolves a retained connected-home follow without borrowing the cold declaration catalog', async () => {
        const fixture = await retainedConnectedHome();
        const agentId = fixture.input.agents[0]!.id;
        const lifetime = new AbortController();
        let leaf: Awaited<ReturnType<typeof loadRetainedAgentRuntimeLeaf>> | null = null;
        try {
            const homesRoot = join(fixture.input.activeServerDir, 'daemon', 'connected-services', 'homes');
            const physicalRoot = join(fixture.runtime.happyHomeDir, 'retained-physical-homes');
            await rename(homesRoot, physicalRoot);
            await symlink(physicalRoot, homesRoot, process.platform === 'win32' ? 'junction' : 'dir');
            const physicalHome = await realpath(fixture.homePath);
            // Acquire the binding through real activation. Its immutable
            // declaration still carries no executable native-home facts.
            await fixture.resolveBoundary(agentId);
            const retained = fixture.runtime.registry.agentRuntimesByAgentId.get(agentId);
            const binding = retained?.sessionRunnerFactoryBinding;
            if (!retained || !binding) throw new Error(`Expected the real admitted runner binding: ${JSON.stringify(
                fixture.runtime.registry.pluginDiagnosticsByPluginId['acme.retained-follow'])}`);
            leaf = await loadRetainedAgentRuntimeLeaf({
                paths: resolvePluginStorePaths({ happyHomeDir: fixture.runtime.happyHomeDir }),
                binding,
            });
            if (!leaf.externalSessions) throw new Error('Expected the real retained transcript companion');
            const providerOps = createAgentExternalSessionsExecutionSurface(createBoundedAgentExternalSessionsContribution({
                contribution: leaf.externalSessions,
                identity: { pluginId: binding.pluginId, agentId: binding.agentId,
                    occurrenceId: retained.occurrenceId, sourceCustody: binding.sourceCustody,
                    contributionQualifiedId: `${binding.pluginId}/agents/${binding.localAgentId}` },
                isCurrent: () => !lifetime.signal.aborted, retirementSignal: lifetime.signal,
                createInvocationExec: async () => createUnavailablePluginServices().exec,
            }));
            if (!providerOps.validateSource || !providerOps.resolveLinkIdentity
                || !providerOps.pageTranscript || !providerOps.readAfterTranscript) {
                throw new Error('Expected the retained native transcript operations');
            }
            const catalogEntry = leaf.catalogEntry;
            // A retained Session carries the home stamped at its original
            // admission, rather than a raw Account-profile candidate.
            const admitted = await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input,
                agentId, source: fixture.source, catalogEntry });
            if (!admitted.ok) throw new Error('Expected the retained connected-home admission');
            expect(admitted.source).toMatchObject({ homePath: physicalHome });
            expect(await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input,
                agentId, source: admitted.source, catalogEntry })).toMatchObject({ ok: true, source: admitted.source });
            const target = await resolveConfiguredExternalSessionFollowTarget({ ...fixture.input,
                agentId, remoteSessionId: fixture.remoteSessionId,
                boundSource: admitted.source,
                resolveCatalogEntry: async () => catalogEntry,
                resolveProviderOps: async () => ({ ...providerOps,
                    validateSource: providerOps.validateSource!, resolveLinkIdentity: providerOps.resolveLinkIdentity!,
                    pageTranscript: providerOps.pageTranscript!, readAfterTranscript: providerOps.readAfterTranscript! }),
            });
            expect(target, JSON.stringify(target)).toMatchObject({ status: 'resolved', source: { homePath: physicalHome } });
            expect(fixture.input.agents[0]?.catalogEntry?.connectedAccountNativeHome).toBeUndefined();
            expect(await resolveConfiguredExternalSessionSourceAtAdmission({ ...fixture.input, agentId,
                source: fixture.source, catalogEntry: { ...catalogEntry!, id: 'codex' } }))
                .toEqual({ ok: false, code: 'source_invalid' });
            await expect(loadRetainedAgentRuntimeLeaf({
                paths: resolvePluginStorePaths({ happyHomeDir: fixture.runtime.happyHomeDir }),
                binding: { ...binding, pluginVersion: `${binding.pluginVersion}-foreign` },
            })).rejects.toThrow();
            await expect(loadRetainedAgentRuntimeLeaf({
                paths: resolvePluginStorePaths({ happyHomeDir: fixture.runtime.happyHomeDir }),
                binding: { ...binding, sourceCustody: { kind: 'managed',
                    immutableGenerationId: 'foreign-generation', installSource: 'localPath' } },
            })).rejects.toThrow();
        } finally {
            lifetime.abort();
            await leaf?.dispose();
            await fixture.runtime.dispose();
        }
    });
});
