import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema, PluginManagedDependencyContributionV2Schema, projectMachineAgentsDetectResponse, materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { observeCurrentAgentSessionFactory } from '@/agent/catalog/runtimeEntry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { detectCliSnapshotOnDaemonPath } from './cliSnapshot';
import { initialMachineMetadata, refreshMachineMetadataForCurrentDaemon } from '@/daemon/machine/metadata';
import { projectMachineAgentInventoryFromCliSnapshot } from './machineAgentInventory';
import { MachinePublishedMetadataV1Schema, StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { SkillRuleV1Schema } from '@happier-dev/protocol/reach/reachRuleV1';
import { projectReachForMachinesV1 } from '@happier-dev/protocol/reach/projectReachV1';
import { readInstalledMachineAgentIds } from '../../../../ui/sources/sync/domains/capabilities/reach/installedMachineAgents';
import { createWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';

function publishSnapshot(snapshot: Awaited<ReturnType<typeof detectCliSnapshotOnDaemonPath>>) {
    const current = { ...initialMachineMetadata,
        agentInventory: { checkedAt: 1, installedAgentIds: ['custom-acp', 'antigravity'] } };
    const published = refreshMachineMetadataForCurrentDaemon(current, {
        host: current.host, platform: current.platform, happyCliVersion: current.happyCliVersion,
        homeDir: current.homeDir, happyHomeDir: current.happyHomeDir, happyLibDir: current.happyLibDir,
        agentInventory: projectMachineAgentInventoryFromCliSnapshot({ snapshot, checkedAt: 2, current: current.agentInventory }),
    });
    return StoredMachinePublishedMetadataV1Schema.parse(MachinePublishedMetadataV1Schema.parse(published));
}

afterEach(() => vi.unstubAllEnvs());

describe('machine agent inventory on the daemon', () => {
    const runtimeFixtures: Array<Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>> = [];
    beforeAll(async () => {
        runtimeFixtures.push(await createAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.antigravity', 'happier.agent.codex', 'happier.agent.custom-acp'] },
        }));
    });
    afterAll(async () => {
        for (const fixture of runtimeFixtures) await fixture.lease.release();
        for (const fixture of runtimeFixtures) await fixture.dispose();
    });

    it.each([true, false])('uses the same observed Codex installation for Session and detached Workflow admission: %s', async (installed) => {
        const fixture = await createProbeTempDir('happier-workflow-agent-installation');
        try {
            vi.stubEnv('HAPPIER_HOME_DIR', fixture.dir);
            vi.stubEnv('HOME', fixture.dir);
            vi.stubEnv('USERPROFILE', fixture.dir);
            vi.stubEnv('PATH', '');
            const cliPath = join(fixture.dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
            await writeExecutableScript(cliPath, process.platform === 'win32'
                ? `@echo off\r\necho 1.2.3\r\nexit /b ${installed ? 0 : 1}\r\n`
                : `#!/bin/sh\necho 1.2.3\nexit ${installed ? 0 : 1}\n`);
            vi.stubEnv('HAPPIER_CODEX_PATH', cliPath);
            const snapshot = await detectCliSnapshotOnDaemonPath({ requestedCliNames: ['codex'], bypassCache: true });
            const response = { protocolVersion: 1, results: {
                'cli.codex': { ok: true, data: buildCliCapabilityData({ request: { id: 'cli.codex' }, entry: snapshot.clis.codex }) },
                // Native Run support is a declaration, not proof of installation.
                'tool.executionRuns': { ok: true, data: { available: true, features: { detachedScope: true }, backends: { codex: { available: true } } } },
            } };
            const inventory = projectMachineAgentsDetectResponse({ agents: [{ agentId: 'codex', title: 'Codex' }], response });
            expect(inventory.items[0]?.installed).toBe(installed);
            const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
            // The Machine RPC is the boundary; detection, strict inventory projection,
            // Workflow availability and accepted-snapshot materialization stay real.
            const host = createWorkflowMaterializationHostV1({
                credentials: { token: 'workflow-installation', encryption: null },
                readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
                callMachineAction: async ({ method }) => {
                    if (method === RPC_METHODS.CAPABILITIES_DETECT) return response;
                    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
                        protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { codex: {
                            id: 'codex', identity: agentTarget.identity,
                            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                        } } },
                    };
                    throw new Error('Unexpected Workflow Machine read');
                },
            });
            for (const kind of ['session', 'detached_run'] as const) {
                const result = await materializeWorkflowAcceptedSnapshotV1({
                    ...await host({ machineId: 'machine', directory: fixture.dir }), admission: { kind: 'user' },
                    definition: { version: 1, defaults: { agentTarget }, blocks: [{ kind: 'step', id: 'reply',
                        document: { text: 'Reply', references: [], attachments: [] } }] },
                    context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind },
                        workspaceTarget: { project: { machineId: 'machine', directory: fixture.dir, checkoutRootPath: fixture.dir } },
                        authorization: { principal: { kind: 'host' } } },
                });
                expect(result, `${kind}: ${JSON.stringify(result)}`).toMatchObject(installed ? { ok: true } : { ok: false, error: {
                    code: 'target_unavailable', reason: 'agent_not_installed', agentId: 'codex', blockId: 'reply',
                } });
            }
        } finally {
            await fixture.cleanup();
        }
    });

    it('uses the admitted parent factory observation in a requester effect instead of reacquiring daemon authority', async () => {
        const observed = await observeCurrentAgentSessionFactory('custom-acp');
        expect(observed).not.toBeNull();
        const source = { observations: { 'custom-acp': observed && {
            nativeAuthenticationRequired: observed.nativeAuthenticationRequired,
        } }, isCurrent: () => true };
        expect(await observeCurrentAgentSessionFactory('custom-acp', source)).toMatchObject({
            nativeAuthenticationRequired: observed!.nativeAuthenticationRequired,
        });
        // An admitted absence must not borrow a different factory from this
        // process, even when that process happens to host an active daemon.
        expect(await observeCurrentAgentSessionFactory('custom-acp', {
            observations: { 'custom-acp': null }, isCurrent: () => true,
        })).toBeNull();
        await expect(observeCurrentAgentSessionFactory('custom-acp', {
            observations: {}, isCurrent: () => true,
        })).rejects.toThrow('Parent factory observation is unavailable');
        const retired = await observeCurrentAgentSessionFactory('custom-acp', {
            ...source, isCurrent: () => false,
        });
        expect(retired?.isCurrent()).toBe(false);
    });

    it('keeps healthy native CLI facts when a sibling Agent has no native CLI probe', async () => {
        const fixture = await createProbeTempDir('happier-agent-inventory-sibling');
        try {
            vi.stubEnv('HAPPIER_HOME_DIR', fixture.dir);
            vi.stubEnv('HOME', fixture.dir);
            vi.stubEnv('USERPROFILE', fixture.dir);
            vi.stubEnv('PATH', '');
            const cliPath = join(fixture.dir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
            await writeExecutableScript(cliPath, process.platform === 'win32' ? '@echo off\r\necho 1.2.3\r\n' : '#!/bin/sh\necho 1.2.3\n');
            vi.stubEnv('HAPPIER_CODEX_PATH', cliPath);
            const snapshot = await detectCliSnapshotOnDaemonPath({ requestedCliNames: ['codex', 'custom-acp', 'antigravity'],
                includeLoginStatus: true, bypassCache: true });
            const data = buildCliCapabilityData({ request: { id: 'cli.codex' }, entry: snapshot.clis.codex });
            expect(projectMachineAgentsDetectResponse({
                agents: [{ agentId: 'codex', title: 'Codex' }],
                response: { protocolVersion: 1, results: { 'cli.codex': { ok: true, data } } },
            }).items).toMatchObject([{ agentId: 'codex', installed: true, version: '1.2.3' }]);
            expect(snapshot.clis['custom-acp']).toMatchObject({
                available: true, installed: true,
                signIn: { status: 'unknown', loginSupport: 'unsupported', required: false },
            });
            const publication = publishSnapshot(snapshot);
            expect(publication.agentInventory).toEqual({ checkedAt: 2,
                installedAgentIds: ['codex', 'custom-acp'] });
            // Real detection → metadata publication → strict stored reader → exact UI install reader → reach.
            const projection = projectReachForMachinesV1([SkillRuleV1Schema.parse({ id: 'on', skillId: 'skill',
                target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 })], {
                machines: [{ machineId: 'qa', platform: process.platform === 'win32' ? 'win32' : 'posix',
                    agentIds: readInstalledMachineAgentIds(publication.agentInventory, undefined) }],
            });
            expect(projection[0]?.agents.map(({ agentId, enabled }) => ({ agentId, enabled }))).toEqual([
                { agentId: 'codex', enabled: true },
            ]);
            expect(projectMachineAgentInventoryFromCliSnapshot({
                snapshot: { ...snapshot, clis: { ...snapshot.clis, codex: { available: true } } },
                checkedAt: 3, current: { checkedAt: 2, installedAgentIds: ['codex'] }, observedAgentIds: ['codex'],
            }).installedAgentIds).toEqual(['codex']);
        } finally {
            await fixture.cleanup();
        }
    });

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
            expect(publishSnapshot(snapshot).agentInventory).toEqual({ checkedAt: 2, installedAgentIds: ['custom-acp'] });
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
            // The real Codex callback probes `login status`; version success
            // must not impersonate an authenticated external executable.
            await writeExecutableScript(cliPath, process.platform === 'win32'
                ? '@echo off\r\nif "%1"=="login" exit /b 1\r\necho 1.2.3\r\n'
                : '#!/bin/sh\nif [ "$1" = "login" ]; then exit 1; fi\necho 1.2.3\n');
            const before = await detectCliSnapshotOnDaemonPath(request);
            expect(before.clis.codex).toMatchObject({ installed: true, signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, dependencies: [] });
            vi.stubEnv('CODEX_API_KEY', 'fixture-key');
            const after = await detectCliSnapshotOnDaemonPath(request);
            expect(after.clis.codex).toMatchObject({ installed: true, signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, dependencies: [] });
        } finally {
            await fixture.cleanup();
        }
    });

    it('observes the real CLI-less Session factory and never reuses its retired readiness', async () => {
        const fixtureRoot = new URL('../../../../../packages/tests/fixtures/plugin-platform/agent-runtime-conformance/', import.meta.url);
        const sourceManifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(new URL('.happier-plugin/plugin.json', fixtureRoot), 'utf8')));
        const nativeManifest = { ...sourceManifest, activation: { events: [] }, hostAccess: { required: [], optional: [] },
            contributes: { agents: sourceManifest.contributes.agents.map(({ cli: _cli, ...agent }) => agent) } };
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            plugins: [{ manifest: nativeManifest,
                // An authored activation variant, not a host mock: reuse the
                // incumbent deterministic factory without declaring native auth.
                files: { 'daemon.mjs': `import { createRuntime } from './agent-runtime.mjs';
export function activate(api) { api.agents.register('novel-native-agent', createRuntime, {
  sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 }
}); }`,
                    'agent-runtime.mjs': await readFile(new URL('agent-runtime.mjs', fixtureRoot), 'utf8') } }],
            runtimeOptions: { pluginIds: ['acme.native-runtime-proof'] },
        });
        runtimeFixtures.push(fixture);
        let connectedFixture: typeof fixture | null = null;
        try {
            const agentId = 'acme.native-runtime-proof/novel-native-agent';
            const request = { requestedCliNames: [agentId], includeLoginStatus: true };
            const snapshot = await detectCliSnapshotOnDaemonPath(request);
            expect(snapshot.clis[agentId]).toMatchObject({ available: true, installed: true,
                signIn: { status: 'unknown', loginSupport: 'unsupported', required: false } });
            expect(fixture.registry.agentRuntimesByAgentId.get(agentId)?.sessionRunnerFactoryBinding).toBeDefined();
            const data = buildCliCapabilityData({ request: { id: `cli.${agentId}` }, entry: snapshot.clis[agentId] });
            expect(projectMachineAgentsDetectResponse({ agents: [{ agentId, title: 'Native fixture' }],
                response: { protocolVersion: 1, results: { [`cli.${agentId}`]: { ok: true, data } } },
            }).items).toMatchObject([{ agentId, installed: true,
                signIn: { status: 'unknown', loginSupport: 'unsupported', required: false } }]);
            fixture.registry.retireConsumers();
            const retired = await detectCliSnapshotOnDaemonPath(request);
            expect(retired.clis[agentId]).not.toMatchObject({ available: true, installed: true });
            expect(retired.clis[agentId]?.signIn?.required).not.toBe(false);
            const absent = await detectCliSnapshotOnDaemonPath({ requestedCliNames: ['acme.absent/agent'], includeLoginStatus: true });
            expect(absent.clis['acme.absent/agent']).not.toMatchObject({ available: true, installed: true });
            expect(absent.clis['acme.absent/agent']?.signIn?.required).not.toBe(false);
            // The incumbent registration actually declares connected native
            // launch custody. No CLI does not remove that authentication fact.
            connectedFixture = await createAuthoredAdmittedPluginRuntimeFixture({
                controller: pluginReloadController,
                plugins: [{ manifest: { ...sourceManifest, activation: { events: [] },
                    contributes: { ...sourceManifest.contributes, agents: nativeManifest.contributes.agents } },
                    files: { 'daemon.mjs': await readFile(new URL('daemon.mjs', fixtureRoot), 'utf8'),
                        'agent-runtime.mjs': await readFile(new URL('agent-runtime.mjs', fixtureRoot), 'utf8') } }],
                runtimeOptions: { pluginIds: [sourceManifest.id] },
            });
            runtimeFixtures.push(connectedFixture);
            const connected = await detectCliSnapshotOnDaemonPath(request);
            expect(connected.clis[agentId]).toMatchObject({ available: true, installed: true,
                signIn: { status: 'unknown', loginSupport: 'unsupported', required: true } });
            expect(connectedFixture.registry.agentRuntimesByAgentId.get(agentId)?.connectedAccountLaunch).toBeDefined();
        } finally {
            // Suite cleanup joins the owner after every retained lease drains.
            await connectedFixture?.lease.release();
            await fixture.lease.release();
        }
    });
});
