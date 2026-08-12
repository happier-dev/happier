import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudePromptSubmitVerificationPolicy } from '@/backends/claude/unifiedTerminal/claudePromptSubmitVerification';
import { parseClaudeScreenState, resolveClaudeScreenInFlightSteerVeto } from '@/backends/claude/unifiedTerminal/tuiControls/screenState';

import { createTmuxTerminalHostAdapter } from './adapter';
import { TmuxUtilities } from './TmuxUtilities';

const TMUX_HANDLE = {
  kind: 'tmux',
  sessionName: 'happy',
  paneId: 'claude.1',
  attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
} as const;

function createClaudeTmuxTerminalHostAdapter(tmux: TmuxUtilities) {
  const policy = createClaudePromptSubmitVerificationPolicy();
  return createTmuxTerminalHostAdapter({
    tmux,
    promptSubmitVerification: {
      ...policy,
      isPromptStagedBeforeSubmit: () => true,
    },
  });
}

describe('createTmuxTerminalHostAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('captureInputState multi-line fidelity (R-E1)', () => {
    it('returns the FULL pane so multi-line steer vetoes (permission prompt above the bottom line) fire on tmux', async () => {
      // Live-shaped capture-pane output: a permission dialog sits ABOVE the bottom composer line.
      const fullPane = [
        '● Reading file src/index.ts',
        '',
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. No',
        '',
        '│ > │',
      ].join('\n');
      const tmux = new TmuxUtilities();
      vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
        returncode: 0,
        stdout: args[0] === 'capture-pane'
          ? `${fullPane}\n`
          : args[0] === 'display-message'
            ? '4\t6\n'
            : '',
        stderr: '',
        command: [...args],
      }));
      const adapter = createTmuxTerminalHostAdapter({ tmux });

      const inputState = await adapter.captureInputState?.(TMUX_HANDLE);
      expect(inputState).toBeDefined();
      expect(inputState?.cursor).toEqual({ x: 4, y: 6 });

      const screen = parseClaudeScreenState(inputState!.currentInput, { cursor: inputState!.cursor });
      // The permission prompt is several lines above the bottom; a last-line-only capture cannot see it.
      expect(screen.permissionPromptVisible).toBe(true);
      expect(resolveClaudeScreenInFlightSteerVeto(screen)).toBe('permission_prompt');
    });
  });

  it('declares terminal-host attach metadata for created tmux hosts', async () => {
    const tmux = new TmuxUtilities();
    vi.spyOn(tmux, 'spawnInTmux').mockResolvedValue({
      success: true,
      sessionName: 'happy',
      windowName: 'claude.1',
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'happy',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: { HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js' },
      isolatedEnv: true,
    });
    expect(handle).toMatchObject({
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'claude.1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });
    expect(handle.attachmentId).toEqual(expect.any(String));
    expect(handle.attachmentId).not.toHaveLength(0);
    expect(tmux.spawnInTmux).toHaveBeenCalledWith(
      ['/managed/node', 'claude_local_launcher.cjs'],
      {
        sessionName: 'happy',
        windowName: 'happy',
        cwd: '/workspace/project',
        requireNewSession: true,
      },
      { HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js' },
    );
  });

  it('adopts an existing live tmux host without spawning a new window', async () => {
    const tmux = new TmuxUtilities();
    const spawnInTmux = vi.spyOn(tmux, 'spawnInTmux');
    vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 0,
      stdout: '0\t12345\tclaude\n',
      stderr: '',
      command: [],
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(adapter.adoptExistingHost?.(TMUX_HANDLE)).resolves.toEqual(TMUX_HANDLE);

    expect(spawnInTmux).not.toHaveBeenCalled();
  });

  it('does not expose a destructive live-host relaunch operation', () => {
    const adapter = createTmuxTerminalHostAdapter({ tmux: new TmuxUtilities() });
    expect('relaunchExistingHost' in adapter).toBe(false);
  });

  it('destroys only the owned tmux window for shared topology', async () => {
    const tmux = new TmuxUtilities();
    const killWindow = vi.spyOn(tmux, 'killWindow').mockResolvedValue(true);
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand');
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await adapter.dispose(TMUX_HANDLE);

    expect(killWindow).toHaveBeenCalledWith('happy:claude.1');
    expect(executeTmuxCommand).not.toHaveBeenCalledWith(['kill-session'], expect.anything());
  });

  it('destroys the owned tmux session for exclusive topology', async () => {
    const tmux = new TmuxUtilities();
    const killWindow = vi.spyOn(tmux, 'killWindow').mockResolvedValue(true);
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 0,
      stdout: '',
      stderr: '',
      command: ['kill-session'],
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await adapter.dispose({
      ...TMUX_HANDLE,
      attachMetadata: { ...TMUX_HANDLE.attachMetadata, topology: 'exclusive' },
    });

    expect(executeTmuxCommand).toHaveBeenCalledWith(['kill-session'], 'happy');
    expect(killWindow).not.toHaveBeenCalled();
  });

  it('does not report shared tmux destruction when the owned window was not removed', async () => {
    const tmux = new TmuxUtilities();
    vi.spyOn(tmux, 'killWindow').mockResolvedValue(false);
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(adapter.dispose(TMUX_HANDLE)).rejects.toThrow(/owned tmux window/i);
  });

  it('pastes prompt text through a tmux buffer and submits with carriage return', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 0,
      stdout: '0\t12345\tclaude\n',
      stderr: '',
      command: [],
    });
    vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue('');
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: { deferredUntilQuietMs: 250 },
        },
      ),
    ).resolves.toMatchObject({ status: 'injected' });

    const calls = executeTmuxCommand.mock.calls;
    const loadArgs = calls[3]?.[0];
    expect(loadArgs?.[0]).toBe('load-buffer');
    const bufferName = loadArgs?.[2];
    expect(typeof bufferName).toBe('string');
    expect(calls.map((call) => call[0])).toEqual([
      ['display-message', '-p', '-t', 'happy:claude.1', '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}'],
      ['display-message', '-p', '#{cursor_x}\t#{cursor_y}'],
      ['display-message', '-p', '#{cursor_x}\t#{cursor_y}'],
      ['load-buffer', '-b', bufferName, '-'],
      ['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', 'happy:claude.1'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
    expect(calls[3]?.[5]).toBe('queued prompt');
  });

  it('does not claim a single-line Claude prompt was injected while it remains in the composer', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
      returncode: 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: '',
      command: [...args],
    }));
    const captureCurrentInput = vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue([
      'Please run /login · API Error: 401 Invalid authentication credentials',
      '❯ continue',
      '▶▶ auto mode on',
    ].join('\n'));
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(
      adapter.injectUserPrompt(
        TMUX_HANDLE,
        {
          text: 'continue',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-single-line-stuck' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
    });

    expect(executeTmuxCommand.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
    expect(captureCurrentInput).toHaveBeenCalledTimes(2);
  });

  it('waits for the Claude composer to stage the exact prompt before sending Enter', async () => {
    const prompt = 'continue';
    const order: string[] = [];
    const tmux = new TmuxUtilities();
    vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => {
      order.push(args[0] ?? '');
      return {
        returncode: 0,
        stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
        stderr: '',
        command: [...args],
      };
    });
    let captureCount = 0;
    vi.spyOn(tmux, 'captureCurrentInput').mockImplementation(async () => {
      captureCount += 1;
      order.push(`capture:${captureCount}`);
      if (captureCount === 1) return 'Claude Code\n❯';
      if (captureCount === 2) return `Claude Code\n❯ ${prompt}`;
      return 'Claude Code\n❯';
    });
    const adapter = createTmuxTerminalHostAdapter({
      tmux,
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
    });

    await expect(adapter.injectUserPrompt(
      TMUX_HANDLE,
      {
        text: prompt,
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-stage-before-enter' },
        scheduling: { timeoutMs: 500 },
      },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(order.indexOf('capture:2')).toBeLessThan(order.indexOf('send-keys'));
    expect(captureCount).toBeGreaterThanOrEqual(4);
  });

  it('does not submit when pre-submit screen capture is unavailable', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
      returncode: 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: '',
      command: [...args],
    }));
    vi.spyOn(tmux, 'captureCurrentInput').mockRejectedValue(new Error('capture unavailable'));
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(adapter.injectUserPrompt(
      TMUX_HANDLE,
      {
        text: 'queued prompt',
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-capture-unavailable' },
        scheduling: { timeoutMs: 250 },
      },
    )).resolves.toMatchObject({
      status: 'failed',
      reason: 'host_unreachable',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
    });

    expect(executeTmuxCommand.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys')).toEqual([]);
  });

  it('pastes multiline prompts without sending tmux newline keys before submit', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 0,
      stdout: '0\t12345\tclaude\n',
      stderr: '',
      command: [],
    });
    const captureCurrentInput = vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue('');
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'alpha\nbeta',
          multiline: true,
          origin: { kind: 'ui_pending', nonce: 'nonce-multiline' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'injected' });

    const calls = executeTmuxCommand.mock.calls;
    const bufferName = calls[1]?.[0]?.[2];
    expect(calls.map((call) => call[0])).toEqual([
      ['display-message', '-p', '-t', 'happy:claude.1', '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}'],
      ['load-buffer', '-b', bufferName, '-'],
      ['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', 'happy:claude.1'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
    expect(calls[1]?.[5]).toBe('alpha\nbeta');
    expect(calls.map((call) => call[0]).some((args) => args[0] === 'send-keys' && args.includes('C-j'))).toBe(false);
    expect(captureCurrentInput).not.toHaveBeenCalled();
  });

  it('keeps incident-sized prompts on one tmux buffer paste instead of chunked key sends', async () => {
    const prompt = `${Array.from({ length: 6_000 }, (_, index) => `line ${index.toString().padStart(4, '0')} ${'x'.repeat(32)}`).join('\n')}

[attachments]
- synthetic-large-prompt.txt
[/attachments]`;
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(250_000);

    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 0,
      stdout: '0\t12345\tclaude\n',
      stderr: '',
      command: [],
    });
    const captureCurrentInput = vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue('');
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: prompt,
          multiline: true,
          origin: { kind: 'ui_pending', nonce: 'nonce-large' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength(prompt, 'utf8') });

    const calls = executeTmuxCommand.mock.calls;
    const bufferName = calls[1]?.[0]?.[2];
    expect(calls.map((call) => call[0])).toEqual([
      ['display-message', '-p', '-t', 'happy:claude.1', '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}'],
      ['load-buffer', '-b', bufferName, '-'],
      ['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', 'happy:claude.1'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
    expect(calls[1]?.[5]).toBe(prompt);
    expect(calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
    expect(calls.flatMap((call) => call[0])).not.toContain(prompt);
    expect(captureCurrentInput).toHaveBeenCalledTimes(1);
  });

  it('submits a large tmux paste before checking whether it remains pending', async () => {
    const prompt = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(36)}`).join('\n');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(250_000);
    const order: string[] = [];
    const tmux = new TmuxUtilities();
    vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => {
      order.push(args[0] ?? '');
      return {
        returncode: 0,
        stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
        stderr: '',
        command: [...args],
      };
    });
    let captureCount = 0;
    vi.spyOn(tmux, 'captureCurrentInput').mockImplementation(async () => {
      captureCount += 1;
      order.push('capture-current-input');
      return '';
    });
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: prompt,
          multiline: true,
          origin: { kind: 'ui_pending', nonce: 'nonce-large-verify' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(order).toEqual([
      'display-message',
      'load-buffer',
      'paste-buffer',
      'send-keys',
      'capture-current-input',
    ]);
  });

  it('submits large tmux paste once when post-submit stuck-composer evidence is inconclusive', async () => {
    const prompt = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(36)}`).join('\n');
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
      returncode: 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: '',
      command: [...args],
    }));
    const captureCurrentInput = vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue('old composer contents');
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: prompt,
          multiline: true,
          origin: { kind: 'ui_pending', nonce: 'nonce-large-unverified' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength(prompt, 'utf8') });

    expect(executeTmuxCommand.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
    expect(captureCurrentInput).toHaveBeenCalledTimes(1);
  });

  it('does not retry Enter when only a stale visible placeholder matches after submit', async () => {
    const prompt = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(36)}`).join('\n');
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
      returncode: 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: '',
      command: [...args],
    }));
    vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue([
        'previous prompt already submitted',
        '[Pasted text +5999 lines]',
        '',
        '│ > │',
      ].join('\n'));
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: prompt,
          multiline: true,
          origin: { kind: 'ui_pending', nonce: 'nonce-large-stale-placeholder' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength(prompt, 'utf8') });

    expect(executeTmuxCommand.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
  });

  it('does not retry Enter when a submitted prompt-shaped transcript marker remains above the composer', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
      returncode: 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: '',
      command: [...args],
    }));
    vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue([
      'earlier submitted prompt',
      '❯ [Pasted text #1 +40 lines]',
      '',
      '│ > │',
    ].join('\n'));
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n'),
          multiline: true,
          origin: { kind: 'ui_pending', nonce: 'nonce-post-submit-stale' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(executeTmuxCommand.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
  });

  it('retries Enter when the current composer marker has footer rows below it', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
      returncode: 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: '',
      command: [...args],
    }));
    let captureCount = 0;
    vi.spyOn(tmux, 'captureCurrentInput').mockImplementation(async () => {
      captureCount += 1;
      if (captureCount === 1) {
        return [
          '┄'.repeat(20),
          '› [Pasted text #1 +40 lines]',
          '─'.repeat(20),
          '▶▶ auto mode on (shift+tab to cycle)',
        ].join('\n');
      }
      return '';
    });
    const adapter = createClaudeTmuxTerminalHostAdapter(tmux);

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n'),
          multiline: true,
          origin: { kind: 'ui_pending', nonce: 'nonce-post-submit-footer' },
          scheduling: {},
        },
      ),
    ).resolves.toMatchObject({ status: 'injected' });

    expect(executeTmuxCommand.mock.calls.map((call) => call[0]).filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
  });

  it('keeps leading-dash prompt text out of tmux argv by loading it through stdin', async () => {
    const originalChunkSize = process.env.HAPPIER_CLI_TMUX_SEND_KEYS_CHUNK_SIZE;
    process.env.HAPPIER_CLI_TMUX_SEND_KEYS_CHUNK_SIZE = '4';
    try {
      const tmux = new TmuxUtilities();
      const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
        returncode: 0,
        stdout: '0\t12345\tclaude\n',
        stderr: '',
        command: [],
      });
      const adapter = createTmuxTerminalHostAdapter({ tmux });

      await expect(
        adapter.injectUserPrompt(
          {
            kind: 'tmux',
            sessionName: 'happy',
            paneId: 'claude.1',
            attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
          },
          {
            text: '-abcdef',
            multiline: false,
            origin: { kind: 'ui_pending', nonce: 'nonce-chunked' },
            scheduling: {},
          },
        ),
      ).resolves.toMatchObject({ status: 'injected' });

      const calls = executeTmuxCommand.mock.calls;
      const bufferName = calls[1]?.[0]?.[2];
      expect(calls.map((call) => call[0])).toEqual([
        ['display-message', '-p', '-t', 'happy:claude.1', '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}'],
        ['load-buffer', '-b', bufferName, '-'],
        ['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', 'happy:claude.1'],
        ['send-keys', '-t', 'happy:claude.1', 'C-m'],
      ]);
      expect(calls[1]?.[5]).toBe('-abcdef');
      expect(calls.flatMap((call) => call[0])).not.toContain('-abcdef');
    } finally {
      if (originalChunkSize === undefined) {
        delete process.env.HAPPIER_CLI_TMUX_SEND_KEYS_CHUNK_SIZE;
      } else {
        process.env.HAPPIER_CLI_TMUX_SEND_KEYS_CHUNK_SIZE = originalChunkSize;
      }
    }
  });

  it('honors runtime-core deferral reasons before touching tmux', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand');
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: { deferReason: 'permission_blocked', retryAfterMs: 500 },
        },
      ),
    ).resolves.toEqual({ status: 'deferred', reason: 'permission_blocked', retryAfterMs: 500 });

    expect(executeTmuxCommand).not.toHaveBeenCalled();
  });

  it('interrupts the active tmux turn with Escape on the canonical window target', async () => {
    const tmux = new TmuxUtilities();
    const sendKeys = vi.spyOn(tmux, 'sendKeys').mockResolvedValue(true);
    const adapter = createTmuxTerminalHostAdapter({ tmux });
    const interruptTurn = (adapter as unknown as {
      interruptTurn?: (handle: {
        kind: 'tmux';
        sessionName: string;
        paneId?: string;
        attachMetadata: { attachStrategy: 'terminal_host'; topology: 'shared' };
      }) => Promise<void>;
    }).interruptTurn;

    expect(interruptTurn).toBeTypeOf('function');
    await interruptTurn?.({
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'claude.1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(sendKeys).toHaveBeenCalledWith('Escape', 'happy:claude.1');
  });

  it('fails with no_target when the handle has no tmux target', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand');
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: '',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: {},
        },
      ),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'no_target',
      phase: 'liveness',
      duplicateRisk: 'none',
      recoverable: true,
    });

    expect(executeTmuxCommand).not.toHaveBeenCalled();
  });

  it('fails with pane_dead when tmux liveness reports a dead pane', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 0,
      stdout: '1\t12345\tzsh\n',
      stderr: '',
      command: [],
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: {},
        },
      ),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'pane_dead',
      phase: 'liveness',
      duplicateRisk: 'none',
      recoverable: false,
    });

    expect(executeTmuxCommand).toHaveBeenCalledTimes(1);
  });

  it('defers instead of failing when tmux liveness probe is inconclusive', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 1,
      stdout: '',
      stderr: 'display-message timed out',
      command: [],
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: { retryAfterMs: 250 },
        },
      ),
    ).resolves.toEqual({
      status: 'deferred',
      reason: 'pane_initializing',
      retryAfterMs: 250,
    });

    expect(executeTmuxCommand).toHaveBeenCalledTimes(1);
  });

  it('fails with host_unreachable and cleans up when tmux paste fails after loading a buffer', async () => {
    const tmux = new TmuxUtilities();
    vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => ({
      returncode: args[0] === 'paste-buffer' ? 1 : 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: args[0] === 'paste-buffer' ? 'tmux unavailable' : '',
      command: [...args],
    }));
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: {},
        },
      ),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'host_unreachable',
      phase: 'during_write',
      duplicateRisk: 'none',
      recoverable: true,
    });
    expect((tmux.executeTmuxCommand as unknown as { mock: { calls: Array<[readonly string[]]> } }).mock.calls.map((call) => call[0][0])).toContain('delete-buffer');
  });

  it('fails with timeout when prompt injection exceeds its deadline', async () => {
    const tmux = new TmuxUtilities();
    vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => {
      if (args[0] === 'display-message') {
        return { returncode: 0, stdout: '0\t12345\tclaude\n', stderr: '', command: [...args] };
      }
      return {
        returncode: args[0] === 'load-buffer' || args[0] === 'delete-buffer' ? 0 : 1,
        stdout: '',
        stderr: '',
        command: [...args],
        ...(args[0] === 'paste-buffer' ? { timedOut: true } : {}),
      };
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: { timeoutMs: 5 },
        },
      ),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
      phase: 'during_write',
      duplicateRisk: 'possible',
      recoverable: true,
    });
  });

  it('waits for an in-flight tmux load-buffer command before reporting an exhausted pre-write deadline', async () => {
    vi.useFakeTimers();
    const tmux = new TmuxUtilities();
    const calls: readonly string[][] = [];
    let finishWrite: ((result: { returncode: number; stdout: string; stderr: string; command: string[] }) => void) | undefined;
    vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === 'display-message') {
        return { returncode: 0, stdout: '0\t12345\tclaude\n', stderr: '', command: [...args] };
      }
      if (args[0] === 'load-buffer') {
        return new Promise((resolve) => {
          finishWrite = resolve;
        });
      }
      return { returncode: 0, stdout: '', stderr: '', command: [...args] };
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    let settled = false;
    const injection = adapter.injectUserPrompt(
      {
        kind: 'tmux',
        sessionName: 'happy',
        paneId: 'claude.1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: 'queued prompt',
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-a' },
        scheduling: { timeoutMs: 5 },
      },
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    finishWrite?.({ returncode: 0, stdout: '', stderr: '', command: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(injection).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: true,
    });
    expect(calls).toEqual([
      ['display-message', '-p', '-t', 'happy:claude.1', '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}'],
      ['load-buffer', '-b', calls[1]?.[2] ?? '', '-'],
      ['delete-buffer', '-b', calls[1]?.[2] ?? ''],
    ]);
  });

  it('defers injection with a typed user_typing result when scheduled quiet input is unstable', async () => {
    const tmux = new TmuxUtilities();
    const executeTmuxCommand = vi.spyOn(tmux, 'executeTmuxCommand').mockResolvedValue({
      returncode: 0,
      stdout: '0\t12345\tclaude\n',
      stderr: '',
      command: [],
    });
    // Two full-pane captures that differ => the user is mid-keystroke => unstable => defer.
    const captureCurrentInput = vi.spyOn(tmux, 'captureCurrentInput')
      .mockResolvedValueOnce('partial promp')
      .mockResolvedValueOnce('partial prompt');

    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'claude.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'queued prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: { deferredUntilQuietMs: 250 },
        },
      ),
    ).resolves.toEqual({ status: 'deferred', reason: 'user_typing', retryAfterMs: 250 });

    expect(executeTmuxCommand).toHaveBeenCalledTimes(3);
    expect(captureCurrentInput).toHaveBeenCalledTimes(2);
    expect(captureCurrentInput).toHaveBeenNthCalledWith(1, 'happy:claude.1');
    expect(captureCurrentInput).toHaveBeenNthCalledWith(2, 'happy:claude.1');
  });

  it('authorizes only after final quiet checks and classifies the first post-authorization failure as possible-write', async () => {
    const order: string[] = [];
    const tmux = new TmuxUtilities();
    vi.spyOn(tmux, 'captureCurrentInput').mockResolvedValue('');
    vi.spyOn(tmux, 'executeTmuxCommand').mockImplementation(async (args) => {
      order.push(String(args[0]));
      return {
        returncode: args[0] === 'paste-buffer' ? 1 : 0,
        stdout: args[0] === 'display-message' && args.includes('#{pane_dead}\t#{pane_pid}\t#{pane_current_command}')
          ? '0\t12345\tclaude\n'
          : '',
        stderr: '',
        command: [],
      };
    });
    const authorizeBeforeWrite = vi.fn(async () => {
      order.push('authorize_write');
      return true;
    });
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    await expect(adapter.injectUserPrompt(
      TMUX_HANDLE,
      {
        text: 'attempt prompt',
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'attempt-tmux' },
        scheduling: { deferredUntilQuietMs: 1 },
      },
      { authorizeBeforeWrite },
    )).resolves.toMatchObject({
      status: 'failed',
      phase: 'during_write',
      duplicateRisk: 'possible',
    });

    expect(authorizeBeforeWrite).toHaveBeenCalledTimes(1);
    expect(order.indexOf('authorize_write')).toBeGreaterThan(order.lastIndexOf('load-buffer'));
    expect(order.indexOf('authorize_write')).toBeLessThan(order.indexOf('paste-buffer'));
  });

  it('exposes a runtime-control port bound to the pane that is distinct from prompt injection', async () => {
    const tmux = new TmuxUtilities();
    const adapter = createTmuxTerminalHostAdapter({ tmux });

    const port = adapter.createControlPort?.({
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'claude.1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });

    expect(port).not.toBeNull();
    expect(port?.hostKind).toBe('tmux');
    // The control port is a dedicated surface; it must never expose prompt injection.
    expect('injectUserPrompt' in (port ?? {})).toBe(false);

    const empty = adapter.createControlPort?.({
      kind: 'tmux',
      sessionName: '   ',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });
    expect(empty).toBeNull();
  });
});
