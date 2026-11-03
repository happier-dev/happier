import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol';
import { buildMachineAgentsDetectRequest, MachinesAgentsListOutputSchema, projectMachineAgentsDetectResponse } from '@happier-dev/protocol/capabilities';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectResponse } from '@/capabilities/types';

import { reloadConfiguration } from '@/configuration';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerCapabilitiesHandlers } from './capabilities';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';

const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_CLAUDE_PATH']);
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    environment.restore();
    reloadConfiguration();
});

function authoredAgent(pluginId: string) {
    return {
        manifest: createPluginManifestV2Fixture({
            id: pluginId,
            contributes: { systemTools: [{
                id: 'fixture-acp', title: 'Fixture ACP', executableNames: ['fixture-acp'],
            }], agents: [{
                id: 'fixture', title: 'Capability fixture',
                primary: 'sessions',
                runtime: { kind: 'acp', transport: {
                    kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' },
                } },
                capabilities: { sessions: {
                    open: ['create'], delivery: ['newTurn'], cancel: true,
                } },
            }] },
        }),
        files: { 'daemon.mjs': 'export function activate() {}' },
    };
}

describe('registerCapabilitiesHandlers prewarm', () => {
    it('serves public in-memory detection without requester qualification or private discovery', async () => {
        let qualifications = 0;
        let privateCatalogReads = 0;
        const handlers = new Map<string, RpcHandler>();
        registerCapabilitiesHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
            hasSessionAgentTransition: () => true,
            readPluginCatalog: async () => { privateCatalogReads += 1; return []; },
            filesystemEffectAdmission: createFilesystemEffectAdmission({
                resolveHomeServerIdentityId: async () => { qualifications += 1; return null; },
            }),
        });
        expect(await handlers.get(RPC_METHODS.CAPABILITIES_DETECT)!({
            requests: [{ id: 'tool.sessionAgentTransition' }],
        })).toMatchObject({ results: { 'tool.sessionAgentTransition': {
            ok: true, data: { supportsInputPermissionIntent: true },
        } } });
        expect({ qualifications, privateCatalogReads }).toEqual({ qualifications: 0, privateCatalogReads: 0 });
    });

    it('refuses protected capability deputies before scaffold effects and preserves admitted owner work without Home rechecks', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-capability-custody-'));
        disposers.push(() => rm(root, { recursive: true, force: true }));
        environment.patch({ HAPPIER_HOME_DIR: root });
        reloadConfiguration();
        const markerPath = join(root, 'probe-observations');
        if (process.platform !== 'win32') {
            const executable = join(root, 'fixture-cli.mjs');
            await writeFile(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\n`
                + `appendFileSync(${JSON.stringify(markerPath)}, 'observed\\n'); console.log('1.2.3');\n`, { mode: 0o700 });
            environment.patch({ HAPPIER_CLAUDE_PATH: executable });
        }
        const handlers = new Map<string, RpcHandler>();
        const dependencies: Parameters<typeof registerCapabilitiesHandlers>[1] & {
            filesystemEffectAdmission: ReturnType<typeof createFilesystemEffectAdmission>;
        } = { filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }) };
        registerCapabilitiesHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, dependencies);
        const invoke = handlers.get(RPC_METHODS.CAPABILITIES_INVOKE)!;
        const detect = handlers.get(RPC_METHODS.CAPABILITIES_DETECT)!;
        let homeCurrentnessCalls = 0;
        const owner: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'use', encryptionMode: 'plain' },
            // This arrival is already admitted. Finite effects consume custody
            // and local cancellation, not a fresh Home permission evaluation.
            verifyMachineAdmissionCurrent: async () => { homeCurrentnessCalls += 1; return false; } };
        const cancelled = new AbortController();
        cancelled.abort();
        const denied: RpcHandlerContext[] = [
            { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member' } },
            { ...owner, machineAdmission: { ...owner.machineAdmission!, actorAccountId: 'member', role: 'manage' } },
            { ...owner, callerAuthority: 'account_automation', localActionContext: { actionCaller: {
                kind: 'session', sessionId: 'copied-owner', starterDepth: 0, turnDepth: 0 } } },
            { ...owner, machineAdmission: undefined },
            { ...owner, verifyMachineAdmissionCurrent: undefined },
            { ...owner, signal: cancelled.signal },
        ];
        let sequence = 0;
        for (const context of denied) {
            const targetDir = join(root, `denied-${++sequence}`);
            const result = await invoke({ id: 'tool.plugins', method: 'create', params: {
                targetDir, pluginId: 'review.fixture', displayName: 'Review fixture' } }, context);
            expect({ ok: result.ok, code: result.error?.code }).toEqual({ ok: false, code: 'filesystem_identity_custody_unavailable' });
            expect(await stat(targetDir).then(() => true, () => false)).toBe(false);
            if (process.platform !== 'win32') {
                const before = await readFile(markerPath, 'utf8').catch(() => '');
                await expect(detect({ requests: [{ id: 'cli.claude', params: { bypassCache: true, verifyVersion: true } }] }, context))
                    .rejects.toMatchObject({ rpcErrorCode: 'filesystem_identity_custody_unavailable' });
                expect(await readFile(markerPath, 'utf8').catch(() => '')).toBe(before);
            }
        }
        for (const callerAuthority of ['present_user', 'account_automation'] as const) {
            const targetDir = join(root, callerAuthority);
            expect(await invoke({ id: 'tool.plugins', method: 'create', params: {
                targetDir, pluginId: 'review.fixture', displayName: 'Review fixture' } }, { ...owner, callerAuthority }))
                .toMatchObject({ ok: true });
            expect(JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')).name).toBe('happier-plugin-review-fixture');
            if (process.platform !== 'win32') {
                const before = await readFile(markerPath, 'utf8').catch(() => '');
                expect(await detect({ requests: [{ id: 'cli.claude', params: { bypassCache: true, verifyVersion: true } }] },
                    { ...owner, callerAuthority })).toMatchObject({ results: { 'cli.claude': { ok: true, data: { available: true, version: '1.2.3' } } } });
                expect((await readFile(markerPath, 'utf8')).length > before.length).toBe(true);
            }
        }
        expect(homeCurrentnessCalls).toBe(0);
    });

    it('serves the admitted registry snapshot and refreshes it only after runtime publication', async () => {
        const first = await createAuthoredAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            plugins: [authoredAgent('acme.capabilities-first')],
        });
        disposers.push(first.dispose);
        environment.patch({ HAPPIER_HOME_DIR: first.happyHomeDir });
        reloadConfiguration();

        const firstAgent = first.registry.contributes.agents.find((entry) => entry.pluginId === 'acme.capabilities-first');
        if (!firstAgent) throw new Error('Expected the admitted first Agent');
        const { call } = createEncryptedRpcTestClient({
            scopePrefix: 'machine-test', encryptionKey: new Uint8Array(32).fill(7),
            callerAuthority: 'present_user',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-test',
                installationId: 'installation', role: 'use', encryptionMode: 'plain' },
            manager: new RpcHandlerManager({ scopePrefix: 'machine-test', encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy', authorizeRequest: request => authorizeMachineRpcRequest(request, {
                    machineId: 'machine-test', resolveCustodianAccountId: async () => 'owner',
                    resolveInstallationId: () => 'installation', resolveHomeServerIdentityId: async () => 'home',
                    verifyMachineAdmission: async () => true,
                }) }),
            logger: () => undefined,
            registerHandlers: (manager) => registerCapabilitiesHandlers(manager, {
                filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }),
            }),
        });
        const describeCapabilities = () => call<CapabilitiesDescribeResponse, Record<string, never>>(
            RPC_METHODS.CAPABILITIES_DESCRIBE, {},
        );
        const before = await describeCapabilities();
        expect(before.capabilities).toContainEqual(expect.objectContaining({ id: `cli.${firstAgent.id}` }));
        expect(before.checklists[CHECKLIST_IDS.NEW_SESSION]).toContainEqual({ id: `cli.${firstAgent.id}` });
        const ordinary = await call<CapabilitiesDetectResponse, { checklistId: string }>(
            RPC_METHODS.CAPABILITIES_DETECT, { checklistId: CHECKLIST_IDS.NEW_SESSION },
        );
        const focused = await call<CapabilitiesDetectResponse, { requests: Array<{ id: string }> }>(
            RPC_METHODS.CAPABILITIES_DETECT, { requests: [{ id: `cli.${firstAgent.id}` }] },
        );
        const focusedResult = focused.results[`cli.${firstAgent.id}`];
        if (!focusedResult) throw new Error('Expected the focused Agent detection result');
        // The fixture has no installed executable. Both entry points must retain
        // its real outcome, including a probe refusal, rather than drop its row.
        expect(ordinary.results[`cli.${firstAgent.id}`]).toMatchObject(
            focusedResult.ok
                ? { ok: true, data: focusedResult.data }
                : { ok: false, error: focusedResult.error },
        );
        const agents = [{ agentId: firstAgent.id, title: 'Capability fixture' }];
        // The composer uses the same request producer and strict inventory consumer.
        // Exercise both through the registered encrypted RPC, not copied probe facts.
        const request = buildMachineAgentsDetectRequest({ agents, includeLatestVersion: false });
        const response = await call<CapabilitiesDetectResponse, typeof request>(RPC_METHODS.CAPABILITIES_DETECT, request);
        const inventory = MachinesAgentsListOutputSchema.parse(projectMachineAgentsDetectResponse({ agents, response }));
        expect(inventory.items).toMatchObject([{ agentId: firstAgent.id, installed: false }]);
        expect(inventory.unavailable).toBeUndefined();

        // Source admission alone does not replace this daemon's published runtime.
        const successor = await createAuthoredAdmittedPluginRuntimeFixture({
            happyHomeDir: first.happyHomeDir,
            plugins: [authoredAgent('acme.capabilities-second')],
            runtimeOptions: { pluginIds: ['acme.capabilities-first', 'acme.capabilities-second'] },
        });
        disposers.push(successor.dispose);
        const secondAgent = successor.registry.contributes.agents.find((entry) => entry.pluginId === 'acme.capabilities-second');
        if (!secondAgent) throw new Error('Expected the admitted successor Agent');
        const unpublished = await describeCapabilities();
        expect(unpublished.capabilities).toEqual(before.capabilities);
        expect(unpublished.capabilities.some((entry) => entry.id === `cli.${secondAgent.id}`)).toBe(false);

        const publication = await pluginReloadController.adoptPreparedRuntimeRegistry({
            registry: successor.registry,
            changedPluginIds: ['acme.capabilities-second'],
            runningSessionDisposition: 'retainRunningSessions',
        });
        expect(publication.ok).toBe(true);
        const after = await describeCapabilities();
        expect(after.capabilities).toContainEqual(expect.objectContaining({ id: `cli.${firstAgent.id}` }));
        expect(after.capabilities).toContainEqual(expect.objectContaining({ id: `cli.${secondAgent.id}` }));
        expect(after.checklists[CHECKLIST_IDS.NEW_SESSION]).toEqual(expect.arrayContaining([
            { id: `cli.${firstAgent.id}` }, { id: `cli.${secondAgent.id}` },
        ]));
    });
});
