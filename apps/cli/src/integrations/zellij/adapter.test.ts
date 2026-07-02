import { describe, expect, it, vi } from 'vitest';

import { createZellijTerminalHostAdapter } from './adapter';
import type { ZellijActions } from './actions';

function createActions(overrides?: Partial<ZellijActions>): ZellijActions {
  return {
    attachCreateBackground: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' })),
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

describe('createZellijTerminalHostAdapter', () => {
  it('creates a background session and returns the launched terminal pane handle', async () => {
    const actions = createActions();
    const adapter = createZellijTerminalHostAdapter({
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
    }));
    expect(actions.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      command: ['/managed/node', 'claude_local_launcher.cjs'],
      env: {
        HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js',
        ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock',
      },
    }));
  });

  it('injects prompt bytes into the explicit pane and then submits Enter', async () => {
    const actions = createActions();
    const adapter = createZellijTerminalHostAdapter({
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

    expect(actions.writeBytesChunked).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_42',
      text: 'queued prompt',
      timeoutMs: expect.any(Number),
    }));
    expect(actions.sendEnter).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_42',
      timeoutMs: expect.any(Number),
    }));
  });

  it('injects multiline prompt bytes as raw bytes before submitting Enter', async () => {
    const actions = createActions();
    const adapter = createZellijTerminalHostAdapter({
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

    expect(actions.writeBytesChunked).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_42',
      text: rawText,
    }));
  });

  it('injects into a created handle when zellij reports only executable command metadata', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }]),
    });
    const adapter = createZellijTerminalHostAdapter({
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

    expect(actions.writeBytesChunked).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_42' }));
    expect(actions.sendEnter).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_42' }));
  });

  it('uses the only matching live command pane when zellij rekeys the tracked pane after launch', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [
        { id: 0, is_plugin: true, terminal_command: null },
        { id: 0, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
        { id: 2, is_plugin: false, terminal_command: null },
      ]),
    });
    const adapter = createZellijTerminalHostAdapter({
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

    expect(actions.writeBytesChunked).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_0' }));
    expect(actions.sendEnter).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_0' }));
  });

  it('does not retarget a missing zellij pane to an unrelated sole command pane', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 0, is_plugin: false, terminal_command: '/bin/zsh' }]),
    });
    const adapter = createZellijTerminalHostAdapter({
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
    const adapter = createZellijTerminalHostAdapter({
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
    const adapter = createZellijTerminalHostAdapter({
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
    const adapter = createZellijTerminalHostAdapter({
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
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: true });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('does not trust an exact zellij pane id when command metadata only shares the executable with another script', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{ id: 1, is_plugin: false, terminal_command: '/managed/node unrelated_launcher.cjs' }]),
    });
    const adapter = createZellijTerminalHostAdapter({
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
    const adapter = createZellijTerminalHostAdapter({
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

  it('marks a transient missing zellij pane as recoverable before writing', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => []),
    });
    const adapter = createZellijTerminalHostAdapter({
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
      scheduling: { timeoutMs: 1_000 },
    })).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: true });

    expect(actions.writeBytesChunked).not.toHaveBeenCalled();
    expect(actions.sendEnter).not.toHaveBeenCalled();
  });

  it('kills the managed session when command launch fails after background attach', async () => {
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'bad command' })),
    });
    const adapter = createZellijTerminalHostAdapter({
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

  it('kills the managed session when pane targeting is ambiguous', async () => {
    const actions = createActions({
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      listPanes: vi.fn(async () => [
        { id: 41, is_plugin: false, terminal_command: 'shell' },
        { id: 42, is_plugin: false, terminal_command: 'claude' },
      ]),
    });
    const adapter = createZellijTerminalHostAdapter({
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

  it('fails closed instead of retargeting an unproven command pane when the launched pane disappears after cleanup', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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
    })).rejects.toThrow(/launched terminal pane disappeared/);

    expect(actions.closePane).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_7',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('fails closed when a closed bootstrap pane reappears with unrelated command metadata', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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
    })).rejects.toThrow(/launched terminal pane disappeared/);

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('fails closed when a closed bootstrap pane reappears with another launch spec path', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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
    })).rejects.toThrow(/launched terminal pane disappeared/);

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('fails closed when a closed bootstrap pane reappears with only executable metadata', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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
    })).rejects.toThrow(/launched terminal pane disappeared/);

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('returns the command pane observed after cleanup when zellij rekeys onto a closed bootstrap pane', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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
    })).resolves.toMatchObject({ paneId: 'terminal_7' });

    expect(actions.closePane).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'terminal_7' }));
    expect(actions.killSession).not.toHaveBeenCalled();
  });

  it('keeps the originally discovered live pane after cleanup when zellij omits command metadata', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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

    expect(actions.closePane).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_7',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('keeps the originally discovered live pane after cleanup when zellij reports null command metadata', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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

  it('does not retarget to a stale command pane when the launched pane is dead after cleanup', async () => {
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
    const adapter = createZellijTerminalHostAdapter({
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
    })).rejects.toThrow(/launched terminal pane disappeared/);

    expect(actions.killSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session-a',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
  });

  it('redacts sensitive command metadata in zellij liveness diagnostics', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [{
        id: 42,
        is_plugin: false,
        terminal_command: 'claude ANTHROPIC_API_KEY=sk-ant-secret-value',
      }]),
    });
    const adapter = createZellijTerminalHostAdapter({
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
    const adapter = createZellijTerminalHostAdapter({
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
    const adapter = createZellijTerminalHostAdapter({
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

  it('closes leftover live panes after resolving the launched pane from run output', async () => {
    const actions = createActions({
      listPanes: vi.fn(async () => [
        { id: 7, is_plugin: false, terminal_command: 'shell' },
        { id: 42, is_plugin: false, terminal_command: 'claude' },
      ]),
    });
    const adapter = createZellijTerminalHostAdapter({
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

    expect(actions.closePane).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'terminal_7',
      env: { ZELLIJ_SOCKET_DIR: '/tmp/zellij-sock' },
    }));
    expect(actions.killSession).not.toHaveBeenCalled();
  });
  it('createControlPort wires the session env and pane target for verified control sends', async () => {
    const actions = createActions();
    const adapter = createZellijTerminalHostAdapter({
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
