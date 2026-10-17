import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { query } from './query';
import { createClaudeProviderActivityLedger } from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { isPidAlive } from '@/testkit/process/spawn';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createDeferred } from '@/testkit/async/deferred';
import { logger } from '@/ui/logger';
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import type { SessionRuntimeActivityContribution } from '@/session/runtimeActivity/types';
import { ClaudeNativeProviderExitUnverifiedError } from './types';

// Record real OS children so cleanup assertions wait for the actual close boundary.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function createTempJsScript(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'happier-claude-sdk-query-'));
  const file = join(dir, 'fake-claude.js');
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('claude sdk query exit handling', () => {
  let tmpRoot = '';

  afterEach(() => {
    vi.doUnmock('ps-list');
    vi.resetModules();

    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  it.runIf(process.platform !== 'win32').each(['native-exit', 'javascript-in-launcher', 'wrapper-operation-error'] as const)('requires positive provider exit proof when the legacy wrapper exits normally (%s)', async (outcome) => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-native-proof-'));
    const pidPath = join(tmpRoot, 'native-pid');
    const provider = writeExecutableShimSync({ dir: tmpRoot, fileName: outcome === 'javascript-in-launcher' ? 'provider.cjs' : 'provider', contents: `#!${process.execPath}
      process.on('SIGUSR1', () => process.exit(0));
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'owned-session' }));
      setInterval(() => {}, 1000);
    ` });
    const preload = join(tmpRoot, 'os-spawn-error.cjs');
    // Inject a post-spawn operation failure only at the real native child OS adapter.
    writeFileSync(preload, `const cp = require('node:child_process'); const spawn = cp.spawn;
      cp.spawn = (...args) => { const child = spawn(...args);
        child.once('spawn', () => process.nextTick(() => child.emit('error', new Error('owned native operation failed'))));
        return child; };
    `);
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'native-child' });
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async () => {}, markUnknown: async () => {}, dispose: async () => {} } });
    const spawnIndex = vi.mocked(spawn).mock.results.length;
    const q = query({ prompt: 'hi', options: {
      cwd: tmpRoot, executable: process.execPath,
      executableArgs: outcome === 'wrapper-operation-error' ? ['--require', preload] : [],
      pathToClaudeCodeExecutable: resolveCliRuntimeAssetPath('scripts', 'claude_remote_launcher.cjs'),
      env: { HAPPIER_CLAUDE_PATH: provider },
    }, onProcessExited: async ({ nativeExited, processTreeStopped }) => {
      const providerStopped = nativeExited || processTreeStopped;
      await adapter.handleRuntimeLoss('claude_process_exit', { providerStopped });
      if (!providerStopped) throw new ClaudeNativeProviderExitUnverifiedError();
    } });
    const wrapperResult = vi.mocked(spawn).mock.results[spawnIndex];
    if (wrapperResult?.type !== 'return') throw new Error('Expected actual owned wrapper');
    const exited = once(wrapperResult.value, 'exit');
    let nativePid: number | undefined;
    let returned: ReturnType<typeof q.return> | undefined;
    try {
      await vi.waitFor(() => { nativePid = Number(readFileSync(pidPath, 'utf8')); });
      if (outcome !== 'wrapper-operation-error') process.kill(nativePid!, 'SIGUSR1');
      expect((await exited)[1]).toBeNull();
      returned = q.return();
      if (outcome !== 'wrapper-operation-error') {
        await expect(withTimeout(returned, 5000, 'proven native exit')).resolves.toMatchObject({ done: true });
        expect(ledger.getActiveProviderTaskCount()).toBe(0);
      } else {
        await expect(withTimeout(returned, 5000, 'unverified normal wrapper exit with pipes open')).rejects.toMatchObject({ code: 'claude_native_provider_exit_unverified' });
        expect(isPidAlive(nativePid!)).toBe(true);
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
      }
    } finally {
      await killProcessTree({ pid: nativePid });
      await killProcessTree(wrapperResult.value);
      await returned?.catch(() => undefined);
    }
  });

  it('keeps background tasks through stream failure and retires them after owned process exit', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-owned-exit-'));
    const script = join(tmpRoot, 'provider.cjs');
    writeFileSync(script, "console.log('invalid stream-json'); setInterval(() => {}, 1000);");
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'background-child' });
    const adapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: ledger,
      contributionHandle: { report: async () => {}, markUnknown: async () => {}, dispose: async () => {} },
    });
    await adapter.activateObservation('test-observer-installed');
    let processExited = false;
    const response = query({
      prompt: 'hi',
      options: { cwd: tmpRoot, executable: process.execPath, pathToClaudeCodeExecutable: script },
      onProcessExited: async () => {
        processExited = true;
        await adapter.handleRuntimeLoss('claude_process_exit', { providerStopped: true });
      },
    });
    const iterator = response[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).rejects.toThrow('non-JSON output');
      expect(processExited).toBe(false);
      expect(ledger.getActiveProviderTaskCount()).toBe(1);
      await iterator.return?.();
      expect(processExited).toBe(true);
      expect(ledger.getActiveProviderTaskCount()).toBe(0);
    } finally {
      await response.return();
    }
  });

  it('retires tasks after an aborted legacy child physically exits', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-abort-exit-'));
    const script = join(tmpRoot, 'provider.cjs');
    writeFileSync(script, "console.log(JSON.stringify({ type: 'system', subtype: 'init' })); setInterval(() => {}, 1000);");
    const abort = new AbortController();
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'background-child' });
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async () => {}, markUnknown: async () => {}, dispose: async () => {} } });
    const response = query({ prompt: 'hi', options: {
      cwd: tmpRoot, executable: process.execPath, pathToClaudeCodeExecutable: script, abort: abort.signal,
    }, onProcessExited: () => adapter.handleRuntimeLoss('claude_process_exit', { providerStopped: true }) });
    try {
      await response.next();
      abort.abort();
      await response.return();
      expect(ledger.getActiveProviderTaskCount()).toBe(0);
    } finally {
      await response.return();
    }
  });

  it('keeps rejecting exit-publication details out of default activity diagnostics', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-exit-publication-'));
    const script = join(tmpRoot, 'provider.cjs');
    writeFileSync(script, 'setTimeout(() => process.exit(0), 30);');
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'background-child' });
    const transportError = new Error('boundary-sensitive-value');
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: {
        report: async (snapshot) => { if (snapshot.state === 'idle') throw transportError; },
        markUnknown: async () => {}, dispose: async () => {},
      } });
    await adapter.activateObservation('observer-installed');
    const defaultLog = vi.spyOn(logger, 'infoFile');
    const response = query({ prompt: 'hi',
      options: { cwd: tmpRoot, executable: process.execPath, pathToClaudeCodeExecutable: script },
      onProcessExited: () => adapter.handleRuntimeLoss('claude_process_exit', { providerStopped: true }),
    });
    try {
      await expect(response.next()).rejects.toBe(transportError);
      await expect(response.return()).rejects.toBe(transportError);
      expect(ledger.getActiveProviderTaskCount()).toBe(0);
      expect(defaultLog).toHaveBeenCalledWith(expect.any(String), { state: 'idle' });
      expect(inspect(defaultLog.mock.calls)).not.toContain('boundary-sensitive-value');
    } finally {
      await response.return().catch(() => undefined);
      defaultLog.mockRestore();
    }
  });

  it('surfaces owned termination failure without claiming that the provider exited', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-termination-denied-'));
    const script = join(tmpRoot, 'provider.cjs');
    writeFileSync(script, "console.log(JSON.stringify({ type: 'system', subtype: 'init', pid: process.pid })); setInterval(() => {}, 1000);");
    let providerPid: number | undefined;
    let processExited = false;
    const response = query({
      prompt: 'hi', options: { cwd: tmpRoot, executable: process.execPath, pathToClaudeCodeExecutable: script },
      onMessageReceived: (message) => {
        if ('pid' in message && typeof message.pid === 'number') providerPid = message.pid;
      },
      onProcessExited: () => { processExited = true; },
    });
    await response.next();
    if (providerPid === undefined) throw new Error('Expected the real owned provider PID');
    const signal = process.kill.bind(process);
    const childKill = ChildProcess.prototype.kill;
    // Genuine OS signal/probe denials, restricted to this fixture's owned root.
    const deniedSignal = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
      if (Math.abs(pid) === providerPid) throw Object.assign(new Error('Fixture signal denied'), { code: 'EPERM' });
      return signal(pid, requestedSignal);
    });
    const deniedChildKill = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (this: ChildProcess, requestedSignal) {
      if (this.pid === providerPid) throw Object.assign(new Error('Fixture signal denied'), { code: 'EPERM' });
      return childKill.call(this, requestedSignal);
    });
    const returning = response.return();
    void returning.catch(() => undefined);
    try {
      await expect(withTimeout(returning, 5000, 'owned query termination failure')).rejects.toMatchObject({
        code: 'process_tree_termination_incomplete',
      });
      expect(processExited).toBe(false);
    } finally {
      deniedSignal.mockRestore();
      deniedChildKill.mockRestore();
      await killProcessTree({ pid: providerPid });
      await returning.catch(() => undefined);
    }
  });

  it('preserves tasks at legacy parent turn end and awaits owned exit before replacement admission', async () => {
    const { claudeRemote } = await import('../claudeRemote');
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-legacy-owned-exit-'));
    const script = join(tmpRoot, 'provider.cjs');
    const hookSettingsPath = join(tmpRoot, 'hooks.json');
    writeFileSync(hookSettingsPath, '{}');
    writeFileSync(script, `
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'owned-session', pid: process.pid }));
      process.stdin.once('data', () => console.log(JSON.stringify({ type: 'result', subtype: 'success' })));
      setInterval(() => {}, 1000);
    `);
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'HAPPIER_JS_RUNTIME_PATH']);
    env.patch({ HAPPIER_CLAUDE_PATH: script, HAPPIER_JS_RUNTIME_PATH: process.execPath });
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'background-child' });
    const runtimeActivity = createSessionRuntimeActivity('supported');
    const reports: SessionRuntimeActivityContribution[] = [];
    await runtimeActivity.bindPublisher({ publish: async snapshot => { reports.push(snapshot); }, close: async () => {} });
    const contributionHandle = runtimeActivity.agentRuntimeContributionHandle;
    if (!contributionHandle) throw new Error('Expected supported runtime Activity handle');
    const adapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: ledger,
      contributionHandle,
    });
    let initialRead = false;
    let providerPid: number | undefined;
    const countsAtParentTurnEnd: number[] = [];
    try {
      await claudeRemote({
        path: tmpRoot, sessionId: null, transcriptPath: null, hookSettingsPath,
        runtimeActivityAdapter: adapter,
        nextMessage: async () => {
          if (initialRead) return null;
          initialRead = true;
          return { message: 'hi', mode: { permissionMode: 'default' } };
        },
        onReady: () => { countsAtParentTurnEnd.push(ledger.getActiveProviderTaskCount()); },
        onSessionFound: () => {},
        onMessage: (message) => {
          if (message.type === 'system' && message.subtype === 'init' && 'pid' in message && typeof message.pid === 'number') {
            providerPid = message.pid;
          }
        },
        isAborted: () => false,
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      });
      expect(countsAtParentTurnEnd).toEqual([1]);
      expect(providerPid).toBeTypeOf('number');
      if (providerPid === undefined) throw new Error('Expected the real provider process identity');
      expect(isPidAlive(providerPid)).toBe(false);
      expect(ledger.getActiveProviderTaskCount()).toBe(0);
      expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
      // The remote launcher starts each replacement through this boundary before installing its observer.
      await adapter.publishBeforeRuntimeStart('claude-remote-provider-not-started');
      await adapter.activateObservation('replacement-provider-observer-installed');
      await adapter.observeActivity({ evidence: 'live', activity: { type: 'started', sessionId: 'owned-session', taskId: 'replacement-child' } });
      expect(ledger.getActiveProviderTaskBlockers().map(task => task.taskId)).toEqual(['replacement-child']);
      expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
    } finally {
      env.restore();
      await runtimeActivity.dispose();
    }
  });

  it.runIf(process.platform !== 'win32')('accepts clean provider exit through an extensionless symlink to JavaScript', async () => {
    const { claudeRemote } = await import('../claudeRemote');
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-legacy-js-symlink-'));
    const script = join(tmpRoot, 'cli.js');
    const cliPath = join(tmpRoot, 'claude');
    const hookSettingsPath = join(tmpRoot, 'hooks.json');
    writeFileSync(hookSettingsPath, '{}');
    writeFileSync(script, `
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'owned-session', pid: process.pid }));
      process.stdin.once('data', () => {
        console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
        process.exit(0);
      });
    `, { mode: 0o755 });
    symlinkSync(script, cliPath);
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'HAPPIER_JS_RUNTIME_PATH']);
    env.patch({ HAPPIER_CLAUDE_PATH: cliPath, HAPPIER_JS_RUNTIME_PATH: process.execPath });
    const runtimeActivity = createSessionRuntimeActivity('supported');
    const reports: SessionRuntimeActivityContribution[] = [];
    await runtimeActivity.bindPublisher({ publish: async snapshot => { reports.push(snapshot); }, close: async () => {} });
    const contributionHandle = runtimeActivity.agentRuntimeContributionHandle;
    if (!contributionHandle) throw new Error('Expected supported runtime Activity handle');
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'background-child' });
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger, contributionHandle });
    const providerExited = createDeferred<void>();
    let initialRead = false;
    try {
      await claudeRemote({
        path: tmpRoot, sessionId: null, transcriptPath: null, hookSettingsPath,
        runtimeActivityAdapter: adapter,
        nextMessage: async () => {
          if (initialRead) { await providerExited.promise; return null; }
          initialRead = true;
          return { message: 'hi', mode: { permissionMode: 'default' } };
        },
        onReady: () => {}, onSessionFound: () => {},
        onMessage: (message) => {
          if (!('pid' in message) || typeof message.pid !== 'number') return;
          const result = vi.mocked(spawn).mock.results.find(result => result.type === 'return' && result.value.pid === message.pid);
          if (!result || result.type !== 'return') throw new Error('Expected the actual owned JavaScript provider');
          if (result.value.exitCode !== null || result.value.signalCode !== null) providerExited.resolve();
          else result.value.once('exit', () => providerExited.resolve());
        },
        isAborted: () => false,
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      });
      expect(ledger.getActiveProviderTaskCount()).toBe(0);
      expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
    } finally {
      env.restore();
      await runtimeActivity.dispose();
    }
  });

  it.each([false, true])('keeps a relinquished legacy query from clearing replacement tasks after failed cleanup (runtime failure: %s)', async (runtimeFails) => {
    const { claudeRemote } = await import('../claudeRemote');
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-legacy-late-exit-'));
    const script = join(tmpRoot, 'provider.cjs');
    const hookSettingsPath = join(tmpRoot, 'hooks.json');
    writeFileSync(hookSettingsPath, '{}');
    writeFileSync(script, `
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'owned-session', pid: process.pid }));
      process.stdin.once('data', () => console.log(JSON.stringify({ type: 'result', subtype: 'success' })));
      setInterval(() => {}, 1000);
    `);
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'HAPPIER_JS_RUNTIME_PATH']);
    env.patch({ HAPPIER_CLAUDE_PATH: script, HAPPIER_JS_RUNTIME_PATH: process.execPath });
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'old-child' });
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async () => {}, markUnknown: async () => {}, dispose: async () => {} } });
    const signal = process.kill.bind(process);
    let providerPid: number | undefined;
    let initialRead = false;
    let restoreDenied: (() => void) | undefined;
    const runtimeError = new Error('legacy-runtime-failure');
    try {
      const result = claudeRemote({ path: tmpRoot, sessionId: null, transcriptPath: null, hookSettingsPath,
        runtimeActivityAdapter: adapter,
        nextMessage: async () => {
          if (initialRead) return null;
          initialRead = true;
          return { message: 'hi', mode: { permissionMode: 'default' } };
        },
        onReady: () => {
          const denied = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
            if (Math.abs(pid) === providerPid) throw Object.assign(new Error('Fixture signal denied'), { code: 'EPERM' });
            return signal(pid, requestedSignal);
          });
          restoreDenied = () => denied.mockRestore();
          if (runtimeFails) throw runtimeError;
        },
        onSessionFound: () => {}, onMessage: (message) => {
          if ('pid' in message && typeof message.pid === 'number') providerPid = message.pid;
        }, isAborted: () => false, canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      });
      if (runtimeFails) await expect(result).rejects.toMatchObject({ errors: [runtimeError, { code: 'process_tree_termination_incomplete' }] });
      else await expect(result).rejects.toMatchObject({ code: 'process_tree_termination_incomplete' });
      restoreDenied?.();
      const childResult = vi.mocked(spawn).mock.results.find(result => result.type === 'return' && result.value.pid === providerPid);
      if (!childResult || childResult.type !== 'return') throw new Error('Expected the actual owned legacy child');
      const closed = once(childResult.value, 'close');
      await adapter.observeActivity({ evidence: 'live', activity: { type: 'started', sessionId: 'owned-session', taskId: 'replacement-child' } });
      await killProcessTree({ pid: providerPid });
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ledger.getActiveProviderTaskBlockers().map(task => task.taskId)).toEqual(['old-child', 'replacement-child']);
    } finally {
      restoreDenied?.();
      await killProcessTree({ pid: providerPid });
      env.restore();
    }
  });

  it.runIf(process.platform !== 'win32').each(['direct', 'retargeted-symlink', 'awaiting-next'])('keeps native provider tasks when only the legacy wrapper is killed (%s)', async (launchPathKind) => {
    const { claudeRemote } = await import('../claudeRemote');
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-legacy-native-wrapper-exit-'));
    const script = writeExecutableShimSync({ dir: tmpRoot, fileName: 'provider', contents: `#!${process.execPath}
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'owned-session', pid: process.pid }));
      process.stdin.once('data', () => {
        console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
      });
      setInterval(() => {}, 1000);
    ` });
    const hookSettingsPath = join(tmpRoot, 'hooks.json');
    writeFileSync(hookSettingsPath, '{}');
    const cliPath = launchPathKind === 'retargeted-symlink' ? join(tmpRoot, 'claude') : script;
    if (cliPath !== script) symlinkSync(script, cliPath);
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'HAPPIER_JS_RUNTIME_PATH']);
    env.patch({ HAPPIER_CLAUDE_PATH: cliPath, HAPPIER_JS_RUNTIME_PATH: process.execPath });
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'native-child' });
    const terminalObservation = createDeferred<void>();
    let awaitingExit = false;
    const runtimeActivity = createSessionRuntimeActivity('supported');
    await runtimeActivity.bindPublisher({
      publish: async snapshot => { if (awaitingExit && snapshot.state !== 'active') terminalObservation.resolve(); },
      close: async () => {},
    });
    const contributionHandle = runtimeActivity.agentRuntimeContributionHandle;
    if (!contributionHandle) throw new Error('Expected supported runtime Activity handle');
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger, contributionHandle });
    let initialRead = false;
    let nativePid: number | undefined;
    const providerLaunched = createDeferred<void>();
    const spawnIndex = vi.mocked(spawn).mock.results.length;
    let result: ReturnType<typeof claudeRemote> | undefined;
    try {
      result = claudeRemote({ path: tmpRoot, sessionId: null, transcriptPath: null, hookSettingsPath,
        runtimeActivityAdapter: adapter,
        nextMessage: async () => {
          if (initialRead && launchPathKind !== 'awaiting-next') return null;
          initialRead = true;
          return { message: 'hi', mode: { permissionMode: 'default' } };
        },
        onReady: async () => {
          const wrapperResult = vi.mocked(spawn).mock.results[spawnIndex];
          if (wrapperResult?.type !== 'return' || !wrapperResult.value.pid) throw new Error('Expected actual wrapper PID');
          if (cliPath !== script) {
            const replacement = join(tmpRoot, 'cli.js');
            writeFileSync(replacement, '', { mode: 0o755 });
            unlinkSync(cliPath);
            symlinkSync(replacement, cliPath);
          }
          awaitingExit = true;
          process.kill(wrapperResult.value.pid, 'SIGKILL');
          await withTimeout(terminalObservation.promise, 5000, 'native wrapper exit observation');
        },
        onSessionFound: () => {}, onMessage: (message) => {
          if ('pid' in message && typeof message.pid === 'number') {
            nativePid = message.pid;
            providerLaunched.resolve();
          }
        }, isAborted: () => false, canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      });
      void result.catch(() => undefined);
      await providerLaunched.promise;
      await terminalObservation.promise;
      if (nativePid === undefined) throw new Error('Expected actual native provider PID');
      expect(isPidAlive(nativePid)).toBe(true);
      expect(ledger.getActiveProviderTaskCount()).toBe(1);
      const error = await withTimeout(result.then(() => undefined, (failure: unknown) => failure), 5000, 'native wrapper exit with inherited streams open');
      expect(error).toMatchObject({ code: 'claude_native_provider_exit_unverified' });
      expect(error).not.toBeInstanceOf(AggregateError);
    } finally {
      await killProcessTree({ pid: nativePid });
      await result?.catch(() => undefined);
      env.restore();
      await runtimeActivity.dispose();
    }
  });

  it.runIf(process.platform !== 'win32')('does not treat cleanup started after wrapper exit as proof that its native provider stopped', async () => {
    const { claudeRemote } = await import('../claudeRemote');
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-legacy-post-exit-cleanup-'));
    const script = writeExecutableShimSync({ dir: tmpRoot, fileName: 'provider', contents: `#!${process.execPath}
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'owned-session', pid: process.pid }));
      process.stdin.once('data', () => console.log(JSON.stringify({ type: 'result', subtype: 'success' })));
      setInterval(() => {}, 1000);
    ` });
    const hookSettingsPath = join(tmpRoot, 'hooks.json');
    writeFileSync(hookSettingsPath, '{}');
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'HAPPIER_JS_RUNTIME_PATH']);
    env.patch({ HAPPIER_CLAUDE_PATH: script, HAPPIER_JS_RUNTIME_PATH: process.execPath });
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'owned-session', taskId: 'native-child' });
    const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async () => {}, markUnknown: async () => {}, dispose: async () => {} } });
    const runtimeError = new Error('fixture-consumer-finished');
    let initialRead = false;
    let nativePid: number | undefined;
    const spawnIndex = vi.mocked(spawn).mock.results.length;
    const result = claudeRemote({ path: tmpRoot, sessionId: null, transcriptPath: null, hookSettingsPath,
      runtimeActivityAdapter: adapter,
      nextMessage: async () => {
        if (initialRead) return null;
        initialRead = true;
        return { message: 'hi', mode: { permissionMode: 'default' } };
      },
      onReady: async () => {
        const wrapperResult = vi.mocked(spawn).mock.results[spawnIndex];
        if (wrapperResult?.type !== 'return' || !wrapperResult.value.pid) throw new Error('Expected actual wrapper PID');
        const exited = once(wrapperResult.value, 'exit');
        process.kill(wrapperResult.value.pid, 'SIGKILL');
        await exited;
        throw runtimeError;
      },
      onSessionFound: () => {}, onMessage: (message) => {
        if ('pid' in message && typeof message.pid === 'number') nativePid = message.pid;
      }, isAborted: () => false, canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    });
    const settled = result.then(() => undefined, (error: unknown) => error);
    try {
      const error = await withTimeout(settled, 5000, 'native wrapper exit observation with pipes open');
      if (nativePid === undefined) throw new Error('Expected actual native provider PID');
      expect(isPidAlive(nativePid)).toBe(true);
      expect(ledger.getActiveProviderTaskCount()).toBe(1);
      expect(error).toMatchObject({ errors: [runtimeError, { code: 'claude_native_provider_exit_unverified' }] });
    } finally {
      await killProcessTree({ pid: nativePid });
      await settled;
      env.restore();
    }
  });

  it('rejects the consumer when the subprocess exits non-zero (no hang)', async () => {
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    const script = createTempJsScript(`
      setTimeout(() => process.exit(7), 25);
    `);

    try {
      const q = query({
        prompt: 'hi',
        options: {
          cwd: tmpdir(),
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: script,
        },
      });

      const iter = q[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow('Claude Code process exited with code 7');
    } finally {
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
    }
  });

  it('completes the consumer when the subprocess exits 0', async () => {
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    const script = createTempJsScript(`
      setTimeout(() => process.exit(0), 25);
    `);

    try {
      const q = query({
        prompt: 'hi',
        options: {
          cwd: tmpdir(),
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: script,
        },
      });

      const iter = q[Symbol.asyncIterator]();
      const result = await iter.next();
      expect(result.done).toBe(true);
    } finally {
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
    }
  });

  it('rejects the consumer when the subprocess emits non-JSON output in stream-json mode (auth failure)', async () => {
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    const script = createTempJsScript(`
      console.log('Not logged in · Please run /login');
      setTimeout(() => process.exit(0), 25);
    `);

    try {
      const q = query({
        prompt: 'hi',
        options: {
          cwd: tmpdir(),
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: script,
        },
      });

      const iter = q[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow(/not logged in/i);
    } finally {
      if (originalDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = originalDebug;
    }
  });

  it('terminates descendants synchronously when the parent receives exit', { timeout: 20_000 }, async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'happier-claude-query-exit-'));
    const sleeper = join(tmpRoot, `sleep-${Date.now()}.js`);
    const markerPath = join(tmpRoot, 'marker.json');
    writeFileSync(
      sleeper,
      `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const markerPath = ${JSON.stringify(markerPath)};
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        writeFileSync(markerPath, JSON.stringify({ childPid: child.pid }), 'utf8');

        // Stay alive until the parent terminates us.
        setInterval(() => {}, 1000);
      `,
      'utf8',
    );

    vi.doMock('ps-list', async () => ({
      default: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return [];
      },
    }));

    const originalProcessOn = process.on.bind(process);
    let exitHandler: (() => void) | undefined;
    const processOnSpy = vi.spyOn(process, 'on').mockImplementation(((...args: Parameters<typeof process.on>) => {
      const [event, listener] = args;
      if (event === 'exit') {
        const exitListener = listener as NodeJS.ExitListener;
        exitHandler = () => exitListener(0);
      }
      return originalProcessOn(...args);
    }) as typeof process.on);

    try {
      const { query: reloadedQuery } = await import('./query');

      const q = reloadedQuery({
        prompt: 'hi',
        options: {
          cwd: tmpRoot,
          executable: process.execPath,
          executableArgs: [],
          pathToClaudeCodeExecutable: sleeper,
        },
      });

      const marker = await new Promise<{ childPid: number }>((resolve, reject) => {
        const startedAt = Date.now();
        const poll = () => {
          try {
            resolve(JSON.parse(readFileSync(markerPath, 'utf8')) as { childPid: number });
          } catch (error) {
            if (Date.now() - startedAt > 5_000) {
              reject(error);
              return;
            }
            setTimeout(poll, 25);
          }
        };
        poll();
      });

      const iter = q[Symbol.asyncIterator]();
      const nextPromise = withTimeout(iter.next(), 5_000, 'query to terminate after exit');
      void nextPromise.catch(() => undefined);

      expect(exitHandler).toBeTypeOf('function');
      if (!exitHandler) {
        throw new Error('Expected process exit handler to be registered');
      }
      exitHandler();

      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const check = () => {
            try {
              process.kill(marker.childPid, 0);
              if (Date.now() - startedAt > 250) {
                reject(new Error(`Timed out waiting for descendant ${marker.childPid} to exit after process exit`));
                return;
              }
              setTimeout(check, 25);
            } catch {
              resolve();
            }
          };
          check();
        }),
        500,
        'descendant cleanup after exit',
      );

      await expect(nextPromise).rejects.toThrow(/Claude Code process/i);
    } finally {
      processOnSpy.mockRestore();
    }
  });
});
