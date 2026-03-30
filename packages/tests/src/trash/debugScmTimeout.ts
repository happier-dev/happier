import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    ScmBackendDescribeResponseSchema,
    ScmCommitCreateResponseSchema,
    ScmDiffFileResponseSchema,
    ScmLogListResponseSchema,
    ScmStatusSnapshotResponseSchema,
} from '@happier-dev/protocol';

import { createRunDirs } from '../testkit/runDir';
import { startServerLight } from '../testkit/process/serverLight';
import { createTestAuth } from '../testkit/auth';
import { createUserScopedSocketCollector } from '../testkit/socketClient';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../testkit/messageCrypto';
import { startTestDaemon } from '../testkit/daemon/daemon';
import { waitFor } from '../testkit/timing';
import { seedCliAuthForServer } from '../testkit/cliAuth';
import { fetchJson } from '../testkit/http';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../testkit/rpcCrypto';
import { unwrapSerializedJsonValue } from '../testkit/unwrapSerializedJsonValue';

async function main(): Promise<void> {
    const run = createRunDirs({ runLabel: 'core-debug-scm' });
    const testDir = run.testDir('scm-session-rpc-git-debug');
    const server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    await writeFile(join(workspaceDir, 'README.md'), '# SCM e2e\n', 'utf8');
    execFileSync('git', ['init'], { cwd: workspaceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workspaceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['add', 'README.md'], { cwd: workspaceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: workspaceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    await writeFile(join(workspaceDir, 'README.md'), '# SCM e2e\n\npending line\n', 'utf8');

    console.log('starting daemon');
    const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: daemonHomeDir,
        env: {
            ...process.env,
            CI: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: serverBaseUrl,
            HAPPIER_WEBAPP_URL: serverBaseUrl,
        },
    });
    console.log('daemon started');

    const settings = JSON.parse(await readFile(resolve(join(daemonHomeDir, 'settings.json')), 'utf8')) as {
        activeServerId?: string;
        machineIdByServerId?: Record<string, string>;
    };
    const machineId = settings.machineIdByServerId?.[String(settings.activeServerId ?? '')] ?? '';
    console.log('machineId', machineId);

    const machinesRes = await fetchJson<Array<{ id?: string; dataEncryptionKey?: string }>>(`${serverBaseUrl}/v1/machines`, {
        headers: { Authorization: `Bearer ${auth.token}` },
        timeoutMs: 10_000,
    });
    console.log('machines status', machinesRes.status);
    const machineDekBase64 = machinesRes.data.find((m) => m.id === machineId)?.dataEncryptionKey ?? null;
    console.log('machineDek?', Boolean(machineDekBase64));

    const machineDek = machineDekBase64 ? new Uint8Array(Buffer.from(machineDekBase64, 'base64')) : null;
    const encryptParams = (value: unknown) => (machineDek ? encryptDataKeyBase64(value, machineDek) : encryptLegacyBase64(value, secret));
    const decryptResult = (value: string) => (machineDek ? decryptDataKeyBase64(value, machineDek) : decryptLegacyBase64(value, secret));

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });
    console.log('socket connected');

    async function call<T>(method: string, req: unknown, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }): Promise<T> {
        const fullMethod = `${machineId}:${method}`;
        const startedAt = Date.now();
        console.log('call start', method);
        const res = await ui.rpcCall(fullMethod, encryptParams(req), 20_000);
        console.log('call ack', method, Date.now() - startedAt, res?.ok, typeof res?.result === 'string' ? res.result.slice(0, 80) : res);
        if (!res || res.ok !== true || typeof res.result !== 'string') {
            throw new Error(`bad ack for ${method}`);
        }
        const decrypted = unwrapSerializedJsonValue(decryptResult(res.result));
        const parsed = schema.safeParse(decrypted);
        console.log('parsed', method, parsed.success);
        if (!parsed.success) throw new Error(`parse failed ${method}`);
        return parsed.data;
    }

    await call(RPC_METHODS.SCM_BACKEND_DESCRIBE, { cwd: workspaceDir }, ScmBackendDescribeResponseSchema);
    await call(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: workspaceDir }, ScmStatusSnapshotResponseSchema);
    await call(RPC_METHODS.SCM_DIFF_FILE, { cwd: workspaceDir, path: 'README.md', area: 'pending' }, ScmDiffFileResponseSchema);
    await writeFile(join(workspaceDir, 'NOTES.md'), 'leftover file\n', 'utf8');
    await call(RPC_METHODS.SCM_COMMIT_CREATE, { cwd: workspaceDir, message: 'e2e path-scoped commit', scope: { kind: 'paths', include: ['README.md'] } }, ScmCommitCreateResponseSchema);
    await call(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: workspaceDir }, ScmStatusSnapshotResponseSchema);
    await call(RPC_METHODS.SCM_COMMIT_CREATE, { cwd: workspaceDir, message: 'e2e atomic commit', scope: { kind: 'all-pending' } }, ScmCommitCreateResponseSchema);
    await call(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: workspaceDir }, ScmStatusSnapshotResponseSchema);
    await call(RPC_METHODS.SCM_LOG_LIST, { cwd: workspaceDir, limit: 10, skip: 0 }, ScmLogListResponseSchema);

    console.log('done ok');
    ui.disconnect();
    ui.close();
    await daemon.stop();
    await server.stop();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
