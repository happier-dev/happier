import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ScmBackendDescribeResponseSchema,
  ScmCommitCreateResponseSchema,
  ScmDiffFileResponseSchema,
  ScmLogListResponseSchema,
  ScmPullRequestOpenComposeResponseSchema,
  ScmPullRequestOpenOrReuseResponseSchema,
  ScmRepositoryInitResponseSchema,
  ScmHostingRepositoryDescribePublishTargetsResponseSchema,
  ScmHostingRepositoryPublishResponseSchema,
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
const daemonStartupTimeoutMs = 90_000;

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

async function writeGhShim(dir: string): Promise<void> {
  const fileName = process.platform === 'win32' ? 'gh.cmd' : 'gh';
  const shimPath = join(dir, fileName);
  const contents = process.platform === 'win32'
    ? [
      '@echo off',
      'if "%1"=="auth" if "%2"=="status" exit /b 0',
      'if "%1"=="pr" if "%2"=="list" (echo []& exit /b 0)',
      'if "%1"=="pr" if "%2"=="create" (echo https://github.com/happier-dev/happier/pull/101& exit /b 0)',
      'if "%1"=="pr" if "%2"=="view" (echo {"number":101,"title":"Core e2e PR","url":"https://github.com/happier-dev/happier/pull/101","state":"OPEN","baseRefName":"main","headRefName":"feature/e2e-pr"}& exit /b 0)',
      'if "%1"=="api" if "%2"=="user" (echo {"login":"happier-dev"}& exit /b 0)',
      'if "%1"=="api" if "%2"=="user/orgs" (echo []& exit /b 0)',
      'if "%1"=="repo" if "%2"=="create" exit /b 0',
      'if "%1"=="repo" if "%2"=="view" (echo {"nameWithOwner":"happier-dev/published-e2e-repo","url":"https://github.com/happier-dev/published-e2e-repo","sshUrl":"git@github.com:happier-dev/published-e2e-repo.git","defaultBranchRef":{"name":"main"},"visibility":"PRIVATE"}& exit /b 0)',
      'exit /b 1',
    ].join('\r\n')
    : [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo \'[]\'; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/happier-dev/happier/pull/101"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo \'{"number":101,"title":"Core e2e PR","url":"https://github.com/happier-dev/happier/pull/101","state":"OPEN","baseRefName":"main","headRefName":"feature/e2e-pr"}\'; exit 0; fi',
      'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo \'{"login":"happier-dev"}\'; exit 0; fi',
      'if [ "$1" = "api" ] && [ "$2" = "user/orgs" ]; then echo \'[]\'; exit 0; fi',
      'if [ "$1" = "repo" ] && [ "$2" = "create" ]; then exit 0; fi',
      'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then echo \'{"nameWithOwner":"happier-dev/published-e2e-repo","url":"https://github.com/happier-dev/published-e2e-repo","sshUrl":"git@github.com:happier-dev/published-e2e-repo.git","defaultBranchRef":{"name":"main"},"visibility":"PRIVATE"}\'; exit 0; fi',
      'exit 1',
    ].join('\n');
  await writeFile(shimPath, contents, { encoding: 'utf8', mode: 0o755 });
  if (process.platform !== 'win32') await chmod(shimPath, 0o755);
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
    const shimDir = resolve(join(testDir, 'shims'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(shimDir, { recursive: true });
    await writeGhShim(shimDir);

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    await writeFile(join(workspaceDir, 'README.md'), '# SCM e2e\n', 'utf8');
    runGit(workspaceDir, ['init']);
    runGit(workspaceDir, ['config', 'user.name', 'Test User']);
    runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
    runGit(workspaceDir, ['add', 'README.md']);
    runGit(workspaceDir, ['commit', '-m', 'initial commit']);
    runGit(workspaceDir, ['branch', '-M', 'main']);
    runGit(workspaceDir, ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git']);
    runGit(workspaceDir, ['checkout', '-b', 'feature/e2e-pr']);
    await writeFile(join(workspaceDir, 'README.md'), '# SCM e2e\n\npending line\n', 'utf8');

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: daemonStartupTimeoutMs,
      env: {
        ...process.env,
        // The CLI source-entrypoint path is already covered by cliDist tests; this lane
        // only needs the daemon/bootstrap contract and is more stable on the source path.
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        PATH: [shimDir, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
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
        expect(snapshot.hostingProvider).toMatchObject({
          kind: 'github',
          nameWithOwner: 'happier-dev/happier',
        });
        expect(snapshot.totals.pendingFiles).toBeGreaterThanOrEqual(1);
      }

      const composeRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
        req: { cwd: workspaceDir, base: 'main', head: 'feature/e2e-pr' },
        encryptParams,
        decryptResult,
        schema: ScmPullRequestOpenComposeResponseSchema,
      });
      expect(composeRes).toEqual({
        success: true,
        url: 'https://github.com/happier-dev/happier/compare/main...feature%2Fe2e-pr',
      });

      const publishWorkspaceDir = await mkdtemp(join(tmpdir(), 'happier-publish-e2e-'));
      await writeFile(join(publishWorkspaceDir, 'README.md'), '# Published e2e repo\n', 'utf8');

      const initRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_REPOSITORY_INIT,
        req: { cwd: publishWorkspaceDir, initialBranch: 'main' },
        encryptParams,
        decryptResult,
        schema: ScmRepositoryInitResponseSchema,
      });
      expect(initRes).toMatchObject({
        success: true,
        alreadyInitialized: false,
      });
      expect(runGit(publishWorkspaceDir, ['status', '--porcelain'])).toBe('?? README.md');

      const publishTargetsRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
        req: { cwd: publishWorkspaceDir, providerKind: 'github' },
        encryptParams,
        decryptResult,
        schema: ScmHostingRepositoryDescribePublishTargetsResponseSchema,
      });
      expect(publishTargetsRes).toMatchObject({
        success: true,
        auth: {
          kind: 'gh-cli',
          authenticated: true,
        },
      });
      if (publishTargetsRes.success) {
        expect(publishTargetsRes.targets.some((target) => target.owner === 'happier-dev')).toBe(true);
      }

      const publishRepoRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
        req: {
          cwd: publishWorkspaceDir,
          providerKind: 'github',
          owner: 'happier-dev',
          ownerKind: 'user',
          repositoryName: 'published-e2e-repo',
          visibility: 'private',
          remoteName: 'origin',
          remoteUrlKind: 'https',
          remoteConflictStrategy: 'fail',
          pushCurrentBranch: false,
        },
        encryptParams,
        decryptResult,
        schema: ScmHostingRepositoryPublishResponseSchema,
      });
      expect(publishRepoRes).toMatchObject({
        success: true,
        repository: {
          nameWithOwner: 'happier-dev/published-e2e-repo',
        },
        remote: {
          name: 'origin',
          fetchUrl: 'https://github.com/happier-dev/published-e2e-repo.git',
        },
        pushed: false,
      });
      expect(runGit(publishWorkspaceDir, ['remote', 'get-url', 'origin'])).toBe('https://github.com/happier-dev/published-e2e-repo.git');

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

      const openOrReuseRes = await callMachineRpc({
        ui,
        machineId,
        method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
        req: {
          cwd: workspaceDir,
          base: 'main',
          head: 'feature/e2e-pr',
          title: 'Core e2e PR',
          body: 'Created through the daemon-visible GitHub CLI shim.',
        },
        encryptParams,
        decryptResult,
        schema: ScmPullRequestOpenOrReuseResponseSchema,
      });
      expect(openOrReuseRes).toMatchObject({
        success: true,
        kind: 'opened',
        pullRequest: {
          number: 101,
          title: 'Core e2e PR',
          headBranch: 'feature/e2e-pr',
        },
      });

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
        expect(snapshot?.pullRequest).toMatchObject({
          number: 101,
          title: 'Core e2e PR',
          headBranch: 'feature/e2e-pr',
        });
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
