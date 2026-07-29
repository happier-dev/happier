import { describe, expect, it, vi } from 'vitest';

import { createZellijTerminalHostAdapter } from './adapter';
import { ZellijActionTimeoutError, type ZellijActions } from './actions';
import { isTerminalHostStartupError } from '../terminal/host/errors';

function createActions(overrides?: Partial<ZellijActions>): ZellijActions {
  return {
    attachCreateBackground: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
    pasteText: vi.fn(async () => undefined),
    writeBytesChunked: vi.fn(async () => undefined),
    sendEnter: vi.fn(async () => undefined),
    sendEscape: vi.fn(async () => undefined),
    closePane: vi.fn(async () => undefined),
    listPanes: vi.fn(async () => [{ id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' }]),
    dumpScreen: vi.fn(async () => ''),
    killSession: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    ...overrides,
  };
}

// Construction helper: default the socket-presence probe to `unknown` (undeterminable) so existing
// tests exercise the client `list-panes` liveness path with a reachable server. Tests that assert
// the socket-first short-circuit override `inspectSocketPresence` explicitly.
function createTestZellijAdapter(
  opts: Parameters<typeof createZellijTerminalHostAdapter>[0],
): ReturnType<typeof createZellijTerminalHostAdapter> {
  return createZellijTerminalHostAdapter({
    inspectSocketPresence: async () => 'unknown' as const,
    ...opts,
  });
}

async function expectZellijStartupTimeoutFailure(action: () => Promise<unknown>, expectedAction: string): Promise<void> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(isTerminalHostStartupError(thrown)).toBe(true);
  expect(thrown).toMatchObject({
    code: 'terminal_host_startup_failed',
    hostKind: 'zellij',
    reason: 'startup_action_timeout',
    diagnostics: {
      action: expectedAction,
      sessionName: 'session-a',
    },
  });
}

describe('createZellijTerminalHostAdapter', () => {
  it('leaves a foreign live pane untouched when attaching a colliding named session', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [
        { id: 7, is_plugin: false, terminal_command: 'foreign-shell' },
        { id: 42, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
      ]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });

    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it('creates a background session and returns the launched terminal pane handle', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 100,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: { HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js' },
      unsetEnvKeys: ['openai_api_key'],
      isolatedEnv: true,
    })).resolves.toMatchObject({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
      },
    });
    expect(actions.attachCreateBackground).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
      unsetEnvKeys: ['openai_api_key'],
    }));
    expect(actions.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      command: ['/managed/node', 'claude_local_launcher.cjs'],
      env: {
        HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js',
        ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock',
      },
      unsetEnvKeys: ['openai_api_key'],
    }));
  });

  it('uses zellij action paste plus a separate Enter for prompt delivery', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 200,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toEqual({
      status: 'injected',
      injectedAt: 200,
      bytesWritten: Buffer.byteLength('queued prompt'),
      hostKind: 'zellij',
      hostSessionName: 'session-a',
      paneId: 'terminal_42',
    });

    expect(actions.pasteText).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_42',
      text: 'queued prompt',
      timeoutMs: expect.any(Number),
    }));
    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_42',
      timeoutMs: expect.any(Number),
    }));
  });

  it('does not wait for a delayed pre-submit collapsed marker and settles once after Enter', async () => {
    const prompt = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(36)}`).join('\n');
    const waits: number[] = [];
    let dumpCount = 0;
    let enterCount = 0;
    const actions = createActions({
      sendEnter: vi.fn(async () => {
        enterCount += 1;
      }),
      dumpScreen: vi.fn(async () => {
        dumpCount += 1;
        if (enterCount > 0) return '';
        return dumpCount < 3 ? 'old composer contents' : '❯ [Pasted text #1 +5999 lines]';
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 205,
      actionTimeoutMs: 1_000,
      pasteMaxBytes: 1024 * 1024,
      promptSubmitVerification: {
        shouldVerifyBeforeSubmit: () => false,
        verifyBeforeSubmit: () => true,
        shouldVerifyAfterSubmit: () => true,
        verifyAfterSubmit: ({ screenText }) => screenText.includes('[Pasted text #1 +5999 lines]'),
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: prompt,
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'nonce-large-zellij-delayed-marker' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({
      status: 'injected',
      bytesWritten: Buffer.byteLength(prompt),
      hostKind: 'zellij',
      hostSessionName: 'session-a',
      paneId: 'terminal_42',
    });

    expect(waits).toEqual([50]);
    expect(actions.dumpScreen).toHaveBeenCalledTimes(1);
    expect(actions.sendEnter).toHaveBeenCalledTimes(1);
  });

  it('does not run provider-specific submit verification without an explicit policy', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 207,
      pasteMaxBytes: 1024 * 1024,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'first line\nsecond line',
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'nonce-zellij-multiline-no-policy' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({
      status: 'injected',
      bytesWritten: Buffer.byteLength('first line\nsecond line'),
      hostKind: 'zellij',
      hostSessionName: 'session-a',
      paneId: 'terminal_42',
    });

    expect(actions.dumpScreen).not.toHaveBeenCalled();
    expect(actions.sendEnter).toHaveBeenCalledTimes(1);
  });

  it('blocks over-cap zellij prompts before any write or Enter', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 210,
      pasteMaxBytes: 4,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'too large',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toEqual({
      status: 'failed',
      reason: 'payload_too_large',
      phase: 'before_write',
      recoverable: true,
      duplicateRisk: 'none',
      observedAt: 210,
      hostKind: 'zellij',
      hostSessionName: 'session-a',
      paneId: 'terminal_42',
    });

    expect(actions.pasteText).not.toHaveBeenCalled();
    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('submits Enter with a dedicated budget after a completed paste exhausts the injection deadline', async () => {
    let finishPaste: (() => void) | undefined;
    const actions = createActions({
      pasteText: vi.fn(async () => new Promise<void>((resolve) => {
        finishPaste = resolve;
      })),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 200,
    });

    const injection = adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 5 },
    });

    await vi.waitFor(() => {
      expect(finishPaste).toBeTypeOf('function');
    });
    finishPaste?.();

    await expect(injection).resolves.toMatchObject({ status: 'injected' });
    expect(actions.sendEnter).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_42',
      timeoutMs: expect.any(Number),
    }));
  });

  it('defers queued prompts when the zellij pane is not quiet yet', async () => {
    let dumps = 0;
    const actions = createActions({
      dumpScreen: vi.fn(async () => {
        dumps += 1;
        return dumps === 1 ? 'screen before' : 'screen after';
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 300,
      wait: async () => undefined,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000, deferredUntilQuietMs: 800 },
    })).resolves.toMatchObject({
      status: 'deferred',
      reason: 'user_typing',
      retryAfterMs: 800,
      observedAt: 300,
    });

    expect(actions.dumpScreen).toHaveBeenCalledTimes(2);
    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('injects multiline prompt text through action paste before submitting Enter', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 250,
    });

    const rawText = 'line one\nline two';
    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'line one\nline two',
      multiline: true,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({
      status: 'injected',
      bytesWritten: Buffer.byteLength(rawText),
    });

    expect(actions.pasteText).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_42',
      text: rawText,
    }));
    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
  });

  it('injects into a created handle when zellij reports only executable command metadata', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 255,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'injected' });

    expect(actions.pasteText).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_42' }));
    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_42' }));
  });

  it('interrupts the exact live pane through the terminal-host contract', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.interruptTurn?.({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    })).resolves.toBeUndefined();

    expect(actions.sendEscape).toHaveBeenCalledWith(expect.objectContaining({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_42',
      env: expect.objectContaining({
        ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock',
      }),
    }));
  });

  it('uses the only matching live command pane when zellij rekeys the tracked pane after launch', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [
        { id: 0, is_plugin: true, terminal_command: null },
        { id: 0, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
        { id: 2, is_plugin: false, terminal_command: null },
      ]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 260,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'exclusive' as const,
        locality: 'same_machine' as const,
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required' as const,
      },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: true,
      paneDead: false,
      paneCurrentCommand: '/managed/node claude_local_launcher.cjs',
    });
    await expect(adapter.injectUserPrompt(handle, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'injected' });

    expect(actions.pasteText).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_0' }));
    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_0' }));
  });

  it('short-circuits liveness to conclusive dead when the session socket is gone, without a client probe', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 500,
      inspectSocketPresence: vi.fn(async () => 'absent' as const),
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-gone',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'exclusive' as const,
        locality: 'same_machine' as const,
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required' as const,
      },
    };

    // Gone host: conclusive dead reached via the socket, never hanging on a client probe.
    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
    });
    expect(actions.listPanes).not.toHaveBeenCalled();

    // A gone host is not recoverable, so injection fails closed (pane_dead) instead of deferring in
    // an unbounded livelock.
    await expect(adapter.injectUserPrompt(handle, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-gone' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });
    expect(actions.listPanes).not.toHaveBeenCalled();
  });

  it('falls through to the client liveness probe when the session socket is present', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 1, is_plugin: false, terminal_command: '/managed/node' }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 501,
      inspectSocketPresence: vi.fn(async () => 'present' as const),
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-live',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'exclusive' as const,
        locality: 'same_machine' as const,
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required' as const,
      },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: true,
      paneDead: false,
    });
    expect(actions.listPanes).toHaveBeenCalled();
  });

  it('does not retarget a missing zellij pane to an unrelated sole command pane', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 0, is_plugin: false, terminal_command: '/bin/zsh' }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 261,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('does not retarget a missing zellij pane to a launch-spec runner with a different spec path', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{
        id: 0,
        is_plugin: false,
        terminal_command: '/managed/node terminal_launch_spec_runner.cjs /tmp/spec-b/launch.json',
      }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 262,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['/managed/node', 'terminal_launch_spec_runner.cjs', '/tmp/spec-a/launch.json'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('does not retarget a missing zellij pane to a sole pane that only shares the executable', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 0, is_plugin: false, terminal_command: '/managed/node' }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 262,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('does not trust an exact zellij pane id when expected command metadata is absent', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 1, is_plugin: false }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 262,
    });

    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'exclusive' as const,
        locality: 'same_machine' as const,
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required' as const,
      },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: true,
      paneDead: false,
    });
    await expect(adapter.injectUserPrompt(handle, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'deferred', reason: 'liveness_uncertain', recoverable: true });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('does not trust an exact zellij pane id when command metadata only shares the executable with another script', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 1, is_plugin: false, terminal_command: '/managed/node unrelated_launcher.cjs' }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 262,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('does not trust an exact zellij pane id when command metadata proves unrelated reuse', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 1, is_plugin: false, terminal_command: '/bin/zsh' }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 262,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('defers a transient missing zellij pane before writing', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => []),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 263,
    });

    await expect(adapter.injectUserPrompt({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      socketDir: '/tmp/zellij-sock',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    }, {
      text: 'queued prompt',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'nonce-1' },
      scheduling: { timeoutMs: 1_000, retryAfterMs: 250 },
    })).resolves.toMatchObject({ status: 'deferred', reason: 'liveness_uncertain', retryAfterMs: 250 });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('kills the managed session when command launch fails after background attach', async () => {
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'bad command' })),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/missing/claude'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/zellij run failed/);

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('classifies and cleans up a background attach startup timeout', async () => {
    const actions = createActions({
      attachCreateBackground: vi.fn(async () => {
        throw new ZellijActionTimeoutError('attach');
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      actionTimeoutMs: 123,
    });

    await expectZellijStartupTimeoutFailure(() => adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    }), 'attach');

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
      timeoutMs: 123,
    }));
    expect(actions.runCommand).not.toHaveBeenCalled();
  });

  it('classifies and cleans up a zellij run startup timeout', async () => {
    const actions = createActions({
      runCommand: vi.fn(async () => {
        throw new ZellijActionTimeoutError('run');
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      actionTimeoutMs: 123,
    });

    await expectZellijStartupTimeoutFailure(() => adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    }), 'run');

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
      timeoutMs: 123,
    }));
  });

  it('classifies and cleans up pane discovery failure after launch starts', async () => {
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      listPanes: vi.fn(async () => [{ id: 0, is_plugin: true, is_suppressed: true }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      actionTimeoutMs: 123,
    });

    await expectZellijStartupTimeoutFailure(() => adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    }), 'pane_discovery');

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
      timeoutMs: 123,
    }));
  });

  it('kills the managed session when pane targeting is ambiguous', async () => {
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      listPanes: vi.fn(async () => [
        { id: 41, is_plugin: false, terminal_command: 'shell' },
        { id: 42, is_plugin: false, terminal_command: 'claude' },
      ]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/no terminal target pane/);

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('keeps the run-proven pane instead of retargeting an unproven command pane', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false, terminal_command: 'claude' },
          ];
        }
        return [{ id: 0, is_plugin: false, terminal_command: 'claude' }];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });
    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it('does not infer ownership from unrelated command metadata', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
          ];
        }
        return [{ id: 7, is_plugin: false, terminal_command: '/bin/zsh' }];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });
    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it('does not infer ownership from another launch spec path', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false, terminal_command: '/managed/node terminal_launch_spec_runner.cjs /tmp/spec-a/launch.json' },
          ];
        }
        return [{ id: 7, is_plugin: false, terminal_command: '/managed/node terminal_launch_spec_runner.cjs /tmp/spec-b/launch.json' }];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'terminal_launch_spec_runner.cjs', '/tmp/spec-a/launch.json'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });
    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it('does not infer ownership from executable-only metadata', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
          ];
        }
        return [{ id: 7, is_plugin: false, terminal_command: '/managed/node' }];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });
    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it('keeps the run-proven pane when a colliding pane has a matching command', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
          ];
        }
        return [{ id: 7, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' }];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });

    expect(actions.closePane).not.toHaveBeenCalled();
    expect(actions.killSession).not.toHaveBeenCalled();
  });

  it('keeps the run-proven pane when a foreign pane omits ownership metadata', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false },
          ];
        }
        return [{ id: 42, is_plugin: false }];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });

    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it('keeps the run-proven pane when command metadata is null', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false, terminal_command: null },
          ];
        }
        return [{ id: 42, is_plugin: false, terminal_command: null }];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });
  });

  it('does not infer ownership from a stale command pane', async () => {
    let listCount = 0;
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
      listPanes: vi.fn(async () => {
        listCount += 1;
        if (listCount === 1) {
          return [
            { id: 7, is_plugin: false, terminal_command: 'shell' },
            { id: 42, is_plugin: false, terminal_command: 'claude' },
          ];
        }
        return [
          { id: 42, is_plugin: false, terminal_command: 'claude', exited: true },
          { id: 99, is_plugin: false, terminal_command: 'stale claude' },
        ];
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_42' });
    expect(actions.closePane).not.toHaveBeenCalled();
  });

  it('redacts sensitive command metadata in zellij liveness diagnostics', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{
        id: 42,
        is_plugin: false,
        terminal_command: 'claude ANTHROPIC_API_KEY=sk-ant-secret-value',
      }]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 275,
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });

    expect(liveness.paneCurrentCommand).toContain('ANTHROPIC_API_KEY=[redacted-token]');
    expect(liveness.paneCurrentCommand).not.toContain('sk-ant-secret-value');
  });

  it('captures a bounded redacted screen dump when a zellij pane is dead', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{
        id: 42,
        is_plugin: false,
        terminal_command: '/managed/node',
        exited: true,
        exit_status: 127,
      }]),
      dumpScreen: vi.fn(async () => [
        'API Error: 401 Invalid authentication credentials',
        'ANTHROPIC_API_KEY=sk-ant-secret-value',
        'OPENAI_API_KEY=sk-openai-secret-value',
        'GEMINI_ACCESS_TOKEN=gemini-access-secret',
        'ANTHROPIC_AUTH_TOKEN: anthropic-auth-secret',
        'CLAUDE_CODE_OAUTH_TOKEN: claude-oauth-secret',
        'AWS_SECRET_ACCESS_KEY: aws-secret-value',
        'anthropic_api_key=lowercase-anthropic-secret',
        'npm_config_//registry.npmjs.org/:_authToken=npm-auth-token-secret',
        'MixedAccessToken: mixed-access-secret',
        'refresh_token=provider-refresh-secret',
        'Authorization: Bearer provider-bearer-secret',
      ].join('\n')),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 300,
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });

    expect(liveness).toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneExitStatus: 127,
      paneScreenDumpCaptured: true,
      paneScreenDumpTruncated: false,
    });
    expect(liveness).not.toHaveProperty('paneScreenDump');
  });

  it('redacts sensitive dump-screen error diagnostics when a zellij pane is dead', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{
        id: 42,
        is_plugin: false,
        terminal_command: '/managed/node',
        exited: true,
        exit_status: 127,
      }]),
      dumpScreen: vi.fn(async () => {
        throw new Error('dump failed: ANTHROPIC_API_KEY=sk-ant-secret-value Authorization: Bearer provider-bearer-secret');
      }),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 301,
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });

    expect(liveness.paneScreenDumpError).toContain('ANTHROPIC_API_KEY=[redacted-token]');
    expect(liveness.paneScreenDumpError).not.toContain('sk-ant-secret-value');
    expect(liveness.paneScreenDumpError).not.toContain('provider-bearer-secret');
  });

  it('surfaces shared topology instead of closing leftover live panes', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [
        { id: 7, is_plugin: false, terminal_command: 'shell' },
        { id: 42, is_plugin: false, terminal_command: 'claude' },
      ]),
    });
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({
      paneId: 'terminal_42',
      attachMetadata: expect.objectContaining({ topology: 'shared' }),
    });

    expect(actions.closePane).not.toHaveBeenCalled();
    expect(actions.killSession).not.toHaveBeenCalled();
  });
  it('createControlPort wires the session env and pane target for verified control sends', async () => {
    const actions = createActions();
    const adapter = createTestZellijAdapter({
      zellijBinary: '/tools/zellij',
      socketDir: '/tmp/zellij-sock',
      actions,
      now: () => 777,
    });

    const port = adapter.createControlPort?.({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_42',
      socketDir: '/tmp/zellij-sock',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });

    expect(port?.hostKind).toBe('zellij');
    await expect(port?.sendLiteralText('/model')).resolves.toEqual({ status: 'sent', at: 777 });
    expect(actions.writeBytesChunked).toHaveBeenCalledWith(expect.objectContaining({
      zellijBinary: '/tools/zellij',
      paneId: 'terminal_42',
      text: '/model',
      env: expect.objectContaining({
        ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock',
        ZELLIJ_SESSION_NAME: 'session-a',
      }),
    }));
    // Literal typing must never submit.
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });
});
