import { describe, expect, it, vi } from 'vitest';

import { createTmuxTerminalHostAdapter, type TmuxTerminalHostUtility } from './adapter';
import { TmuxUtilities } from './TmuxUtilities';
import type { TmuxCommandResult } from './types';

function createUtility(overrides?: Partial<TmuxTerminalHostUtility>): TmuxTerminalHostUtility {
  return {
    executeTmuxCommand: vi.fn(async (args: readonly string[]): Promise<TmuxCommandResult> => ({
      returncode: 0,
      stdout: args[0] === 'display-message' ? '0\t12345\tclaude\n' : '',
      stderr: '',
      command: [...args],
    })),
    spawnInTmux: vi.fn(async () => ({ success: true, sessionName: 'session-a', windowName: 'claude' })),
    captureCurrentInput: vi.fn(async () => ''),
    sendKeys: vi.fn(async () => true),
    killWindow: vi.fn(async () => true),
    ...overrides,
  };
}

describe('createTmuxTerminalHostAdapter', () => {
  it('injects prompts into the explicit tmux target and returns typed host metadata', async () => {
    const utility = createUtility();
    const adapter = createTmuxTerminalHostAdapter({ tmux: utility, now: () => 123 });

    await expect(adapter.injectUserPrompt({
      kind: 'tmux',
      sessionName: 'session-a',
      paneId: 'claude',
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
      injectedAt: 123,
      bytesWritten: Buffer.byteLength('queued prompt'),
      hostKind: 'tmux',
      hostSessionName: 'session-a',
      paneId: 'claude',
    });

    expect(utility.executeTmuxCommand).toHaveBeenCalledWith(
      ['send-keys', '-t', 'session-a:claude', '-l', '--', 'queued prompt'],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { timeoutMs: expect.any(Number) },
    );
    expect(utility.executeTmuxCommand).toHaveBeenCalledWith(
      ['send-keys', '-t', 'session-a:claude', 'C-m'],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { timeoutMs: expect.any(Number) },
    );
  });

  it('fails before writing when the tmux target is missing', async () => {
    const adapter = createTmuxTerminalHostAdapter({ tmux: createUtility(), now: () => 321 });

    await expect(adapter.injectUserPrompt({
      kind: 'tmux',
      sessionName: '',
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
      scheduling: {},
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'no_target',
      phase: 'liveness',
      duplicateRisk: 'none',
      observedAt: 321,
      recoverable: true,
    });
  });

  it('captureInputState returns the FULL pane so multi-line steer vetoes above the composer are visible (R-E1)', async () => {
    // A live-shaped Claude pane: the permission prompt sits SEVERAL rows ABOVE the bottom composer.
    // tmux must surface the whole pane, not just the last line, or the multi-line screen parser is blinded.
    const pane = [
      '● Bash(rm -rf build)',
      '  Do you want to proceed?',
      '  1. Yes',
      '  2. No',
      '',
      '│ > │',
    ].join('\n');
    let captures = 0;
    // Use the REAL TmuxUtilities (only the tmux command boundary mocked) so the genuine
    // captureCurrentInput slicing behavior is exercised, not a hand-mocked stub.
    const tmux = new TmuxUtilities();
    tmux.executeTmuxCommand = vi.fn(async (args: readonly string[]): Promise<TmuxCommandResult> => {
      if (args[0] === 'capture-pane') {
        captures += 1;
        return { returncode: 0, stdout: `${pane}\n`, stderr: '', command: [...args] };
      }
      return { returncode: 0, stdout: '', stderr: '', command: [...args] };
    }) as TmuxUtilities['executeTmuxCommand'];
    const adapter = createTmuxTerminalHostAdapter({ tmux, now: () => 999, wait: async () => {} });

    const state = await adapter.captureInputState!({
      kind: 'tmux',
      sessionName: 'session-a',
      paneId: 'claude',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });

    // The line ABOVE the bottom composer must be present (was dropped by the last-line-only bug).
    expect(state.currentInput).toContain('Do you want to proceed?');
    expect(state.currentInput).toContain('> ');
    expect(state.stable).toBe(true);
    expect(state.observedAt).toBe(999);
    // Two capture passes (parity with zellij), not three (no isUserTyping re-capture; R-E3).
    expect(captures).toBe(2);
    // Styling must be preserved (-e) so the dim-placeholder composer detection has SGR info (ported S-8).
    const captureCalls = (tmux.executeTmuxCommand as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => (call[0] as readonly string[])[0] === 'capture-pane');
    expect(captureCalls.length).toBe(2);
    for (const call of captureCalls) {
      expect(call[0]).toContain('-e');
    }
  });

  it('honors scheduled deferrals before probing tmux liveness', async () => {
    const utility = createUtility();
    const adapter = createTmuxTerminalHostAdapter({ tmux: utility, now: () => 456 });

    await expect(adapter.injectUserPrompt({
      kind: 'tmux',
      sessionName: 'session-a',
      paneId: 'claude',
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
      scheduling: { deferReason: 'permission', retryAfterMs: 250 },
    })).resolves.toEqual({
      status: 'deferred',
      reason: 'permission',
      recoverable: true,
      observedAt: 456,
      retryAfterMs: 250,
      hostKind: 'tmux',
      hostSessionName: 'session-a',
      paneId: 'claude',
    });

    expect(utility.executeTmuxCommand).not.toHaveBeenCalled();
  });

  it('createControlPort targets the handle pane and types literal text WITHOUT submitting', async () => {
    const utility = createUtility();
    const adapter = createTmuxTerminalHostAdapter({ tmux: utility, now: () => 555 });

    const port = adapter.createControlPort?.({
      kind: 'tmux',
      sessionName: 'session-a',
      paneId: 'claude',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    });

    expect(port?.hostKind).toBe('tmux');
    await expect(port?.sendLiteralText('/model')).resolves.toEqual({ status: 'sent', at: expect.any(Number) });

    const calls = vi.mocked(utility.executeTmuxCommand).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual(['send-keys', '-t', 'session-a:claude', '-l', '--', '/model']);
    // Literal typing must never submit: no Enter / C-m key may be sent by sendLiteralText.
    expect(calls.some(([args]) => args.includes('C-m') || args.includes('Enter'))).toBe(false);
  });
});
