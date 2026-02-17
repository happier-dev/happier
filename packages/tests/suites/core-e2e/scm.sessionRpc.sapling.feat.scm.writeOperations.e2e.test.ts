import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ScmBackendDescribeResponseSchema,
  ScmCommitCreateResponseSchema,
  ScmDiffCommitResponseSchema,
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
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

type RpcAck = { ok: boolean; result?: string; error?: string; errorCode?: string };
type SafeParseResult<T> = { success: true; data: T } | { success: false };
type ParseSchema<T> = { safeParse: (input: unknown) => SafeParseResult<T> };

function runSapling(cwd: string, args: string[]): string {
  return execFileSync('sl', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function callSessionRpc<TReq, TRes>(params: {
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  sessionId: string;
  method: string;
  req: TReq;
  secret: Uint8Array;
  schema: ParseSchema<TRes>;
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;
  const encryptedParams = encryptLegacyBase64(params.req, params.secret);

  await waitFor(
    async () => {
      const res = await params.ui.rpcCall<RpcAck>(`${params.sessionId}:${params.method}`, encryptedParams);
      if (!res || res.ok !== true || typeof res.result !== 'string') return false;
      const decrypted = decryptLegacyBase64(res.result, params.secret);
      const parsed = params.schema.safeParse(decrypted);
      if (!parsed.success) return false;
      out = parsed.data;
      return true;
    },
    { timeoutMs: params.timeoutMs ?? 25_000 },
  );

  if (!out) throw new Error(`RPC call did not return a valid response: ${params.method}`);
  return out;
}

describe('core e2e: scm sapling session RPC', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('returns live sapling backend snapshot/diff/log over encrypted session RPC', async () => {
    const testDir = run.testDir('scm-session-rpc-sapling');
    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    runSapling(workspaceDir, ['init']);
    runSapling(workspaceDir, ['config', '--local', 'ui.username', 'Test User <test@example.com>']);
    await writeFile(join(workspaceDir, 'README.md'), '# SCM e2e\n', 'utf8');
    runSapling(workspaceDir, ['commit', '-A', '-m', 'initial commit']);
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
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
        },
      },
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const describeRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_BACKEND_DESCRIBE,
      req: { cwd: workspaceDir },
      secret,
      schema: ScmBackendDescribeResponseSchema,
    });
    expect(describeRes.success).toBe(true);
    if (describeRes.success) {
      expect(describeRes.backendId).toBe('sapling');
    }

    const snapshotRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
      req: { cwd: workspaceDir },
      secret,
      schema: ScmStatusSnapshotResponseSchema,
    });
    expect(snapshotRes.success).toBe(true);
    if (snapshotRes.success) {
      expect(snapshotRes.snapshot).toBeDefined();
      const snapshot = snapshotRes.snapshot;
      if (!snapshot) throw new Error('Missing snapshot payload');
      expect(snapshot.repo.isRepo).toBe(true);
      expect(snapshot.repo.backendId).toBe('sapling');
      expect(snapshot.totals.pendingFiles).toBeGreaterThanOrEqual(1);
    }

    const diffRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_DIFF_FILE,
      req: { cwd: workspaceDir, path: 'README.md', area: 'pending' },
      secret,
      schema: ScmDiffFileResponseSchema,
    });
    expect(diffRes.success).toBe(true);
    if (diffRes.success) {
      expect(diffRes.diff).toContain('pending line');
    }

    await writeFile(join(workspaceDir, 'NOTES.md'), 'leftover file\n', 'utf8');

    const pathScopedCommitRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_COMMIT_CREATE,
      req: {
        cwd: workspaceDir,
        message: 'e2e path-scoped commit',
        scope: { kind: 'paths', include: ['README.md'] },
      },
      secret,
      schema: ScmCommitCreateResponseSchema,
    });
    expect(pathScopedCommitRes.success).toBe(true);

    const snapshotAfterPathScopedCommitRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
      req: { cwd: workspaceDir },
      secret,
      schema: ScmStatusSnapshotResponseSchema,
    });
    expect(snapshotAfterPathScopedCommitRes.success).toBe(true);
    if (snapshotAfterPathScopedCommitRes.success) {
      const snapshot = snapshotAfterPathScopedCommitRes.snapshot;
      expect(snapshot?.totals.untrackedFiles).toBeGreaterThanOrEqual(1);
    }

    const commitRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_COMMIT_CREATE,
      req: {
        cwd: workspaceDir,
        message: 'e2e atomic commit',
        scope: { kind: 'all-pending' },
      },
      secret,
      schema: ScmCommitCreateResponseSchema,
    });
    expect(commitRes.success).toBe(true);

    const snapshotAfterCommitRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
      req: { cwd: workspaceDir },
      secret,
      schema: ScmStatusSnapshotResponseSchema,
    });
    expect(snapshotAfterCommitRes.success).toBe(true);
    if (snapshotAfterCommitRes.success) {
      const snapshot = snapshotAfterCommitRes.snapshot;
      expect(snapshot?.totals.pendingFiles).toBe(0);
      expect(snapshot?.totals.includedFiles).toBe(0);
      expect(snapshot?.totals.untrackedFiles).toBe(0);
    }

    const logRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_LOG_LIST,
      req: { cwd: workspaceDir, limit: 10, skip: 0 },
      secret,
      schema: ScmLogListResponseSchema,
    });
    expect(logRes.success).toBe(true);
    if (!logRes.success || !logRes.entries || logRes.entries.length === 0) {
      throw new Error('Missing log entries');
    }
    expect(logRes.entries[0]?.subject).toBe('e2e atomic commit');

    const commitDiffRes = await callSessionRpc({
      ui,
      sessionId,
      method: RPC_METHODS.SCM_DIFF_COMMIT,
      req: { cwd: workspaceDir, commit: logRes.entries[0]!.sha },
      secret,
      schema: ScmDiffCommitResponseSchema,
    });
    expect(commitDiffRes.success).toBe(true);
    if (commitDiffRes.success) {
      expect(commitDiffRes.diff).toContain('diff --git');
    }
  }, 150_000);
});
