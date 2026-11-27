import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH, sanitizeSessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createCodexAppServerTurnFailure, readCodexAppServerFailureCause } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/turns/failure';
import { executeAgentLaunchPayload } from './agentLaunchShim';
import { encodeAgentLaunchFrame, readAgentLaunchFrame, type AgentLaunchPayload } from './agentLaunchFrame';
import { spawnSupervisedPluginProcess } from '../../plugins/runtime/exec/processSupervisor';
import { createPluginExecClientExitError } from '../../plugins/runtime/exec/errors';
import { classifyPrimarySessionRuntimeIssue } from '../../agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createAgentLaunchStderr } from './agentLaunchDiagnostics';

const cleanupFault = vi.hoisted(() => ({ path: '' }));
// Fault only the selected file's OS unlink; launch, publication and all other
// cleanup remain real. The fault is one-shot so test disposal can remove it.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]) === cleanupFault.path) {
      cleanupFault.path = '';
      throw Object.assign(new Error('private-unlink-error'), { code: 'EIO' });
    }
    return actual.rm(...args);
  } };
});

const roots: string[] = [];
const bunCommand = process.env.HAPPIER_BUN_PATH || 'bun';
const hasBun = spawnSync(bunCommand, ['--version'], { encoding: 'utf8' }).status === 0;
afterEach(async () => {
  cleanupFault.path = '';
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function launch(args: readonly string[], environment: Record<string, string> = {}): Promise<AgentLaunchPayload> {
  const home = await mkdtemp(join(tmpdir(), 'happier-launch-diagnostic-'));
  roots.push(home);
  return { v: 1, executable: process.execPath, args, cwd: home, runtimeHome: join(home, 'runtime', 'test'),
    environment, selectedMaterials: [] };
}

describe.skipIf(process.platform !== 'linux')('Agent launch initiating diagnostics', () => {
  it('identifies a frame read failure without retaining frame bytes', async () => {
    await expect(readAgentLaunchFrame(Readable.from(['private-frame']))).rejects.toMatchObject({
      code: 'agent_launch_frame_invalid', stage: 'frame_read', message: expect.not.stringContaining('private-frame'),
    });
  });

  it('identifies exec failure before the resulting stream shutdown', async () => {
    const payload = await launch([]);
    await expect(executeAgentLaunchPayload({ ...payload, executable: join(payload.cwd, 'missing') }, {
      agentHome: payload.cwd, input: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    })).rejects.toMatchObject({ stage: 'exec', message: expect.stringContaining('errno=ENOENT') });
  });

  it.skipIf(process.getuid?.() === 0)('retains native EACCES when the selected cwd is inaccessible', async () => {
    const payload = await launch(['-e', 'process.stdout.write("must-not-start")']);
    const privateDirectory = join(payload.cwd, 'private-cwd');
    await mkdir(privateDirectory, { mode: 0o700 });
    await chmod(privateDirectory, 0);
    try {
      await expect(executeAgentLaunchPayload({ ...payload, cwd: privateDirectory }, {
        agentHome: payload.cwd, input: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      })).rejects.toMatchObject({ stage: 'exec', message: expect.stringContaining('errno=EACCES') });
    } finally { await chmod(privateDirectory, 0o700); }
  });

  it('retains the initiating native failure when selected-material cleanup also fails', async () => {
    const payload = { ...await launch(['-e', 'process.stderr.write("native-startup-refused");process.exit(23)']),
      selectedMaterials: [{ relativePath: 'files/auth', contentBase64: Buffer.from('selected-secret').toString('base64') }] };
    cleanupFault.path = join(payload.runtimeHome, 'files/auth');
    await expect(executeAgentLaunchPayload(payload, { agentHome: payload.cwd, input: new PassThrough(),
      stdout: new PassThrough(), stderr: new PassThrough() })).rejects.toMatchObject({
      stage: 'child_exit', exitCode: 23, stderrPreview: expect.stringContaining('native-startup-refused'),
      cause: expect.any(AggregateError),
    });
  });

  it('redacts an unlabelled credential read from a selected JSON material', async () => {
    const secret = 'synthetic-private\nmaterial-"key"\\雪🔐';
    const payload = { ...await launch(['-e', `
      const key = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).api_key;
      process.stderr.write('native-startup-refused ' + JSON.stringify(key).slice(1, -1)); process.exit(23);
    `]), selectedMaterials: [{ relativePath: 'files/auth.json',
      contentBase64: Buffer.from(JSON.stringify({ api_key: secret })).toString('base64') }] };
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stderr.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await executeAgentLaunchPayload({ ...payload, args: [...payload.args, join(payload.runtimeHome, 'files/auth.json')] }, {
      agentHome: payload.cwd, input: new PassThrough(), stdout: new PassThrough(), stderr,
    });
    const diagnostic = Buffer.concat(chunks).toString();
    expect(diagnostic).toContain('native-startup-refused [REDACTED]');
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it.each(['plain', 'JSON-escaped'] as const)('carries a real early child exit and its redacted %s stderr tail into the runtime issue', async representation => {
    const secret = 'synthetic-private\nprovider-"key"\\雪🔐';
    const payload = await launch(['-e', `
      const fs = require('node:fs');
      const echo = ${representation === 'plain' ? 'process.env.PROVIDER_API_KEY' : 'JSON.stringify(process.env.PROVIDER_API_KEY).slice(1, -1)'};
      fs.writeSync(2, 'old diagnostic '.repeat(2000));
      fs.writeSync(2, 'EACCES ' + process.env.CODEX_HOME + '; missing ' + process.env.CODEX_SQLITE_HOME + '; native-startup-refused ' + echo.slice(0, 12));
      setImmediate(() => {
        fs.writeSync(2, echo.slice(12) + '; Bearer private-native-token\\n');
        process.exit(23);
      });
    `], { PROVIDER_API_KEY: secret, CODEX_HOME: '/native/codex-home', CODEX_SQLITE_HOME: '/native/codex-sqlite-home' });
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stderr.on('data', chunk => chunks.push(Buffer.from(chunk)));
    const result = await executeAgentLaunchPayload(payload, { agentHome: payload.cwd, input: new PassThrough(),
      stdout: new PassThrough(), stderr });
    expect(result).toEqual({ code: 23, signal: null });
    const diagnostic = Buffer.concat(chunks).toString();
    const error = createPluginExecClientExitError({ exitCode: result.code, signal: result.signal }, diagnostic);
    const failure = createCodexAppServerTurnFailure({ phase: 'client_start', value: error });
    const issue = sanitizeSessionRuntimeIssueV1({ v: 1, scope: 'primary_session', status: 'failed', occurredAt: 1,
      code: 'agent_startup_transport_failed', source: 'agent_session_error', agentId: 'codex',
      failureCause: readCodexAppServerFailureCause(failure) });
    const message = issue?.failureCause?.providerErrorMessage;
    const classified = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', error: failure });
    for (const preview of [diagnostic, message, classified.sanitizedPreview, classified.failureCause?.providerErrorMessage]) {
      expect(preview).toContain(`EACCES ${payload.environment.CODEX_HOME}`);
      expect(preview).toContain(`missing ${payload.environment.CODEX_SQLITE_HOME}`);
      expect(preview).toContain('native-startup-refused [REDACTED]');
      expect(preview).not.toContain(secret);
      expect(preview).not.toContain(JSON.stringify(secret).slice(1, -1));
      expect(Buffer.byteLength(preview!)).toBeLessThanOrEqual(SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
    }
    expect(message).toContain('stage=child_exit');
    expect(message).toContain('exitCode=23');
    expect(message).toContain('native-startup-refused [REDACTED]');
    expect(message).not.toContain('private-native-token');
    expect(message!.length).toBeLessThanOrEqual(SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
    expect(JSON.stringify({ error, issue })).not.toContain(secret);
  });

  it('redacts an escaped credential spanning two stderr chunks before retaining the tail', async () => {
    const secret = 'synthetic-private\nprovider-"key"\\雪🔐';
    const payload = await launch([], { PROVIDER_API_KEY: secret });
    const capture = createAgentLaunchStderr(payload);
    const echo = Buffer.from(JSON.stringify(secret).slice(1, -1));
    // Split inside the JSON escape for the newline, with no OS coalescing.
    const splitAt = echo.indexOf(Buffer.from('\\n')) + 1;
    try {
      capture.stream.write(Buffer.concat([Buffer.from('old diagnostic '.repeat(2000) + 'native-startup-refused '), echo.subarray(0, splitAt)]));
      await new Promise<void>(resolve => capture.stream.end(Buffer.concat([echo.subarray(splitAt), Buffer.from(' safe-tail')]), resolve));
      expect(capture.readTail()).toContain('native-startup-refused [REDACTED] safe-tail');
      expect(capture.readTail()).not.toContain(echo.toString());
      expect(Buffer.byteLength(capture.readTail())).toBeLessThanOrEqual(SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
    } finally { capture.close(); }
  });

  it('redacts an unregistered labelled credential before the stderr tail boundary cuts its label', async () => {
    const payload = await launch([]);
    const capture = createAgentLaunchStderr(payload);
    const secret = 'private-boundary-credential'.repeat(SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
    try {
      await new Promise<void>(resolve => capture.stream.end(`Bearer ${secret} safe-tail`, resolve));
      expect(capture.readTail()).toBe('Bearer [REDACTED] safe-tail');
      expect(capture.readTail()).not.toContain('credential');
      expect(Buffer.byteLength(capture.readTail())).toBeLessThanOrEqual(SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
    } finally { capture.close(); }
  });

  it('keeps a labelled credential spanning writes intact until it can be redacted', async () => {
    const capture = createAgentLaunchStderr(await launch([]));
    try {
      capture.stream.write('native-startup-refused Bearer private-');
      await new Promise<void>(resolve => capture.stream.end('native-token safe-tail', resolve));
      expect(capture.readTail()).toBe('native-startup-refused Bearer [REDACTED] safe-tail');
    } finally { capture.close(); }
  });

  for (const runtime of ['node', 'bun'] as const) {
  it.skipIf(process.getuid?.() === 0 || runtime === 'bun' && !hasBun).each(['child_exit', 'inaccessible cwd', 'unusable cache'] as const)(
    `retains the final %s through the real ${runtime} shim without forced process exit`, async kind => {
    const payload = await launch(['-e', `
      require('node:fs').writeSync(2, 'old diagnostic '.repeat(2000));
      require('node:fs').writeSync(2, 'native-startup-refused ' + process.env.PROVIDER_API_KEY + '\\n');
      process.exit(23);
    `], { PROVIDER_API_KEY: 'synthetic-private-provider-key' });
    const privateDirectory = join(payload.cwd, 'private-cwd');
    if (kind === 'inaccessible cwd') { await mkdir(privateDirectory); await chmod(privateDirectory, 0); }
    // The Agent HOME is the mocked userInfo homedir (payload.cwd); a file there fails identity-cache preparation before any exec.
    if (kind === 'unusable cache') await writeFile(join(payload.cwd, '.cache'), '');
    const entry = join(payload.cwd, 'shim.cjs');
    // OS identity is the sole simulated boundary. The actual frame, command,
    // supervisor, native child, redaction and issue projection remain real.
    await build({ stdin: { contents: `
      import { handleAgentLaunchCliCommand } from ${JSON.stringify(fileURLToPath(new URL('../../cli/commands/agentLaunch.ts', import.meta.url)))};
      void handleAgentLaunchCliCommand({ args: ['agent-launch'] });
    `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)) },
      outfile: entry, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
      define: { 'import.meta.url': JSON.stringify(new URL('../../cli/commands/agentLaunch.ts', import.meta.url).href) },
      tsconfig: fileURLToPath(new URL('../../../tsconfig.runtime.json', import.meta.url)),
      banner: { js: `
        require = require('node:module').createRequire(${JSON.stringify(fileURLToPath(new URL('../../../package.json', import.meta.url)))});
        const os = require('node:os'), current = os.userInfo();
        os.userInfo = () => ({ ...current, username: 'happier-agent', homedir: ${JSON.stringify(payload.cwd)} });
      ` },
    });
    const supervised = spawnSupervisedPluginProcess({ command: runtime === 'bun' ? bunCommand : process.execPath,
      args: [entry], cwd: payload.cwd, env: process.env,
      stdinPreamble: encodeAgentLaunchFrame(kind === 'inaccessible cwd' ? { ...payload, cwd: privateDirectory } : payload), maxStdoutBytes: 0,
      maxStderrBytes: SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH });
    try {
      const result = await supervised.handle.wait();
      const error = createPluginExecClientExitError({ exitCode: result.termination.observed.kind === 'exit'
        ? result.termination.observed.exitCode : null, signal: null }, Buffer.from(result.stderr).toString());
      const failure = createCodexAppServerTurnFailure({ phase: 'client_start', value: error });
      const cause = readCodexAppServerFailureCause(failure);
      const stage = { child_exit: 'stage=child_exit', 'inaccessible cwd': 'stage=exec errno=EACCES',
        'unusable cache': 'stage=prepare code=agent_launch_material_invalid' }[kind];
      expect(cause.providerErrorMessage).toContain(stage);
      if (kind === 'child_exit') expect(cause.providerErrorMessage).toContain('native-startup-refused [REDACTED]');
      expect(cause.providerErrorMessage).not.toContain(payload.environment.PROVIDER_API_KEY);
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex', error: failure });
      expect(issue.sanitizedPreview).toContain(kind === 'child_exit' ? 'native-startup-refused [REDACTED]' : stage);
    } finally {
      await supervised.dispose();
      if (kind === 'inaccessible cwd') await chmod(privateDirectory, 0o700);
    }
  // This fixture compiles a shim and joins real subprocess custody; reuse the
  // CLI integration lane's test budget (vitest.integration.config.ts).
  }, 60_000);
  }

  it('identifies caller cancellation before shutdown closes the child streams', async () => {
    const payload = await launch(['-e', 'process.stdout.write("ready");process.stdin.resume()']);
    const controller = new AbortController();
    const stdout = new PassThrough();
    stdout.once('data', () => controller.abort());
    await expect(executeAgentLaunchPayload(payload, { agentHome: payload.cwd, input: new PassThrough(), stdout,
      stderr: new PassThrough(), signal: controller.signal })).rejects.toMatchObject({
      code: 'agent_launch_cancelled', stage: 'caller_cancelled',
    });
  });

  it('distinguishes a native child signal from caller cancellation', async () => {
    const payload = await launch(['-e', 'process.kill(process.pid, "SIGTERM")']);
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stderr.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await expect(executeAgentLaunchPayload(payload, { agentHome: payload.cwd, input: new PassThrough(),
      stdout: new PassThrough(), stderr })).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    expect(Buffer.concat(chunks).toString()).toContain('stage=child_exit exitCode=null signal=SIGTERM');
  });

  it('keeps an initiating stdout failure when cleanup subsequently terminates the child', async () => {
    const payload = await launch(['-e', 'process.stdout.write("ready");process.stdin.resume()']);
    const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('private-stream-error')); } });
    await expect(executeAgentLaunchPayload(payload, { agentHome: payload.cwd, input: new PassThrough(), stdout,
      stderr: new PassThrough() })).rejects.toMatchObject({ stage: 'stdout' });
  });

  it.each(['stdin', 'stderr'] as const)('identifies the initiating %s stream failure', async stage => {
    const payload = await launch(['-e', 'process.stdout.write("ready");process.stderr.write("diagnostic");'
      + (stage === 'stdin' ? 'process.stdin.resume()' : '')]);
    const input = new PassThrough();
    const stdout = new PassThrough();
    if (stage === 'stdin') stdout.once('data', () => input.destroy(new Error('private-input-error')));
    const stderr = stage === 'stderr'
      ? new Writable({ write(_chunk, _encoding, callback) { callback(new Error('private-stderr-error')); } })
      : new PassThrough();
    await expect(executeAgentLaunchPayload(payload, { agentHome: payload.cwd, input, stdout, stderr }))
      .rejects.toMatchObject({ stage });
  });
});
