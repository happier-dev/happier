import { describe, expect, it, vi } from 'vitest';

import { encodeTerminalPasteInput } from '@happier-dev/protocol';

import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from './provider';
import { TERMINAL_SHIFT_TAB_SEQUENCE } from '@/integrations/terminalHost/controlTypes';
import { createPtyTerminalHostAdapter } from './hostAdapter';
import { createVirtualTerminalScreen } from './virtualTerminalScreen';

class FakePtyProcess implements PtyProcess {
  readonly pid = 4321;
  readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(private readonly onWrite?: ((process: FakePtyProcess, data: string) => void) | undefined) {}

  write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(this, data);
  }

  resize(): void {}

  kill(): void {
    this.emitExit({ exitCode: 0 });
  }

  onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: PtyExitEvent) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }

  get dataListenerCount(): number {
    return this.dataListeners.size;
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

function createFakeProvider() {
  const processes: FakePtyProcess[] = [];
  const spawnCalls: PtySpawnParams[] = [];
  const provider: PtyProvider = {
    spawn: (params) => {
      spawnCalls.push(params);
      const process = new FakePtyProcess();
      processes.push(process);
      return process;
    },
  };
  return { provider, processes, spawnCalls };
}

function createFakeProviderWithProcess(factory: () => FakePtyProcess) {
  const processes: FakePtyProcess[] = [];
  const spawnCalls: PtySpawnParams[] = [];
  const provider: PtyProvider = {
    spawn: (params) => {
      spawnCalls.push(params);
      const process = factory();
      processes.push(process);
      return process;
    },
  };
  return { provider, processes, spawnCalls };
}

describe('createVirtualTerminalScreen', () => {
  it('tracks clear-screen and cursor-position terminal writes', () => {
    const screen = createVirtualTerminalScreen({ cols: 20, rows: 4 });

    screen.write('old line');
    screen.write('\u001b[2J\u001b[H> ready');
    screen.write('\u001b[2;3Hbox');

    expect(screen.capture()).toEqual({
      text: '> ready\n  box',
      cursor: { x: 5, y: 1 },
    });
  });
});

describe('createPtyTerminalHostAdapter', () => {
  it('spawns a PTY process and captures the virtual terminal screen', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      cols: 80,
      rows: 4,
      inputStabilityDelayMs: 0,
      now: () => 123,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe', 'runner.cjs', 'launch.json'],
      spawnEnv: { HAPPIER_SECRET: 'secret', TERM: 'xterm-256color' },
      isolatedEnv: true,
    });
    fake.processes[0]?.emitData('\u001b[2J\u001b[HWhat would you like to work on?\r\n> ');

    expect(handle).toMatchObject({
      kind: 'windows_console',
      sessionName: 'happier-claude-windows',
      paneId: 'happier-claude-windows',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        requiresLocalAttachmentInfo: false,
      },
    });
    expect(fake.spawnCalls[0]).toMatchObject({
      file: 'node.exe',
      args: ['runner.cjs', 'launch.json'],
      options: {
        cwd: 'C:\\repo',
        cols: 80,
        rows: 4,
      },
    });
    expect(fake.spawnCalls[0]?.options.env?.HAPPIER_SECRET).toBe('secret');
    await expect(adapter.captureInputState?.(handle)).resolves.toMatchObject({
      stable: true,
      currentInput: 'What would you like to work on?\n>',
      cursor: { x: 2, y: 1 },
      observedAt: 123,
    });
    await expect(adapter.createControlPort?.(handle)?.captureScreen()).resolves.toMatchObject({
      status: 'captured',
      capture: {
        text: 'What would you like to work on?\n>',
        cursor: { x: 2, y: 1 },
        hostKind: 'windows_console',
      },
    });
  });

  it('does not inherit process environment for isolated PTY launches', async () => {
    const previousSecret = process.env.HAPPIER_DAEMON_ONLY_SECRET;
    const previousTerm = process.env.TERM;
    process.env.HAPPIER_DAEMON_ONLY_SECRET = 'daemon-secret';
    process.env.TERM = 'daemon-term';
    try {
      const fake = createFakeProvider();
      const adapter = createPtyTerminalHostAdapter({
        ptyProvider: fake.provider,
      });

      await adapter.createOrAttachHost({
        sessionName: 'isolated-session',
        workingDirectory: 'C:\\repo',
        spawnArgv: ['node.exe'],
        spawnEnv: { HAPPIER_ALLOWED: 'allowed' },
        isolatedEnv: true,
      });

      expect(fake.spawnCalls[0]?.options.env).toMatchObject({
        HAPPIER_ALLOWED: 'allowed',
        TERM: 'xterm-256color',
      });
      expect(fake.spawnCalls[0]?.options.env?.HAPPIER_DAEMON_ONLY_SECRET).toBeUndefined();
      expect(fake.spawnCalls[0]?.options.env?.TERM).not.toBe('daemon-term');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.HAPPIER_DAEMON_ONLY_SECRET;
      } else {
        process.env.HAPPIER_DAEMON_ONLY_SECRET = previousSecret;
      }
      if (previousTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previousTerm;
      }
    }
  });

  it('removes inherited environment keys case-insensitively for non-isolated PTY launches', async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-key';
    try {
      const fake = createFakeProvider();
      const adapter = createPtyTerminalHostAdapter({ ptyProvider: fake.provider });

      await adapter.createOrAttachHost({
        sessionName: 'scoped-session',
        workingDirectory: 'C:\\repo',
        spawnArgv: ['node.exe'],
        spawnEnv: { HAPPIER_ALLOWED: 'allowed' },
        unsetEnvKeys: ['openai_api_key'],
        isolatedEnv: false,
      });

      expect(fake.spawnCalls[0]?.options.env?.OPENAI_API_KEY).toBeUndefined();
      expect(fake.spawnCalls[0]?.options.env?.HAPPIER_ALLOWED).toBe('allowed');
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it('injects prompts and terminal control keys through the PTY', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      now: () => 456,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });
    const result = await adapter.injectUserPrompt(handle, {
      text: 'line one\nline two',
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'n1' },
      scheduling: {},
    });
    const port = adapter.createControlPort?.(handle);
    await port?.sendSpecialKey('ShiftTab');
    await port?.sendSpecialKey('CtrlC');

    expect(result).toEqual({
      status: 'injected',
      injectedAt: 456,
      bytesWritten: 17,
      hostKind: 'windows_console',
      hostSessionName: 'happier-claude-windows',
      paneId: 'happier-claude-windows',
    });
    expect(fake.processes[0]?.writes).toEqual([
      'line one\nline two\r',
      TERMINAL_SHIFT_TAB_SEQUENCE,
      '\u0003',
    ]);
  });

  it('waits for a multiline prompt to reach the PTY composer before submitting it', async () => {
    const prompt = 'first line\nsecond line';
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process, data) => {
      if (data === '\r') {
        process.emitData('\u001b[2J\u001b[HClaude Code\r\n> ');
      }
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      promptSubmitVerification: {
        shouldVerifyAfterSubmit: () => true,
        verifyAfterSubmit: ({ screenText }) => screenText.includes('[Pasted text'),
      },
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    const injection = adapter.injectUserPrompt(handle, {
      text: prompt,
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'n-delayed-paste' },
      scheduling: { timeoutMs: 500 },
    });

    await vi.waitFor(() => {
      expect(fake.processes[0]?.writes).toEqual([encodeTerminalPasteInput(prompt, true)]);
    });
    fake.processes[0]?.emitData('\u001b[2J\u001b[H> [Pasted text #1 +1 lines]');

    await expect(injection).resolves.toMatchObject({ status: 'injected' });
    expect(fake.processes[0]?.writes).toEqual([encodeTerminalPasteInput(prompt, true), '\r']);
  });

  it('waits for a single-line prompt to reach the PTY composer before submitting it', async () => {
    const prompt = 'Reply exactly WINDOWS_QA_READY and then wait for my next message.';
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process, data) => {
      if (data === '\r') {
        process.emitData('\u001b[2J\u001b[HClaude Code\r\n> ');
      }
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      promptSubmitVerification: {
        shouldVerifyAfterSubmit: () => true,
        verifyAfterSubmit: ({ screenText }) => screenText.includes(prompt),
      },
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    const injection = adapter.injectUserPrompt(handle, {
      text: prompt,
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'n-delayed-single-line' },
      scheduling: { timeoutMs: 500 },
    });

    await vi.waitFor(() => {
      expect(fake.processes[0]?.writes).toEqual([prompt]);
    });
    fake.processes[0]?.emitData(`\u001b[2J\u001b[H> ${prompt}`);

    await expect(injection).resolves.toMatchObject({ status: 'injected' });
    expect(fake.processes[0]?.writes).toEqual([prompt, '\r']);
  });

  it('gives staging and Enter their own bounded phase after a slow successful PTY write', async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const prompt = 'continue';
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process, data) => {
      if (data === prompt) {
        nowMs += 100;
        process.emitData(`\u001b[2J\u001b[H> ${prompt}`);
      } else if (data === '\r') {
        process.emitData('\u001b[2J\u001b[HClaude Code\r\n> ');
      }
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      promptSubmitVerification: {
        shouldVerifyAfterSubmit: () => true,
        verifyAfterSubmit: ({ promptText, screenText }) => screenText.includes(promptText),
      },
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    try {
      await expect(adapter.injectUserPrompt(handle, {
        text: prompt,
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'n-slow-write' },
        scheduling: { timeoutMs: 100 },
      })).resolves.toMatchObject({ status: 'injected' });
    } finally {
      nowSpy.mockRestore();
    }

    expect(fake.processes[0]?.writes).toEqual([prompt, '\r']);
  });

  it('does not submit or report injection when multiline prompt staging times out', async () => {
    const prompt = 'first line\nsecond line';
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      promptSubmitVerification: {
        shouldVerifyAfterSubmit: () => true,
        verifyAfterSubmit: () => false,
      },
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    await expect(adapter.injectUserPrompt(handle, {
      text: prompt,
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'n-paste-timeout' },
      scheduling: { timeoutMs: 10 },
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'timeout',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      recoverable: true,
    });
    expect(fake.processes[0]?.writes).toEqual([encodeTerminalPasteInput(prompt, true)]);
  });

  it('does not mistake Claude\'s submitted prompt row for an unsent Windows composer draft', async () => {
    const prompt = 'Reply exactly WINDOWS_CURRENT_BUILD_DIALOG_OK and then wait.';
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process, data) => {
      if (data === prompt) {
        process.emitData(`\u001b[2J\u001b[H> ${prompt}`);
      } else if (data === '\r') {
        process.emitData(`\u001b[2J\u001b[H> ${prompt}\r\nClaude Code is thinking\r\n> `);
      }
    }));
    let sawSubmittedPromptRow = false;
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      promptSubmitVerification: {
        shouldVerifyAfterSubmit: () => true,
        verifyBeforeSubmitStaging: ({ screenText }) => screenText.includes(`> ${prompt}`),
        verifyAfterSubmit: ({ screenText }) => {
          sawSubmittedPromptRow = screenText.includes(prompt);
          return false;
        },
      },
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    await expect(adapter.injectUserPrompt(handle, {
      text: prompt,
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'n-submitted-row' },
      scheduling: {},
    })).resolves.toMatchObject({ status: 'injected' });

    expect(fake.processes[0]?.writes).toEqual([prompt, '\r']);
    expect(sawSubmittedPromptRow).toBe(true);
  });

  it('reports pane death after the PTY exits', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({ ptyProvider: fake.provider });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    fake.processes[0]?.emitExit({ exitCode: 9 });

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneExitStatus: 9,
    });
    await expect(adapter.injectUserPrompt(handle, {
      text: 'hello',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'n2' },
      scheduling: {},
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'pane_dead',
      recoverable: false,
      hostKind: 'windows_console',
      hostSessionName: 'happier-claude-windows',
    });
  });

  it('disposes an exited PTY session automatically before respawning the same session name', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      now: () => 789,
    });
    const initialHandle = await adapter.createOrAttachHost({
      sessionName: 'shared-session',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });
    fake.processes[0]?.emitData('\u001b[2J\u001b[Hold session');

    await expect(adapter.captureInputState?.(initialHandle)).resolves.toMatchObject({
      currentInput: 'old session',
    });

    fake.processes[0]?.emitExit({ exitCode: 0 });

    expect(fake.processes[0]?.dataListenerCount).toBe(0);
    expect(fake.processes[0]?.exitListenerCount).toBe(0);

    const respawnedHandle = await adapter.createOrAttachHost({
      sessionName: 'shared-session',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });
    fake.processes[0]?.emitData('\u001b[2J\u001b[Hstale session leak');
    fake.processes[1]?.emitData('\u001b[2J\u001b[Hnew session');

    expect(fake.spawnCalls).toHaveLength(2);
    await expect(adapter.captureInputState?.(respawnedHandle)).resolves.toMatchObject({
      currentInput: 'new session',
    });
  });

  it('reports post-submit verification failure without claiming the live PTY host is unreachable', async () => {
    const prompt = 'Prompt remains visible while Claude accepts it asynchronously.';
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process, data) => {
      if (data === prompt) {
        process.emitData(`\u001b[2J\u001b[H> ${prompt}`);
      }
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      promptSubmitVerification: {
        shouldVerifyAfterSubmit: () => true,
        verifyAfterSubmit: ({ screenText }) => screenText.includes(prompt),
      },
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    await expect(adapter.injectUserPrompt(handle, {
      text: prompt,
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'n-verification-failed' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
      hostKind: 'windows_console',
      hostSessionName: 'happier-claude-windows',
    });
    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: true,
      paneDead: false,
    });
    expect(fake.processes[0]?.writes).toEqual([prompt, '\r', '\r']);
  });

  it('does not report a prompt as injected when the PTY closes immediately after the write', async () => {
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process) => {
      queueMicrotask(() => process.emitExit({ exitCode: 1 }));
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    await expect(adapter.injectUserPrompt(handle, {
      text: 'hello',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'n3' },
      scheduling: {},
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'host_unreachable',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
      hostKind: 'windows_console',
      hostSessionName: 'happier-claude-windows',
    });
  });
});
