import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ScmBackendDescribeResponseSchema,
  ScmCommitCreateResponseSchema,
  ScmDiffFileResponseSchema,
  ScmLogListResponseSchema,
  ScmStatusSnapshotResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fetchJson } from '../../src/testkit/http';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';

const run = createRunDirs({ runLabel: 'core' });

type RpcAck = { ok: boolean; result?: string; error?: string; errorCode?: string };
type SafeParseResult<T> = { success: true; data: T } | { success: false };
type ParseSchema<T> = { safeParse: (input: unknown) => SafeParseResult<T> };

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function resolveDaemonMachineIdFromSettings(params: { daemonHomeDir: string }): Promise<string> {
  const raw = await readFile(resolve(join(params.daemonHomeDir, 'settings.json')), 'utf8').catch(() => '');
  const parsed = raw ? (JSON.parse(raw) as any) : null;
  const activeServerId = parsed && typeof parsed.activeServerId === 'string' ? String(parsed.activeServerId) : '';
  const machineIdByServerId = parsed && typeof parsed.machineIdByServerId === 'object' ? parsed.machineIdByServerId : null;
  const machineId =
    activeServerId && machineIdByServerId && typeof machineIdByServerId[activeServerId] === 'string'
      ? String(machineIdByServerId[activeServerId])
      : '';
  if (!machineId) throw new Error('Missing machineIdByServerId[activeServerId] in seeded settings.json');
  return machineId;
}

type MachineListRow = { id?: unknown; dataEncryptionKey?: unknown };

async function resolveMachineDataEncryptionKeyBase64(params: {
  baseUrl: string;
  token: string;
  machineId: string;
}): Promise<string | null> {
  let out: string | null = null;
  await waitFor(
    async () => {
      const res = await fetchJson<MachineListRow[]>(`${params.baseUrl}/v1/machines`, {
        headers: { Authorization: `Bearer ${params.token}` },
        timeoutMs: 10_000,
      });
      if (res.status !== 200 || !Array.isArray(res.data)) {
        throw new Error(`Failed to fetch /v1/machines (status=${res.status})`);
      }
      const row = res.data.find((m) => m && typeof m === 'object' && (m as any).id === params.machineId) ?? null;
      if (!row) return false;
      const dek = (row as any).dataEncryptionKey;
      out = typeof dek === 'string' && dek.length > 0 ? dek : null;
      return true;
    },
    { timeoutMs: 20_000, context: `machine registered: ${params.machineId}` },
  );
  return out;
}

