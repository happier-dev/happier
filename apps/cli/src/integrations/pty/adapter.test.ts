import { describe, expect, it, vi } from 'vitest';

import type { Disposable, PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from '@/integrations/pty/ptyProvider';
import { wrapBracketedPaste } from '@/agent/runtime/terminal/injection/bracketedPaste';
import { createClaudePromptSubmitVerificationPolicy } from '@/backends/claude/unifiedTerminal/claudePromptSubmitVerification';
import { TERMINAL_SHIFT_TAB_SEQUENCE } from '../terminalHost/controlTypes';
import { createPtyTerminalHostAdapter } from './adapter';
import { createVirtualTerminalScreen } from './virtualTerminalScreen';

class FakePtyProcess implements PtyProcess {
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
    await port?.sendSpecialKey('ArrowUp');
    await port?.sendSpecialKey('ArrowDown');

    expect(result).toEqual({ status: 'injected', at: 456, bytesWritten: 17 });
    expect(fake.processes[0]?.writes).toEqual([
      'line one\nline two',
      '\r',
      TERMINAL_SHIFT_TAB_SEQUENCE,
      '\u0003',
      '\u001b[A',
      '\u001b[B',
    ]);
  });

  it('authorizes at the final PTY write boundary and leaves the terminal untouched when denied', async () => {
    const order: string[] = [];
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((_process, data) => {
      order.push(`write:${data}`);
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });
    const input = {
      text: 'attempt prompt',
      multiline: false,
      origin: { kind: 'ui_pending' as const, nonce: 'n-authorize' },
      scheduling: {},
    };

    await expect(adapter.injectUserPrompt(handle, input, {
      authorizeBeforeWrite: async () => {
        order.push('authorize:denied');
        return false;
      },
    })).resolves.toEqual({
      status: 'failed',
      reason: 'no_target',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: false,
    });
    expect(order).toEqual(['authorize:denied']);

    await expect(adapter.injectUserPrompt(handle, input, {
      authorizeBeforeWrite: async () => {
        order.push('authorize:accepted');
        return true;
      },
    })).resolves.toMatchObject({ status: 'injected' });
    expect(order).toEqual([
      'authorize:denied',
      'authorize:accepted',
      'write:attempt prompt',
      'write:\r',
    ]);
  });

  it('writes large prompts to the PTY as one text operation plus a submit carriage return', async () => {
    const fake = createFakeProvider();
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      now: () => 789,
    });
    const handle = await adapter.createOrAttachHost({
      sessionName: 'happier-claude-windows',
      workingDirectory: 'C:\\repo',
      spawnArgv: ['node.exe'],
      spawnEnv: {},
      isolatedEnv: true,
    });
    const prompt = `${'line\n'.repeat(60_000)}tail`;

    await expect(adapter.injectUserPrompt(handle, {
      text: prompt,
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'n-large' },
      scheduling: {},
    })).resolves.toEqual({ status: 'injected', at: 789, bytesWritten: Buffer.byteLength(prompt) });

    expect(fake.processes[0]?.writes).toEqual([prompt, '\r']);
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
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
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
      expect(fake.processes[0]?.writes).toEqual([wrapBracketedPaste(prompt)]);
    });
    fake.processes[0]?.emitData('\u001b[2J\u001b[H> [Pasted text #1 +1 lines]');

    await expect(injection).resolves.toMatchObject({ status: 'injected' });
    expect(fake.processes[0]?.writes).toEqual([wrapBracketedPaste(prompt), '\r']);
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
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
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
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
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
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
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
    })).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      recoverable: true,
    });
    expect(fake.processes[0]?.writes).toEqual([wrapBracketedPaste(prompt)]);
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
    });
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
    })).resolves.toEqual({
      status: 'failed',
      reason: 'host_unreachable',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
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
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
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
    })).resolves.toEqual({
      status: 'failed',
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
    });
    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: true,
      paneDead: false,
    });
    expect(fake.processes[0]?.writes).toEqual([prompt, '\r', '\r']);
  });

  it('does not mistake Claude\'s submitted prompt row for an unsent Windows composer draft', async () => {
    const prompt = 'Reply exactly with WIN-CLAUDE-UNIFIED-CS-AFTERFIX2-FIRST-20260629T1535Z and nothing else.';
    const fake = createFakeProviderWithProcess(() => new FakePtyProcess((process, data) => {
      process.emitData(data === '\r'
        ? `\u001b[2J\u001b[H> ${prompt}\r\nClaude Code\r\n> `
        : `\u001b[2J\u001b[H> ${prompt}`);
    }));
    const adapter = createPtyTerminalHostAdapter({
      ptyProvider: fake.provider,
      inputStabilityDelayMs: 0,
      postWriteLivenessDelayMs: 0,
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
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
      origin: { kind: 'ui_pending', nonce: 'n-stuck-single-line' },
      scheduling: {},
    })).resolves.toMatchObject({ status: 'injected' });

    expect(fake.processes[0]?.writes).toEqual([prompt, '\r']);
  });
});
