import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectManifestUpdateInputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { workspaceFileEditorDraftCache } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraftCache';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Only the remote daemon network is replaced; the Action admission and editor remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
const { createProjectManifestActionClient } = await import('@/components/projects/projectSetup/projectManifestActionClient');
const { createProjectManifestEditorModel } = await import('@/components/projects/projectSetup/projectManifestEditorModel');

const initialBytes = '{ "version": 1, "future": {"keep":true} }\n';
const present = (bytes: string, hash: string) => ({ basis: { kind: 'present' as const, hash }, document: readProjectManifestDocument(bytes) });
const detection = { entries: [], environments: [], devcontainers: [], coverage: 'complete' as const, diagnostics: [] };
let workspace = { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/project' };

describe('Project definition Actions through the UI executor', () => {
    beforeEach(async () => {
        await harness.reset();
        rpc.machine.mockReset();
        const serverId = await harness.addHome({ name: 'Project Home', serverUrl: 'https://project.test', accountId: 'alice' });
        workspace = { ...workspace, serverId };
        // The real Action root discovers custody before retaining the own-Machine RPC path.
        harness.answer(serverId, '/v1/machines', { body: [ExternalActionMachineBootstrapV1Schema.parse({
            id: workspace.machineId, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
            installationId: 'project-machine-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        })] });
        // These cases exercise direct guarded editor outcomes, not Ask-first's mounted continuation.
        // Admit that invocation through the real Account-owned settings boundary.
        harness.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'projects.manifest.update': ['ui'] } },
        } } } });
    });
    afterEach(() => {
        workspaceFileEditorDraftCache.setDraft({ accountId: 'alice', workspaceCacheKey: buildWorkspaceCacheKey(workspace), filePath: '.happier/project.json', draft: null });
        standardCleanup();
    });

    it('inspects, imports qualified references and saves exact draft bytes in the addressed Home without a Session', async () => {
        const signal = new AbortController().signal;
        const definition = present(initialBytes, 'a'.repeat(64));
        rpc.machine.mockResolvedValueOnce({ definition, detection, importCandidates: [] });
        const client = createProjectManifestActionClient({ workspace, expectedAccountId: 'alice', signal, execute: createFrontDoorActionExecute(createDefaultActionExecutor()) });
        const inspected = await client.inspect();
        const model = createProjectManifestEditorModel({ workspace, expectedAccountId: 'alice', definition: inspected.definition, actions: client });
        model.importNative({ usage: 'script', name: 'build', source: { kind: 'pluginNative', adapter: { pluginId: 'example.pixi', localId: 'tasks' }, file: 'pixi.toml', target: 'build' } });
        model.importEnvironment({ kind: 'pluginToolchain', adapter: { pluginId: 'example.pixi', localId: 'environment' }, configPath: 'pixi.toml' });
        const bytes = model.getSnapshot().draft.bytes;
        const document = readProjectManifestDocument(bytes);
        if (document.status !== 'valid') throw new Error('Expected valid imported document');
        rpc.machine.mockResolvedValueOnce({ status: 'saved', basis: { kind: 'present', hash: 'b'.repeat(64) }, document });
        expect((await model.save())?.status).toBe('saved');
        expect(model.getSnapshot().dirty).toBe(false);
        expect(rpc.machine.mock.calls.map(([request]) => ({ method: request.method, payload: request.payload, serverId: request.serverId,
            machineId: request.machineId, accountId: request.accountId, signal: request.signal }))).toEqual([
            { method: 'daemon.projects.inspect.v1', payload: { workspace }, serverId: workspace.serverId, machineId: 'machine', accountId: 'alice', signal },
            { method: 'daemon.projects.manifest.update.v1', payload: { workspace, expectedBasis: definition.basis, bytes }, serverId: workspace.serverId, machineId: 'machine', accountId: 'alice', signal },
        ]);
        expect(ProjectManifestUpdateInputSchema.parse(rpc.machine.mock.calls[1][0].payload).bytes).toBe(bytes);
    });

    it('rejects extra mutation authority fields before transport and retains real conflict and refusal outcomes', async () => {
        const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: workspace.serverId,
            externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
        const rejected = await execute('projects.manifest.update', { workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}', overwrite: true }, context);
        expect(rejected, JSON.stringify(rejected))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(rpc.machine).not.toHaveBeenCalled();
        const client = createProjectManifestActionClient({ workspace, expectedAccountId: 'alice', execute });
        const current = present('{"version":1,"future":"outside"}', 'c'.repeat(64));
        const model = createProjectManifestEditorModel({ workspace, expectedAccountId: 'alice', definition: present(initialBytes, 'a'.repeat(64)), actions: client });
        model.setRaw('{"version":1,"future":"draft"}\n');
        rpc.machine.mockResolvedValueOnce({ status: 'conflict', current });
        expect((await model.save())?.status).toBe('conflict');
        expect(model.getSnapshot()).toMatchObject({ conflict: current, draft: { bytes: '{"version":1,"future":"draft"}\n' }, dirty: true });
        model.reviewCurrentBasis();
        rpc.machine.mockResolvedValueOnce({ status: 'refused', code: 'access_denied' });
        expect((await model.save())?.status).toBe('refused');
        expect(model.getSnapshot()).toMatchObject({ dirty: true, error: { code: 'access_denied' } });
        expect(rpc.machine.mock.calls[1][0].payload.expectedBasis).toEqual(current.basis);
    });

    it('retains the draft and refuses another Account before it reaches the daemon', async () => {
        const client = createProjectManifestActionClient({ workspace, expectedAccountId: 'alice', execute: createFrontDoorActionExecute(createDefaultActionExecutor()) });
        const definition = present(initialBytes, 'a'.repeat(64));
        rpc.machine.mockResolvedValueOnce({ definition, detection, importCandidates: [] });
        const inspected = await client.inspect();
        const model = createProjectManifestEditorModel({ workspace, expectedAccountId: 'alice', definition: inspected.definition, actions: client });
        model.setRaw('{"version":1,"future":"Alice draft"}');
        await harness.switchAccount(workspace.serverId, 'bob');
        expect(await model.save()).toBeNull();
        expect(model.getSnapshot()).toMatchObject({ draft: { bytes: '{"version":1,"future":"Alice draft"}' },
            dirty: true, error: { code: 'action_account_scope_changed' } });
        expect(rpc.machine.mock.calls.map(([request]) => request.method)).toEqual(['daemon.projects.inspect.v1']);
    });
});
