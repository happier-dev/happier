import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { hasToolCall, parseToolTraceJsonl } from '../../src/testkit/toolTraceJsonl';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Codex local-control mirroring emits tool trace + session id', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('mirrors rollout tool calls and publishes codexSessionId', async () => {
    const testDir = run.testDir('codex-local-control-mirroring');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const codexSessionsDir = resolve(join(testDir, 'codex-sessions'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexSessionsDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      { path: workspaceDir, host: 'e2e', name: 'codex-local-control', createdAt: Date.now() },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-codex-local-control-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({
      cliHome,
      sessionId,
      secret,
      encryptionVariant: 'legacy',
    });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeCodexPath = resolve(join(fakeBinDir, 'codex'));
    const codexSessionId = `codex-session-${randomUUID()}`;
    const rolloutPath = resolve(join(codexSessionsDir, 'rollout-test.jsonl'));

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const sessionsRoot = process.env.HAPPIER_CODEX_SESSIONS_DIR;
if (!sessionsRoot) throw new Error('Missing HAPPIER_CODEX_SESSIONS_DIR');
fs.mkdirSync(sessionsRoot, { recursive: true });

const filePath = path.join(sessionsRoot, ${JSON.stringify('rollout-test.jsonl')});
const id = process.env.HAPPIER_E2E_CODEX_SESSION_ID;
if (!id) throw new Error('Missing HAPPIER_E2E_CODEX_SESSION_ID');

function write(line) {
  fs.appendFileSync(filePath, line + '\\n', 'utf8');
}

write(JSON.stringify({ type: 'session_meta', payload: { id, timestamp: new Date().toISOString(), cwd: process.cwd() } }));
write(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call_exec', name: 'exec_command', arguments: JSON.stringify({ command: 'echo CODEX_LOCAL_TRACE_OK' }) } }));
write(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_exec', output: JSON.stringify({ stdout: 'CODEX_LOCAL_TRACE_OK\\n', exit_code: 0 }) } }));
write(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: { patch: '*** Begin Patch\\n*** End Patch\\n' } } }));
write(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_patch', output: JSON.stringify({ ok: true }) } }));

process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    await chmod(fakeCodexPath, 0o755);

    const toolTraceFile = resolve(join(testDir, 'tooltrace.jsonl'));

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'codex-local-control-mirroring',
      sessionIds: [sessionId],
      env: {
        HAPPIER_STACK_TOOL_TRACE: '1',
      },
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_STACK_TOOL_TRACE: '1',
      HAPPIER_STACK_TOOL_TRACE_FILE: toolTraceFile,
      HAPPIER_CODEX_TUI_BIN: fakeCodexPath,
      HAPPIER_CODEX_SESSIONS_DIR: codexSessionsDir,
      HAPPIER_E2E_CODEX_SESSION_ID: codexSessionId,
      // Ensure vendor resume gating doesn't block local-control in dev tests.
      HAPPIER_EXPERIMENTAL_CODEX_RESUME: '1',
      HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: fakeCodexPath,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

    const proc: SpawnedProcess = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'codex',
        '--existing-session',
        sessionId,
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'local',
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    try {
      await waitFor(async () => existsSync(rolloutPath), { timeoutMs: 20_000 });

      await waitFor(async () => {
        if (!existsSync(toolTraceFile)) return false;
        const raw = await readFile(toolTraceFile, 'utf8').catch(() => '');
        const events = parseToolTraceJsonl(raw);
        return hasToolCall(events, {
          protocol: 'codex',
          name: 'Bash',
          commandSubstring: 'echo CODEX_LOCAL_TRACE_OK',
        });
      }, { timeoutMs: 30_000 });

      await waitFor(async () => {
        const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
        const metadata = decryptLegacyBase64(snap.metadata, secret) as any;
        return metadata?.codexSessionId === codexSessionId;
      }, { timeoutMs: 60_000 });

      const finalSnap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const finalMetadata = decryptLegacyBase64(finalSnap.metadata, secret) as any;
      expect(finalMetadata.codexSessionId).toBe(codexSessionId);
    } finally {
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});
