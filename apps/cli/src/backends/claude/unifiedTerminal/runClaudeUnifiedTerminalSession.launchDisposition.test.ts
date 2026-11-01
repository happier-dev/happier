import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'child_process';
import { spawn } from 'node:child_process';

import type {
  TerminalAttachmentId,
  TerminalHostAdapter,
  TerminalHostHandle,
} from '@/integrations/terminalHost/_types';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';
import { buildClaudeUnifiedTerminalSpawn } from './buildClaudeUnifiedTerminalSpawn';
import { requestClaudeExplicitRunnerStop } from '../claudeExplicitRunnerStop';
import { logger } from '@/ui/logger';
import { createTmuxTerminalHostAdapter, TmuxUtilities } from '@/integrations/tmux';
import { launchOwnedTerminalProcess } from '@/terminal/runtime/ownedTerminalProcess';
import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';
import { reloadConfiguration } from '@/configuration';
import { createClaudeProviderActivityLedger } from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import type { SessionHookData } from '../utils/startHookServer';
import { createDeferred } from '@/testkit/async/deferred';
import { resolveClaudeRemoteLaunchErrorDisposition } from '../claudeRemoteLauncher';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import { createFakeControlPort } from './tuiControls/fakeControlPort';
import { resolveTerminalPromptWriteBudget } from '@/agent/runtime/terminal/injection/promptWriteTimeout';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const attachmentId = 'attachment-adopted-resume' as TerminalAttachmentId;
const existingHandle: TerminalHostHandle = {
  attachmentId,
  kind: 'tmux',
  sessionName: 'happier-adopted-resume',
  paneId: '%1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};
const existingAttachment: TerminalAttachmentInfo = {
  version: 2,
  attachmentId,
  sessionId: 'happy-adopted-resume',
  handle: existingHandle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
  terminal: {
    mode: 'tmux',
    tmux: { target: 'happier-adopted-resume:%1' },
  },
  updatedAt: 1,
};

function createAdapter(overrides: Partial<TerminalHostAdapter> = {}): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: vi.fn(async () => existingHandle),
    injectUserPrompt: vi.fn(async () => ({
      status: 'injected' as const,
      at: Date.now(),
      bytesWritten: 0,
    })),
    interruptTurn: vi.fn(async () => undefined),
    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function baseOptions(
  adapter: TerminalHostAdapter,
  abortController: AbortController,
): Parameters<typeof runClaudeUnifiedTerminalSession>[0] {
  return {
    path: '/workspace/project',
    happySessionId: 'happy-adopted-resume',
    sessionId: 'claude-resume-id',
    initialMode: {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    },
    nextMessage: async () => null,
    signal: abortController.signal,
    resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
    readTerminalHostAttachmentInfo: async () => null,
    buildSpawn: async () => ({ spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'], spawnEnv: {} }),
    createSessionName: () => 'happier-fresh-resume',
    processSignals: null,
    createController: async () => ({
      run: async () => undefined,
      dispose: async () => undefined,
    }),
  };
}

describe('runClaudeUnifiedTerminalSession launch disposition', () => {
  it.each([
    { menuVisible: true, closes: true, applications: 2 },
    { menuVisible: false, closes: true, applications: 2 },
    { menuVisible: true, closes: false, applications: 2 },
    { menuVisible: true, closes: true, applications: 0 },
  ])('releases the usage menu once at injection after concurrent exact applications (visible: $menuVisible, closes: $closes, applications: $applications)', async ({ menuVisible, closes, applications }) => {
    const menu = readFileSync(new URL('./tuiControls/__fixtures__/incident-89861-ratelimit-resume.ansi', import.meta.url), 'utf8');
    const idle = readFileSync(new URL('./tuiControls/__fixtures__/healthy-92862-idle.ansi', import.meta.url), 'utf8');
    let visible = menuVisible;
    const port = createFakeControlPort({ captures: [idle], onSendSpecialKey: (key) => {
      if (key === 'Escape' && closes) visible = false;
    } });
    // The terminal is the system boundary: captures reflect the effect of an actual key send.
    vi.spyOn(port, 'captureScreen').mockImplementation(async () => ({
      status: 'captured', capture: { text: visible ? menu : idle, capturedAtMs: 1, hostKind: 'tmux' },
    }));
    const wake = vi.fn();
    let exactApplication: (() => Promise<void>) | undefined;
    const adapter = createAdapter({
      createControlPort: () => port,
      injectUserPrompt: vi.fn(async () => {
        expect(visible).toBe(false);
        return { status: 'injected', at: 1, bytesWritten: 8 } as const;
      }),
    });
    const abort = new AbortController();
    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abort),
      registerConnectedServiceExactApplicationHandler: (handler) => { exactApplication = handler; },
      onConnectedServiceExactApplicationReleased: wake,
      createController: async ({ inputInjection }) => ({
        run: async () => {
          if (!exactApplication) throw new Error('Expected exact-application registration');
          const apply = exactApplication;
          await Promise.all(Array.from({ length: applications }, () => apply()));
          expect(wake).toHaveBeenCalledTimes(applications);
          expect(port.sentKeys).toEqual([]);
          await expect(inputInjection.injectUserPrompt({
            text: 'Continue', multiline: false,
            origin: { kind: 'ui_pending', clientId: 'test-client', nonce: 'continuation' },
            scheduling: { timeoutMs: resolveTerminalPromptWriteBudget('Continue').timeoutMs },
          })).resolves.toMatchObject({ status: menuVisible && !closes ? 'deferred' : 'injected' });
          expect(port.sentKeys).toEqual(menuVisible ? ['Escape'] : []);
          expect(visible).toBe(menuVisible && !closes);
          abort.abort();
        },
        dispose: async () => undefined,
      }),
    });
    expect(adapter.injectUserPrompt).toHaveBeenCalledTimes(menuVisible && !closes ? 0 : 1);
  });

  it.runIf(process.platform !== 'win32').each(['wrapper-died', 'termination-unproven'] as const)('retains provider tasks when the same-pane launcher dies with its native provider alive (%s)', async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-claude-unified-wrapper-death-'));
    const nativePidPath = join(directory, 'native-pid');
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(nativePidPath)},String(process.pid));setInterval(()=>{},1000)`],
      cwd: directory, env: { PATH: process.env.PATH ?? '' } });
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'claude-resume-id', taskId: 'native-child' });
    const states: string[] = [];
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async snapshot => { states.push(snapshot.state); },
        markUnknown: async () => { states.push('unknown'); }, dispose: async () => {} } });
    await runtimeActivityAdapter.activateObservation('fixture-native-provider');
    const abortController = new AbortController();
    let launcher: ReturnType<typeof spawn> | undefined;
    let nativePid: number | undefined;
    const spawnProcess = ((...args: Parameters<typeof spawn>) => {
      launcher = spawn(...args);
      return launcher;
    }) as typeof spawn;
    const session = runClaudeUnifiedTerminalSession({
      ...baseOptions(createAdapter(), abortController), path: directory, createController: undefined,
      currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
      providerActivityLedger: ledger, runtimeActivityAdapter,
      launchCurrentTerminalProcess: async () => launchOwnedTerminalProcess({ spawn: prepared, cwd: directory, spawnProcess,
        ...(outcome === 'termination-unproven' ? { terminateProcess: async (child) => { process.kill(child.pid!, 'SIGKILL'); } } : {}),
      }),
      persistTerminalHostAttachmentInfo: async () => {},
      onTerminalHostReady: async () => {
        await vi.waitFor(async () => { nativePid = Number(await readFile(nativePidPath, 'utf8')); });
        if (outcome === 'termination-unproven') abortController.abort();
        else launcher!.kill('SIGKILL');
      },
    });
    const settled = session.then(() => undefined, (error: unknown) => error);
    try {
      const error = await settled;
      expect(nativePid, String(error)).toBeDefined();
      expect(isPidAlive(nativePid!)).toBe(true);
      expect(ledger.getActiveProviderTaskCount()).toBe(1);
      expect(states.at(-1)).toBe('unknown');
      expect(resolveClaudeRemoteLaunchErrorDisposition({ error, exitReason: null, runtimeTerminationStarted: false })).toBe('preserve-resume-and-exit');
    } finally {
      abortController.abort();
      await killProcessTree({ pid: nativePid });
      if (launcher) await killProcessTree(launcher);
      await settled;
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('observes fresh tasks after a stopped provider is relaunched inside a borrowed terminal, then retires them on exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-claude-provider-task-exit-'));
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory, env: { PATH: process.env.PATH ?? '' } });
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'claude-resume-id', taskId: 'background-child' });
    const sessionRuntimeActivity = createSessionRuntimeActivity('supported');
    await sessionRuntimeActivity.bindPublisher({ publish: async () => {}, close: async () => {} });
    const contributionHandle = sessionRuntimeActivity.agentRuntimeContributionHandle;
    if (!contributionHandle) throw new Error('Expected supported runtime Activity handle');
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: ledger,
      contributionHandle,
    });
    await runtimeActivityAdapter.activateObservation('test-provider-observer');
    await runtimeActivityAdapter.handleRuntimeLoss('previous-owned-provider-exited', { providerStopped: true });
    const abortController = new AbortController();
    let ownedProcess: Awaited<ReturnType<typeof launchOwnedTerminalProcess>> | undefined;
    let storedAttachment: TerminalAttachmentInfo | null = null;
    let allowExit!: () => void;
    const exitAllowed = new Promise<void>((resolve) => { allowExit = resolve; });
    let terminationRequested!: () => void;
    const requested = new Promise<void>((resolve) => { terminationRequested = resolve; });
    let physicalTermination: ReturnType<typeof killProcessTree> | undefined;
    try {
      await runClaudeUnifiedTerminalSession({
        ...baseOptions(createAdapter(), abortController), path: directory, createController: undefined,
        currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
        runtimeActivityAdapter, providerActivityLedger: ledger,
        launchCurrentTerminalProcess: async () => {
          ownedProcess = await launchOwnedTerminalProcess({ spawn: prepared, cwd: directory,
            // Hold the actual OS termination boundary until the test releases this child.
            terminateProcess: async (child) => {
              physicalTermination = exitAllowed.then(() => killProcessTree(child));
              terminationRequested();
              return await physicalTermination;
            },
          });
          await runtimeActivityAdapter.observeActivity({ activity: {
            type: 'started', sessionId: 'claude-resume-id', taskId: 'fresh-background-child',
          }, evidence: 'live' });
          expect(ledger.getActiveProviderTaskCount()).toBe(1);
          return ownedProcess;
        },
        persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
          storedAttachment = { version: 3, lifecycle: 'borrowed', sessionId, attachmentId,
            handle: { ...handle, attachmentId }, terminal, updatedAt: 1 };
        },
        readTerminalHostAttachmentInfo: async () => storedAttachment,
        removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
        onTerminalHostReady: async ({ stopTerminalHostForExplicitStop }) => {
          let stopSettled = false;
          const stopped = stopTerminalHostForExplicitStop().then(() => { stopSettled = true; });
          try {
            await requested;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(stopSettled).toBe(false);
            expect(ledger.getActiveProviderTaskCount()).toBe(1);
          } finally {
            allowExit();
            await stopped;
          }
          expect(ledger.getActiveProviderTaskCount()).toBe(0);
          abortController.abort();
        },
      });
    } finally {
      abortController.abort();
      allowExit();
      await physicalTermination;
      await ownedProcess?.terminate();
      await ownedProcess?.whenExited;
      await sessionRuntimeActivity.dispose();
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['expected-exit', 'confirmed-death', 'inconclusive'] as const)(
    'retains provider tasks when host exit cannot prove native provider exit (%s)',
    async (outcome) => {
      vi.stubEnv('HAPPIER_CLAUDE_UNIFIED_TERMINAL_HOST_LIVENESS_POLL_MS', '1000');
      reloadConfiguration();
      const abortController = new AbortController();
      const ledger = createClaudeProviderActivityLedger();
      ledger.apply({ type: 'started', sessionId: 'claude-resume-id', taskId: 'background-child' });
      const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
        providerActivityLedger: ledger,
        contributionHandle: { report: async () => {}, markUnknown: async () => {}, dispose: async () => {} },
      });
      let observationStarted = false;
      let deadProbes = 0;
      let hook: ((data: SessionHookData) => void) | undefined;
      const adapter = createAdapter({
        captureInputState: async () => ({ stable: true, currentInput: 'What would you like to work on?\n> ', observedAt: Date.now() }),
        evaluateLiveness: async () => {
          if (!observationStarted) return { paneAlive: true, observedAt: Date.now() };
          deadProbes += 1;
          return { paneAlive: false, probeInconclusive: outcome === 'inconclusive',
            ...(outcome === 'expected-exit' ? { paneExitStatus: 0 } : {}), observedAt: Date.now() };
        },
      });
      const session = runClaudeUnifiedTerminalSession({
        ...baseOptions(adapter, abortController),
        path: tmpdir(), happySessionId: undefined, createController: undefined,
        subscribeClaudeSessionHooks: (callback) => { hook = callback; return () => {}; },
        providerActivityLedger: ledger, runtimeActivityAdapter,
        onWorkflowActivityObserverReady: () => {
          observationStarted = true;
          if (outcome === 'expected-exit') hook?.({ hook_event_name: 'SessionEnd', session_id: 'claude-resume-id', reason: 'prompt_input_exit' });
        },
      });
      const settled = session.then(() => undefined, (error: unknown) => error);
      try {
        if (outcome === 'inconclusive') {
          await vi.waitFor(() => expect(deadProbes).toBeGreaterThanOrEqual(2), { timeout: 5000 });
          expect(ledger.getActiveProviderTaskBlockers().map(task => task.taskId)).toEqual(['background-child']);
          abortController.abort();
        }
        const error = await settled;
        if (outcome === 'confirmed-death') expect(error).toMatchObject({ errors: [
          { code: 'claude_unified_terminal_host_dead' }, { code: 'claude_native_provider_exit_unverified' },
        ] });
        else expect(error).toBeUndefined();
        expect(ledger.getActiveProviderTaskCount()).toBe(1);
      } finally {
        abortController.abort();
        await settled;
        vi.unstubAllEnvs();
        reloadConfiguration();
      }
    },
  );
  it('retries a borrowed Stop after failed physical termination without retiring the pane or attachment early', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-claude-stop-retry-'));
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory, env: { PATH: process.env.PATH ?? '' } });
    const abortController = new AbortController();
    const adapter = createAdapter();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    let launcherPid: number | undefined;
    let attempts = 0;
    const failure = new Error('physical termination temporarily unavailable');
    try {
      await runClaudeUnifiedTerminalSession({
        ...baseOptions(adapter, abortController), path: directory,
        currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
        launchCurrentTerminalProcess: async () => launchOwnedTerminalProcess({ spawn: prepared, cwd: directory,
          terminateProcess: async (child) => {
            launcherPid = child.pid;
            attempts += 1;
            if (attempts === 1) throw failure;
            return await killProcessTree(child);
          } }),
        persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
          storedAttachment = { version: 3, lifecycle: 'borrowed', sessionId, attachmentId,
            handle: { ...handle, attachmentId }, terminal, updatedAt: 1 };
        },
        readTerminalHostAttachmentInfo: async () => storedAttachment,
        removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
        onTerminalHostReady: async ({ stopTerminalHostForExplicitStop }) => {
          await expect(stopTerminalHostForExplicitStop()).rejects.toMatchObject({
            errors: [failure, { code: 'claude_native_provider_exit_unverified' }], cause: failure,
          });
          expect(storedAttachment).toMatchObject({ version: 3, lifecycle: 'borrowed', attachmentId });
          expect(isPidAlive(launcherPid!)).toBe(true);
          await expect(stopTerminalHostForExplicitStop()).resolves.toBeUndefined();
          await expect(waitForProcessExit(launcherPid!, { timeoutMs: 3_000 })).resolves.toBe(true);
          expect(storedAttachment).toBeNull();
          await stopTerminalHostForExplicitStop();
          abortController.abort();
        },
      });
      expect(attempts).toBe(2);
      expect(adapter.dispose).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      if (launcherPid) await killProcessTree({ pid: launcherPid });
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    { failureKind: 'coded', runtimeFails: false }, { failureKind: 'coded', runtimeFails: true },
    { failureKind: 'ordinary', runtimeFails: false }, { failureKind: 'ordinary', runtimeFails: true },
  ])('retains attachment and surfaces incomplete owned cleanup without late ledger mutation ($failureKind / runtime failure: $runtimeFails)', async ({ failureKind, runtimeFails }) => {
    const abortController = new AbortController();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    const removeAttachment = vi.fn(async () => { storedAttachment = null; });
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'claude-resume-id', taskId: 'old-child' });
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async () => {}, markUnknown: async () => {}, dispose: async () => {} } });
    const exited = createDeferred<{ code: 0; signal: null }>();
    const incomplete = new Error('owned-child-cleanup-unverified');
    if (failureKind === 'coded') Object.assign(incomplete, { code: 'process_tree_termination_incomplete' });
    const runtimeError = new Error('initial-runtime-failure');
    const result = runClaudeUnifiedTerminalSession({
      ...baseOptions(createAdapter(), abortController),
      createController: undefined,
      currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
      launchCurrentTerminalProcess: async () => ({
        whenExited: exited.promise,
        terminate: async () => { throw incomplete; },
      }),
      providerActivityLedger: ledger, runtimeActivityAdapter,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = { version: 3, lifecycle: 'borrowed', sessionId, attachmentId, handle: { ...handle, attachmentId }, terminal, updatedAt: 1 };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: removeAttachment,
      onTerminalHostReady: () => { abortController.abort(); if (runtimeFails) throw runtimeError; },
    });
    const failedCleanup = { errors: [incomplete, { code: 'claude_native_provider_exit_unverified' }], cause: incomplete };
    if (runtimeFails) await expect(result).rejects.toMatchObject({ errors: [runtimeError, failedCleanup], cause: runtimeError });
    else await expect(result).rejects.toMatchObject(failedCleanup);
    expect(storedAttachment).toMatchObject({ version: 3, lifecycle: 'borrowed', handle: existingHandle });
    expect(removeAttachment).not.toHaveBeenCalled();
    ledger.apply({ type: 'started', sessionId: 'claude-resume-id', taskId: 'replacement-child' });
    exited.resolve({ code: 0, signal: null });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ledger.getActiveProviderTaskBlockers().map(task => task.taskId)).toEqual(['old-child', 'replacement-child']);
    logger.flushSync();
    expect(await readFile(logger.logFilePath, 'utf8')).toContain('owned-child-cleanup-unverified');
  });
  it('keeps confirmed provider exit idle when borrowed attachment release fails, with default diagnostics', async () => {
    logger.infoFile('Borrowed terminal cleanup regression started');
    const abortController = new AbortController();
    const adapter = createAdapter();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    const exited = createDeferred<{ code: 0; signal: null; nativeExited: true }>();
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', sessionId: 'claude-resume-id', taskId: 'completed-provider-child' });
    const states: string[] = [];
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
      contributionHandle: { report: async snapshot => { states.push(snapshot.state); },
        markUnknown: async () => { states.push('unknown'); }, dispose: async () => {} } });
    await runtimeActivityAdapter.activateObservation('fixture-native-provider');
    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      createController: undefined,
      currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
      providerActivityLedger: ledger, runtimeActivityAdapter,
      // Process termination and attachment-file writes are external boundaries.
      launchCurrentTerminalProcess: async () => ({
        whenExited: exited.promise,
        terminate: async () => { exited.resolve({ code: 0, signal: null, nativeExited: true }); },
      }),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 3, lifecycle: 'borrowed', sessionId, attachmentId,
          handle: { ...handle, attachmentId }, terminal, updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { throw new Error('cleanup-attachment-boundary-failed'); },
      onTerminalHostReady: () => { abortController.abort(); },
    });
    logger.flushSync();
    const log = await readFile(logger.logFilePath, 'utf8');
    expect(log).toContain('descriptor_retirement_failed');
    expect(ledger.getActiveProviderTaskCount()).toBe(0);
    expect(states.at(-1)).toBe('idle');
    expect(storedAttachment).toMatchObject({
      version: 3,
      lifecycle: 'borrowed',
      attachmentId: existingHandle.attachmentId,
      handle: existingHandle,
    });
  });

  it('launches Claude in a borrowed terminal and stops the child without disposing the pane', async () => {
    const abortController = new AbortController();
    const createOrAttachHost = vi.fn(async () => existingHandle);
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ createOrAttachHost, dispose });
    const exited = createDeferred<{ code: 0; signal: null; nativeExited: true }>();
    const terminate = vi.fn(async () => { exited.resolve({ code: 0, signal: null, nativeExited: true }); });
    const launchBorrowedProcess = vi.fn(async () => ({
      whenExited: exited.promise,
      terminate,
    }));
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
      launchCurrentTerminalProcess: launchBorrowedProcess,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, lifecycle, terminal }) => {
        expect(lifecycle).toBe('borrowed');
        storedAttachment = {
          version: 3,
          lifecycle: 'borrowed',
          sessionId,
          attachmentId,
          handle: { ...handle, attachmentId },
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: async ({ lifecycle, stopTerminalHostForExplicitStop }) => {
        expect(lifecycle).toBe('borrowed');
        await stopTerminalHostForExplicitStop();
        abortController.abort();
      },
    });

    expect(launchBorrowedProcess).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace/project',
      spawn: expect.objectContaining({
        spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'],
      }),
    }));
    expect(createOrAttachHost).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
    expect(storedAttachment).toBeNull();
  });

  it('launches Claude in a daemon-owned current terminal and destroys that exact host on explicit stop', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    const exited = createDeferred<{ code: 0; signal: null; nativeExited: true }>();
    const terminate = vi.fn(async () => { exited.resolve({ code: 0, signal: null, nativeExited: true }); });
    const launchCurrentTerminalProcess = vi.fn(async () => ({
      whenExited: exited.promise,
      terminate,
    }));
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: existingHandle, lifecycle: 'owned' },
      launchCurrentTerminalProcess,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, lifecycle, terminal }) => {
        expect(lifecycle).toBe('owned');
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: { ...handle, attachmentId },
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: async ({ lifecycle, stopTerminalHostForExplicitStop }) => {
        expect(lifecycle).toBe('owned');
        await stopTerminalHostForExplicitStop();
        abortController.abort();
      },
    });

    expect(launchCurrentTerminalProcess).toHaveBeenCalledOnce();
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(existingHandle);
    expect(storedAttachment).toBeNull();
  });

  it('launches in the current terminal when its attachment exactly matches the daemon-bound saved host', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    const exited = createDeferred<{ code: 0; signal: null; nativeExited: true }>();
    const terminate = vi.fn(async () => { exited.resolve({ code: 0, signal: null, nativeExited: true }); });
    const launchCurrentTerminalProcess = vi.fn(async () => ({
      whenExited: exited.promise,
      terminate,
    }));
    let storedAttachment: TerminalAttachmentInfo | null = existingAttachment;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: existingHandle, lifecycle: 'owned' },
      launchCurrentTerminalProcess,
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, lifecycle, terminal }) => {
        expect(lifecycle).toBe('owned');
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: { ...handle, attachmentId },
          terminal,
          updatedAt: 2,
        };
      },
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: async ({ stopTerminalHostForExplicitStop }) => {
        await stopTerminalHostForExplicitStop();
        abortController.abort();
      },
    });

    expect(launchCurrentTerminalProcess).toHaveBeenCalledOnce();
    expect(adapter.adoptExistingHost).toBeUndefined();
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(existingHandle);
    expect(storedAttachment).toBeNull();
  });

  it('does not launch in a current terminal whose attachment differs from the saved live host', async () => {
    const abortController = new AbortController();
    const adapter = createAdapter();
    const launchCurrentTerminalProcess = vi.fn();
    const mismatchedHandle: TerminalHostHandle = {
      ...existingHandle,
      attachmentId: 'attachment-different' as TerminalAttachmentId,
    };

    await expect(runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: mismatchedHandle, lifecycle: 'owned' },
      launchCurrentTerminalProcess,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
    })).rejects.toMatchObject({ reason: 'live_attachment_adoption_unavailable' });

    expect(launchCurrentTerminalProcess).not.toHaveBeenCalled();
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
  });

  it('can stop the exact acquired host while startup metadata publication is still in progress', async () => {
    const abortController = new AbortController();
    const adapter = createAdapter();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    let stopOwnedHost: (() => Promise<void>) | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      createController: undefined,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2, sessionId, attachmentId,
          handle: { ...handle, attachmentId }, terminal, updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: ({ stopTerminalHostForExplicitStop }) => {
        stopOwnedHost = stopTerminalHostForExplicitStop;
      },
      // The API publication boundary can remain pending during startup. Stop must already
      // own the persisted attachment without waiting for this or provider initialization.
      publishTerminalHostMetadata: async () => {
        await requestClaudeExplicitRunnerStop({
          unifiedTerminalEnabled: true,
          stopTerminalHostForExplicitStop: stopOwnedHost,
          requestTermination: () => abortController.abort(),
          whenTerminated: Promise.resolve(),
        });
      },
    });

    expect(storedAttachment).toBeNull();
    expect(adapter.dispose).toHaveBeenCalledExactlyOnceWith(existingHandle);
    expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(true);
  });

  it('publishes the host attachment before controller startup completes', async () => {
    const abortController = new AbortController();
    const adapter = createAdapter();
    let controllerRunStarted = false;
    let resolveControllerRun: (() => void) | null = null;
    const controllerRun = new Promise<void>((resolve) => {
      resolveControllerRun = resolve;
    });
    const publishTerminalHostMetadata = vi.fn(async () => {
      expect(controllerRunStarted).toBe(false);
      resolveControllerRun?.();
    });

    const runPromise = runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async () => undefined,
      publishTerminalHostMetadata,
      createController: async () => ({
        run: async () => {
          controllerRunStarted = true;
          await controllerRun;
          abortController.abort();
        },
        dispose: async () => undefined,
      }),
    });
    await runPromise;

    expect(publishTerminalHostMetadata).toHaveBeenCalledTimes(1);
    expect(publishTerminalHostMetadata).toHaveBeenCalledWith({
      mode: 'tmux',
      tmux: { target: 'happier-adopted-resume:%1' },
    });
  });

  it('destroys the exact owned host once when explicit runner stop is requested', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async ({ stopTerminalHostForExplicitStop }) => {
        try {
          expect(stopTerminalHostForExplicitStop).toBeTypeOf('function');
          await stopTerminalHostForExplicitStop();
          await stopTerminalHostForExplicitStop();
        } finally {
          abortController.abort();
        }
      },
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(existingHandle);
    expect(storedAttachment).toBeNull();
  });

  it('preserves the owned host when the runner wrapper exits without explicit stop', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async () => {
        abortController.abort();
      },
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(storedAttachment).not.toBeNull();
  });

  it('preserves the owned host when the runner receives a process signal', async () => {
    const abortController = new AbortController();
    const processSignals = new EventEmitter();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      processSignals,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async () => {
        processSignals.emit('SIGTERM');
      },
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(storedAttachment).not.toBeNull();
  });

  it('does not report a provider launch when it adopts the exact live terminal attachment', async () => {
    const abortController = new AbortController();
    const onProviderLaunchStarting = vi.fn(async () => undefined);
    const adoptExistingHost = vi.fn(async () => {
      abortController.abort();
      return existingHandle;
    });
    const createOrAttachHost = vi.fn(async () => existingHandle);
    const adapter = createAdapter({ adoptExistingHost, createOrAttachHost });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      expectedExistingTerminalHostAttachmentId: attachmentId,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
      onProviderLaunchStarting,
    });

    expect(adoptExistingHost).toHaveBeenCalledWith(existingHandle);
    expect(createOrAttachHost).not.toHaveBeenCalled();
    expect(onProviderLaunchStarting).not.toHaveBeenCalled();
  });

  it('reports one provider launch immediately before a fresh create with spawn argv', async () => {
    const abortController = new AbortController();
    const calls: string[] = [];
    const cleanupUnreadArtifacts = vi.fn(async () => undefined);
    const onProviderLaunchStarting = vi.fn(async () => {
      calls.push('launch_starting');
    });
    const createOrAttachHost = vi.fn(async (options) => {
      calls.push(`create:${options.spawnArgv.join(' ')}`);
      abortController.abort();
      return existingHandle;
    });
    const adapter = createAdapter({ createOrAttachHost });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'],
        spawnEnv: {},
        launchSpecPath: '/synthetic/launch.json',
        cleanupUnreadArtifacts,
      }),
      onProviderLaunchStarting,
    });

    expect(onProviderLaunchStarting).toHaveBeenCalledTimes(1);
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
    expect(cleanupUnreadArtifacts).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'launch_starting',
      'create:/bin/claude --resume claude-resume-id',
    ]);
  });

  it('retires a positively dead legacy attachment before creating a fresh host', async () => {
    const abortController = new AbortController();
    const legacyAttachment: TerminalAttachmentInfo = {
      version: 1,
      sessionId: 'happy-adopted-resume',
      terminal: {
        mode: 'tmux',
        tmux: { target: 'happier-legacy:legacy-window', tmpDir: '/tmp/happier-tmux' },
      },
      updatedAt: 1,
    };
    let storedAttachment: TerminalAttachmentInfo | null = legacyAttachment;
    const createOrAttachHost = vi.fn(async () => {
      abortController.abort();
      return existingHandle;
    });
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({
      createOrAttachHost,
      dispose,
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
    });
    const removeTerminalHostAttachmentInfo = vi.fn(async (input: Readonly<{
      expectedLegacyAttachment?: Extract<TerminalAttachmentInfo, Readonly<{ version: 1 }>>;
    }>) => {
      expect(input.expectedLegacyAttachment).toEqual(legacyAttachment);
      storedAttachment = null;
    });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo,
    });

    expect(removeTerminalHostAttachmentInfo).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
  });

  it('reports one provider launch immediately before confirmed-dead adoption fallback creates', async () => {
    const abortController = new AbortController();
    const calls: string[] = [];
    const onProviderLaunchStarting = vi.fn(async () => {
      calls.push('launch_starting');
    });
    const createOrAttachHost = vi.fn(async (options) => {
      calls.push(`create:${options.spawnArgv.join(' ')}`);
      abortController.abort();
      return existingHandle;
    });
    const adapter = createAdapter({
      adoptExistingHost: vi.fn(async () => {
        throw new Error('adoption failed after the host exited');
      }),
      createOrAttachHost,
      evaluateLiveness: vi.fn()
        .mockResolvedValueOnce({ paneAlive: true, observedAt: 1 })
        .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 2 }),
    });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      expectedExistingTerminalHostAttachmentId: attachmentId,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
      removeTerminalHostAttachmentInfo: vi.fn(async () => undefined),
      onProviderLaunchStarting,
    });

    expect(onProviderLaunchStarting).toHaveBeenCalledTimes(1);
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'launch_starting',
      'create:/bin/claude --resume claude-resume-id',
    ]);
  });

  it.each(['not_started', 'unconfirmed'] as const)('preserves private launch inputs according to real tmux creation disposition (%s)', async (disposition) => {
    const abortController = new AbortController();
    // Replace only the OS tmux client. Host creation, immutable-identity parsing,
    // private launch materialization and the outer startup catch remain real.
    const spawnBoundary = vi.spyOn(childProcess, 'spawn');
    spawnBoundary.mockImplementation(((command: string, args: readonly string[]) => {
      if (command !== 'tmux') throw new Error('Unexpected fixture process');
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(child, { stdout, stderr });
      queueMicrotask(() => {
        if (args.includes('new-session')) {
          if (disposition === 'not_started') {
            stderr.emit('data', 'duplicate session: happier-fresh-resume');
            child.emit('close', 1);
          } else {
            stdout.emit('data', '12345\tmalformed-window-id\n');
            child.emit('close', 0);
          }
        } else {
          stdout.emit('data', 'happier-fixture\n');
          child.emit('close', 0);
        }
      });
      return child;
    }) as unknown as typeof childProcess.spawn);
    const adapter = createTmuxTerminalHostAdapter({ tmux: new TmuxUtilities() });
    let launchSpecPath: string | undefined;
    let mcpConfigPath: string | undefined;

    try {
      await expect(runClaudeUnifiedTerminalSession({
        ...baseOptions(adapter, abortController),
        happierMcpConfigJson: JSON.stringify({
          mcpServers: {
            fixture: {
              command: 'synthetic-mcp-server',
              env: { TOKEN: 'synthetic-pre-handoff-marker' },
            },
          },
        }),
        buildSpawn: async (params) => {
          const spawn = await buildClaudeUnifiedTerminalSpawn({
            ...params,
            deps: {
              resolveClaudeCliPath: () => '/synthetic/claude',
              isClaudeCliJavaScriptFile: () => false,
              ensureClaudeJsRuntimeExecutable: async () => '/synthetic/runtime',
              terminalLaunchSpecRunnerPath: '/synthetic/terminal-launch-spec-runner.cjs',
              resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
            },
          });
          launchSpecPath = spawn.launchSpecPath;
          const launchSpec = JSON.parse(await readFile(launchSpecPath!, 'utf8')) as { args?: string[] };
          const mcpConfigIndex = launchSpec.args?.indexOf('--mcp-config') ?? -1;
          mcpConfigPath = launchSpec.args?.[mcpConfigIndex + 1];
          expect(JSON.stringify(launchSpec.args)).not.toContain('synthetic-pre-handoff-marker');
          await expect(readFile(mcpConfigPath!, 'utf8')).resolves.toContain('synthetic-pre-handoff-marker');
          return spawn;
        },
      })).rejects.toThrow();

      expect(launchSpecPath).toBeTruthy();
      expect(mcpConfigPath).toBeTruthy();
      if (disposition === 'unconfirmed') {
        await expect(stat(launchSpecPath!)).resolves.toBeDefined();
        await expect(stat(mcpConfigPath!)).resolves.toBeDefined();
      } else {
        await expect(stat(launchSpecPath!)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(mcpConfigPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      spawnBoundary.mockRestore();
      if (mcpConfigPath) await unlink(mcpConfigPath).catch(() => undefined);
      if (launchSpecPath) await unlink(launchSpecPath).catch(() => undefined);
    }
  });
});
