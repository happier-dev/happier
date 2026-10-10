import { unexpectedProjectNativeAdapterResolution } from "@/plugins/testkit/unexpectedProjectNativeAdapterResolution";
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema, PluginManagedDependencyContributionV2Schema, projectMachineAgentsDetectResponse } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as ANTIGRAVITY_MANIFEST } from '@happier-dev/plugins-antigravity/manifest';
import { PLUGIN_MANIFEST as CODEX_MANIFEST } from '@happier-dev/plugins-codex/manifest';

import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { projectBuiltInAgents } from '@/plugins/projection/registry/builtIn/agents';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { detectCliSnapshotOnDaemonPath } from './cliSnapshot';

afterEach(() => vi.unstubAllEnvs());

describe('machine agent inventory on the daemon', () => {
    beforeAll(async () => {
        const manifests = [ANTIGRAVITY_MANIFEST, CODEX_MANIFEST].map((manifest) => PluginManifestV2Schema.parse(manifest));
        const agents = projectBuiltInAgents({
            manifestAgents: manifests.flatMap((manifest) => manifest.contributes.agents.map((definition) => ({
                ...projectManifestAgentContribution({
                    definition, pluginId: manifest.id, provenance: 'first_party', source: { kind: 'bundled' },
                    systemTools: manifest.contributes.systemTools,
                }),
                hostAccess: manifest.hostAccess,
            }))),
            registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter((binding) => manifests.some((manifest) => binding.identity.pluginId === manifest.id)),
        });
        const registry = {
            contributes: createResolvedContributionRegistry({
                agents, activationTargets: [],
                managedDependencies: manifests.flatMap((manifest) => manifest.contributes.managedDependencies.map((definition) => ({
                    pluginId: manifest.id, definition, provenance: 'first_party', source: { kind: 'bundled' },
                    manifestPath: join(process.cwd(), `../../packages/plugins/${manifest.id === ANTIGRAVITY_MANIFEST.id ? 'antigravity' : 'codex'}/src/manifest.ts`),
                }))),
            }),
            hookHandlersByHookId: new Map(), agentRuntimesByAgentId: new Map(), scmHostingProvidersById: new Map(),
            pluginDiagnosticsByPluginId: {}, activatedPluginIds: new Set<string>(),
            activateContributionsOnDemand: async () => [], resolvePromptAssetBlocks: async () => [],
            createAgentInvocationServices: async () => { throw new Error('No plugin invocation in this inventory fixture'); },
            resolveCaptureSource: async () => null,
            resolveProjectNativeAdapter: unexpectedProjectNativeAdapterResolution,
            retireConsumers: () => {}, dispose: async () => {},
        } satisfies ResolvedExecutablePluginRuntimeRegistry;
        await pluginReloadController.adoptPreparedRuntimeRegistry({
            registry, changedPluginIds: [], isDevelopmentCandidateCurrent: () => true,
            runningSessionDisposition: 'retainRunningSessions',
        });
    });
    afterAll(async () => { await pluginReloadController.shutdown(); });

    it('reports the installed ACP dependency separately when the Antigravity CLI is missing', async () => {
        const fixture = await createProbeTempDir('happier-agent-inventory');
        try {
            vi.stubEnv('HAPPIER_HOME_DIR', fixture.dir);
            vi.stubEnv('HOME', fixture.dir);
            vi.stubEnv('USERPROFILE', fixture.dir);
            vi.stubEnv('PATH', '');
            vi.stubEnv('HAPPIER_ANTIGRAVITY_PATH', join(fixture.dir, 'missing-agy'));
            const contribution = readCurrentContributionRegistry().managedDependencies?.find((entry) => (
                entry.pluginId === 'happier.agent.antigravity' && entry.definition.id === 'agy-acp-server'
            ));
            expect(contribution).toBeDefined();
            const definition = PluginManagedDependencyContributionV2Schema.parse(contribution?.definition);
            const source = definition.sources.find((entry) => entry.kind === 'pinnedArchive');
            if (!source || source.kind !== 'pinnedArchive') throw new Error('Missing pinned fixture source');
            const asset = Object.entries(source.assetsByPlatform).find(([key]) => key === `${process.platform}-${process.arch}`)?.[1];
            if (!asset) throw new Error('Inventory fixture requires a supported Antigravity host');
            const root = join(fixture.dir, 'tools', source.installId, 'current');
            await mkdir(root, { recursive: true });
            const binary = '#!/bin/sh\necho 1.1.1\n';
            await writeExecutableScript(join(root, asset.executableSubpath), binary);
            await writeFile(join(root, '.happier-managed-version'), source.version);
            await writeFile(join(root, '.happier-managed-executable-sha256'), `sha256:${createHash('sha256').update(binary).digest('hex')}`);
            const snapshot = await detectCliSnapshotOnDaemonPath({ requestedCliNames: ['antigravity'], includeLoginStatus: true, bypassCache: true });
            const data = buildCliCapabilityData({
                request: { id: 'cli.antigravity', params: { includeLoginStatus: true } }, entry: snapshot.clis.antigravity,
            });
            const inventory = projectMachineAgentsDetectResponse({
                agents: [{ agentId: 'antigravity', title: 'Antigravity' }],
                response: { protocolVersion: 1, results: { 'cli.antigravity': { ok: true, data } } },
            });
            expect(inventory.items[0]).toMatchObject({
                installed: false,
                update: { supported: false, command: null },
                dependencies: [{ key: source.installId, installed: true, version: source.version }],
                platform: { supported: true },
                install: { available: true, mode: 'vendor_recipe' },
                signIn: { status: 'unknown', loginSupport: 'login_terminal' },
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it('refreshes native sign-in when a manifest-declared credential changes', async () => {
        const fixture = await createProbeTempDir('happier-agent-inventory-auth');
        try {
            vi.stubEnv('HAPPIER_HOME_DIR', fixture.dir);
            vi.stubEnv('HOME', fixture.dir);
            vi.stubEnv('USERPROFILE', fixture.dir);
            vi.stubEnv('PATH', '');
            vi.stubEnv('CODEX_API_KEY', '');
            vi.stubEnv('OPENAI_API_KEY', '');
            const cliPath = join(fixture.dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
            await writeExecutableScript(cliPath, process.platform === 'win32' ? '@echo off\r\necho 1.2.3\r\n' : '#!/bin/sh\necho 1.2.3\n');
            vi.stubEnv('HAPPIER_CODEX_PATH', cliPath);
            const request = { requestedCliNames: ['codex'], includeLoginStatus: true };
            const before = await detectCliSnapshotOnDaemonPath(request);
            expect(before.clis.codex).toMatchObject({ installed: true, signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, dependencies: [] });
            vi.stubEnv('CODEX_API_KEY', 'fixture-key');
            const after = await detectCliSnapshotOnDaemonPath(request);
            expect(after.clis.codex).toMatchObject({ installed: true, signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, dependencies: [] });
        } finally {
            await fixture.cleanup();
        }
    });
});
