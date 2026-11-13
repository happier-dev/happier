import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApiClient } from './api';
import type { ApiMachineClient } from './apiMachine';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { configuration, reloadConfiguration } from '@/configuration';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { writeCredentialsTokenOnly } from '@/persistence';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { buildDeploymentBackupActionInputV1, DeploymentBackupRunResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

const backupInput = () => buildDeploymentBackupActionInputV1('deployments.backups.run', {
    serverId: 'home', environmentId: 'environment', machineId: 'worker', installationId: 'installation',
    targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1,
});

describe('installed Machine Project Open receipt restart', () => {
    let directory: string;
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    const clients: ApiMachineClient[] = [];
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'happier-project-open-restart-'));
        vi.stubEnv('HAPPIER_HOME_DIR', directory);
        reloadConfiguration();
        fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory, runtimeOptions: { pluginIds: [] } });
        // Home HTTP is the external boundary; Machine creation, registration,
        // receipt settlement, filesystem retention and cold reads stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account' } };
            if (String(url).includes('/v1/account/encryption')) return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            throw new Error(`Unexpected Home request: ${String(url)}`);
        });
    });
    afterEach(async () => {
        for (const client of clients.splice(0)) await client.shutdown();
        await fixture?.dispose();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        reloadConfiguration();
        await rm(directory, { recursive: true, force: true });
    });

    async function start() {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account',
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
        })).toString('base64url')}.signature`;
        await writeCredentialsTokenOnly({ token });
        await readOrCreateInstallationIdentity();
        const api = await ApiClient.create({ token, encryption: null });
        const client = await api.machineSyncClient({ id: 'worker', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        clients.push(client);
        client.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorCode: 'INVALID_REQUEST', errorMessage: 'Not used' }),
            stopSession: async () => ({ status: 'not_found' }), isSessionActive: async () => false,
            requestShutdown: () => {} });
        const rpc: unknown = Reflect.get(client, 'rpcHandlerManager');
        if (!(rpc instanceof RpcHandlerManager)) throw new Error('Missing registered Machine RPC owner');
        return { client, rpc, get: async (operationId: string) => ActionOperationGetV1ResponseSchema.parse(
            await rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId })) };
    }

    it.each([
        { failure: 'key', actionId: 'projects.open' }, { failure: 'receipt_write', actionId: 'projects.open' },
        { failure: 'key', actionId: 'deployments.backups.run' }, { failure: 'receipt_write', actionId: 'deployments.backups.run' },
    ])('keeps the Machine available but refuses $actionId before an effect when $failure storage fails', async ({ failure, actionId }) => {
        if (failure === 'key') await writeFile(configuration.deviceLocalSecretKeyFile, '{"version":1,"key":"invalid"}', { mode: 0o600 });
        const machine = await start();
        if (failure === 'receipt_write') {
            const root = join(configuration.activeServerDir, 'action-operations');
            const [partition] = await readdir(root);
            if (!partition) throw new Error('Missing initialized receipt partition');
            await rm(join(root, partition), { recursive: true });
            await writeFile(join(root, partition), 'unavailable');
        }
        let effects = 0;
        const input = actionId === 'projects.open' ? {} : backupInput();
        const result = await machine.client.observeActionExecution({ actionId, input,
            actionRequestId: 'unavailable-open', execute: async () => { effects++; return { ok: true, result: {} }; } });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_not_admitted', effectAttempted: false });
        expect(await machine.client.observeActionExecution({ actionId, input,
            actionRequestId: 'unavailable-open', execute: async () => { effects++; return { ok: true, result: {} }; } }))
            .toMatchObject({ ok: false, errorCode: 'action_not_admitted', effectAttempted: false });
        expect(effects).toBe(0);
        expect(await machine.client.observeActionExecution({ actionId: 'machines.setup.apply', input: {},
            execute: async () => ({ ok: true, result: { unrelatedMachineOperation: true } }) }))
            .toMatchObject({ ok: true, result: { unrelatedMachineOperation: true } });
    });

    it('reports unavailable history rather than absence when a retained receipt cannot be read', async () => {
        const first = await start();
        let operationId = '';
        await first.client.observeActionExecution({ actionId: 'projects.open', input: {},
            actionRequestId: 'retained-unreadable', onOperation: operation => { operationId = operation.operationId; },
            execute: async () => ({ ok: true, result: { kind: 'outcomeUnknown' } }) });
        await first.client.shutdown();
        clients.splice(clients.indexOf(first.client), 1);
        await writeFile(configuration.deviceLocalSecretKeyFile, '{"version":1,"key":"invalid"}', { mode: 0o600 });
        const second = await start();
        await expect(second.rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId }))
            .rejects.toMatchObject({ rpcErrorCode: 'action_operation_unavailable' });
        await expect(second.rpc.invokeLocal(ACTION_OPERATION_RPC_METHODS_V2.list, {}))
            .rejects.toMatchObject({ rpcErrorCode: 'action_operation_unavailable' });
        await expect(second.client.readDeploymentBackupOperations({ target: backupInput(), context: {} }))
            .rejects.toMatchObject({ rpcErrorCode: 'action_operation_unavailable' });
        let genericId = '';
        await second.client.observeActionExecution({ actionId: 'machines.setup.apply', input: {},
            onOperation: operation => { genericId = operation.operationId; }, execute: async () => ({ ok: true, result: {} }) });
        expect(await second.get(genericId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    });

    it('retains the original verified backup capture and authored target after two installed Machine restarts', async () => {
        const input = backupInput();
        const first = await start();
        let operationId = '';
        let effects = 0;
        await first.client.observeActionExecution({ actionId: 'deployments.backups.run', input,
            onOperation: operation => { operationId = operation.operationId; }, execute: async () => {
                effects++;
                return { ok: true, result: DeploymentBackupRunResultV1Schema.parse({ kind: 'verified', operationId,
                    manifests: [{ schemaVersion: 1, environmentId: input.environmentId, sourceId: 'database', kind: 'dump',
                        configRevision: 1, repositoryId: 'a'.repeat(64), producerChecksumSha256: 'b'.repeat(64),
                        snapshot: { snapshotId: 'c2868814575631750862ab5582d10af5e4b76e3cb7ce5f43e15b788956c68ebe',
                            treeId: 'd'.repeat(64), hostname: 'host', time: '2026-11-09T23:39:30Z',
                            paths: ['database.dump'], tags: [] }, totalBytesProcessed: 10, totalFilesProcessed: 1 }],
                }) };
            } });
        const settled = await first.get(operationId);
        expect(settled).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        await first.client.shutdown();
        clients.splice(clients.indexOf(first.client), 1);
        for (let restart = 0; restart < 2; restart++) {
            const next = await start();
            expect(await next.get(operationId)).toEqual(settled);
            const retained = await next.client.readDeploymentBackupOperations({ target: { ...input, deploymentId: 'next-generation' }, context: {} });
            expect(retained).toEqual([{ snapshot: settled.kind === 'found' ? settled.operation : null, input }]);
            expect(await next.client.readDeploymentBackupOperations({ target: { ...input, environmentId: 'other' }, context: {} })).toEqual([]);
            await next.client.shutdown();
            clients.splice(clients.indexOf(next.client), 1);
        }
        expect(effects).toBe(1);
    });

    it('settles a lost Open as typed unknown once and retains both unknown and success through two restarts', async () => {
        let effects = 0;
        const input = { source: { kind: 'folder', path: '/retained-private-project' }, materialization: { kind: 'attach' } };
        const uncertain = { actionId: 'projects.open', input, actionRequestId: 'retained-open-request',
            execute: async () => { effects++; return { ok: true as const, result: { kind: 'outcomeUnknown' } }; } };
        const first = await start();
        let uncertainId = '';
        await first.client.observeActionExecution({ ...uncertain, onOperation: operation => { uncertainId = operation.operationId; } });
        expect(await first.get(uncertainId)).toMatchObject({ kind: 'found', operation: { state: 'running', revision: 3,
            observation: { kind: 'outcome_uncertain' } } });
        let successId = '';
        const succeeded = { actionId: 'projects.open', input: { ...input, source: { kind: 'folder', path: '/settled-project' } },
            actionRequestId: 'settled-open-request', execute: async () => { effects++; return { ok: true as const,
                result: { kind: 'opened', workspace: { serverId: 'home', machineId: 'worker', workspaceId: 'workspace' },
                    directory: '/settled-project', setup: 'notRequired' } }; } };
        await first.client.observeActionExecution({ ...succeeded, onOperation: operation => { successId = operation.operationId; } });
        const settled = await first.get(successId);
        await first.client.shutdown();
        clients.splice(clients.indexOf(first.client), 1);

        const second = await start();
        const lost = await second.get(uncertainId);
        expect(lost).toMatchObject({ kind: 'found', operation: { state: 'failed', revision: 4, cancellation: 'unsupported',
            error: { errorCode: 'action_outcome_unknown', effectAttempted: true } } });
        expect(await second.get(successId)).toEqual(settled);
        const replay = await second.client.observeActionExecution(uncertain);
        expect(replay).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', effectAttempted: true });
        if (replay.ok) throw new Error('Lost native outcome cannot become success');
        expect(isActionOutcomeUnknownErrorCodeV1(replay.errorCode)).toBe(true);
        expect(await second.client.observeActionExecution(succeeded)).toMatchObject({ ok: true, result: { kind: 'opened' } });
        expect(effects).toBe(2);
        await second.client.shutdown();
        clients.splice(clients.indexOf(second.client), 1);

        const third = await start();
        expect(await third.get(uncertainId)).toEqual(lost);
        expect(await third.get(successId)).toEqual(settled);
        expect(effects).toBe(2);
        const retainedFiles = await readdir(join(configuration.activeServerDir, 'action-operations'), { recursive: true });
        const ciphertexts = await Promise.all(retainedFiles.filter(name => name.endsWith('.json')).map(name =>
            readFile(join(configuration.activeServerDir, 'action-operations', name), 'utf8')));
        expect(ciphertexts).toHaveLength(2);
        expect(ciphertexts.join('')).not.toContain('/retained-private-project');
    });
});