function truncate(value: string, max = 220): string {
  const raw = String(value ?? '');
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…`;
}

async function callMachineRpc<TReq, TRes>(params: {
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  machineId: string;
  method: string;
  req: TReq;
  encryptParams: (value: unknown) => string;
  decryptResult: (value: string) => unknown | null;
  schema: ParseSchema<TRes>;
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;
  const encryptedParams = params.encryptParams(params.req);
  const fullMethod = `${params.machineId}:${params.method}`;

  await waitFor(
    async () => {
      const res = await params.ui.rpcCall<RpcAck>(fullMethod, encryptedParams);
      if (!res) throw new Error('rpcCall returned null/undefined');
      if (res.ok !== true || typeof res.result !== 'string') {
        const errorCode = typeof res.errorCode === 'string' ? res.errorCode : '';
        const error = typeof res.error === 'string' ? res.error : '';
        throw new Error(`rpc ack not ok (errorCode=${errorCode || 'none'} error=${truncate(error) || 'none'})`);
      }
      const decrypted = unwrapSerializedJsonValue(params.decryptResult(res.result));
      if (!decrypted) throw new Error('failed to decrypt rpc result');
      const parsed = params.schema.safeParse(decrypted);
      if (!parsed.success) {
        throw new Error(
          `failed to parse rpc result as ${params.method} response: ${truncate(JSON.stringify(decrypted))}`,
        );
      }
      out = parsed.data;
      return true;
    },
    { timeoutMs: params.timeoutMs ?? 25_000, context: fullMethod },
  );

  if (!out) throw new Error(`RPC call did not return a valid response: ${params.method}`);
  return out;
}

describe('core e2e: scm git machine RPC', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('returns live git backend snapshot/diff/log over encrypted machine RPC', async () => {
    const testDir = run.testDir('scm-session-rpc-git');
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    await writeFile(join(workspaceDir, 'README.md'), '# SCM e2e\n', 'utf8');
    runGit(workspaceDir, ['init']);
    runGit(workspaceDir, ['config', 'user.name', 'Test User']);
    runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
    runGit(workspaceDir, ['add', 'README.md']);
    runGit(workspaceDir, ['commit', '-m', 'initial commit']);
    await writeFile(join(workspaceDir, 'README.md'), '# SCM e2e\n\npending line\n', 'utf8');

    daemon = await startTestDaemon({
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
    const machineId = await resolveDaemonMachineIdFromSettings({ daemonHomeDir });
    const machineDekBase64 = await resolveMachineDataEncryptionKeyBase64({
      baseUrl: serverBaseUrl,
      token: auth.token,
      machineId,
    });
    const machineDek = machineDekBase64 ? new Uint8Array(Buffer.from(machineDekBase64, 'base64')) : null;
    const encryptParams = (value: unknown) => (machineDek ? encryptDataKeyBase64(value, machineDek) : encryptLegacyBase64(value, secret));
    const decryptResult = (value: string) => (machineDek ? decryptDataKeyBase64(value, machineDek) : decryptLegacyBase64(value, secret));

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      const describeRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_BACKEND_DESCRIBE,
        req: { cwd: workspaceDir },
        encryptParams,
        decryptResult,
        schema: ScmBackendDescribeResponseSchema,
      });
      expect(describeRes.success).toBe(true);
      if (describeRes.success) {
        expect(describeRes.backendId).toBe('git');
      }

      const snapshotRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
        req: { cwd: workspaceDir },
        encryptParams,
        decryptResult,
        schema: ScmStatusSnapshotResponseSchema,
      });
      expect(snapshotRes.success).toBe(true);
      if (snapshotRes.success) {
        expect(snapshotRes.snapshot).toBeDefined();
        const snapshot = snapshotRes.snapshot;
        if (!snapshot) throw new Error('Missing snapshot payload');
        expect(snapshot.repo.isRepo).toBe(true);
        expect(snapshot.repo.backendId).toBe('git');
        expect(snapshot.totals.pendingFiles).toBeGreaterThanOrEqual(1);
      }

      const diffRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_DIFF_FILE,
        req: { cwd: workspaceDir, path: 'README.md', area: 'pending' },
        encryptParams,
        decryptResult,
        schema: ScmDiffFileResponseSchema,
      });
      expect(diffRes.success).toBe(true);
      if (diffRes.success) {
        expect(diffRes.diff).toContain('pending line');
      }

      await writeFile(join(workspaceDir, 'NOTES.md'), 'leftover file\n', 'utf8');

      const pathScopedCommitRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_COMMIT_CREATE,
        req: {
          cwd: workspaceDir,
          message: 'e2e path-scoped commit',
          scope: { kind: 'paths', include: ['README.md'] },
        },
        encryptParams,
        decryptResult,
        schema: ScmCommitCreateResponseSchema,
      });
      expect(pathScopedCommitRes.success).toBe(true);
      if (pathScopedCommitRes.success) {
        expect(typeof pathScopedCommitRes.commitSha).toBe('string');
        expect((pathScopedCommitRes.commitSha ?? '').length).toBeGreaterThan(0);
      }
      expect(runGit(workspaceDir, ['show', '--pretty=', '--name-only', 'HEAD'])).toContain('README.md');

      const snapshotAfterPathScopedCommitRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
        req: { cwd: workspaceDir },
        encryptParams,
        decryptResult,
        schema: ScmStatusSnapshotResponseSchema,
      });
      expect(snapshotAfterPathScopedCommitRes.success).toBe(true);
      if (snapshotAfterPathScopedCommitRes.success) {
        const snapshot = snapshotAfterPathScopedCommitRes.snapshot;
        expect(snapshot?.totals.untrackedFiles).toBeGreaterThanOrEqual(1);
      }

      const commitRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_COMMIT_CREATE,
        req: {
          cwd: workspaceDir,
          message: 'e2e atomic commit',
          scope: { kind: 'all-pending' },
        },
        encryptParams,
        decryptResult,
        schema: ScmCommitCreateResponseSchema,
      });
      expect(commitRes.success).toBe(true);
      if (commitRes.success) {
        expect(typeof commitRes.commitSha).toBe('string');
        expect((commitRes.commitSha ?? '').length).toBeGreaterThan(0);
      }

      const snapshotAfterCommitRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
        req: { cwd: workspaceDir },
        encryptParams,
        decryptResult,
        schema: ScmStatusSnapshotResponseSchema,
      });
      expect(snapshotAfterCommitRes.success).toBe(true);
      if (snapshotAfterCommitRes.success) {
        const snapshot = snapshotAfterCommitRes.snapshot;
        expect(snapshot?.totals.pendingFiles).toBe(0);
        expect(snapshot?.totals.includedFiles).toBe(0);
        expect(snapshot?.totals.untrackedFiles).toBe(0);
      }

      const logRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_LOG_LIST,
        req: { cwd: workspaceDir, limit: 10, skip: 0 },
        encryptParams,
        decryptResult,
        schema: ScmLogListResponseSchema,
      });
      expect(logRes.success).toBe(true);
      if (logRes.success) {
        expect(Array.isArray(logRes.entries)).toBe(true);
        const entries = logRes.entries ?? [];
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries.some((entry) => entry.subject === 'e2e path-scoped commit')).toBe(true);
        expect(entries.some((entry) => entry.subject === 'e2e atomic commit')).toBe(true);
      }
    } finally {
      ui.disconnect();
      ui.close();
    }
  }, 360_000);
});
