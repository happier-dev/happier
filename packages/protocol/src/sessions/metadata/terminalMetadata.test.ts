import { describe, expect, it } from 'vitest';
import * as protocol from '../../index.js';

describe('sessionMetadata terminal metadata', () => {
  it('parses tmux terminal metadata and preserves unknown fields', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux',
      requested: 'tmux',
      tmux: { target: 'happy:win-1', tmpDir: '/tmp/x' },
      extra: 'x',
    });
    expect(parsed.mode).toBe('tmux');
    expect((parsed as any).extra).toBe('x');
  });

  it('accepts tmux.tmpDir=null for backward compatibility', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux',
      tmux: { target: 'happy:win-1', tmpDir: null },
    });
    expect(parsed.mode).toBe('tmux');
    expect((parsed as any).tmux?.tmpDir).toBe(null);
  });

  it('parses zellij terminal metadata and preserves unknown fields', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'zellij',
      requested: 'zellij',
      zellij: { sessionName: 'happy-session-1' },
      extra: 'x',
    });
    expect(parsed.mode).toBe('zellij');
    expect((parsed as any).extra).toBe('x');
  });

  it('parses windows terminal metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windows: {
        host: 'windows_terminal',
        windowId: 'happy-session-1',
        pid: 123,
      },
    });
    expect(parsed.mode).toBe('windows_terminal');
    expect((parsed as any).windows?.windowId).toBe('happy-session-1');
  });

  it('parses windows console metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
        pid: 456,
      },
    });
    expect(parsed.mode).toBe('windows_console');
    expect((parsed as any).windows?.host).toBe('console');
  });

  it('parses recoverable terminal-host lifecycle metadata', () => {
    const parsed = (protocol as any).SessionTerminalMetadataSchema.parse({
      mode: 'tmux', tmux: { target: 'happy:win-1' },
      controlServiceabilityV1: { v: 1, attachmentId: 'attachment-1', state: 'recoverable_unservable', observedAt: 123, reason: 'session_rpc_unavailable' },
    });
    expect(parsed.controlServiceabilityV1.state).toBe('recoverable_unservable');
    expect((protocol as any).SessionTerminalMetadataSchema.safeParse({
      mode: 'tmux', tmux: { target: 'happy:win-1' },
      controlServiceabilityV1: { v: 1, state: 'running', observedAt: 123 },
    }).success).toBe(false);
  });

  it('accepts only explicitly retired legacy mode-less terminal metadata', () => {
    expect((protocol as any).SessionTerminalMetadataSchema.safeParse({
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-retired',
        state: 'unknown',
        observedAt: 123,
        reason: 'attachment_retired',
        retired: true,
      },
    }).success).toBe(true);

    expect((protocol as any).SessionTerminalMetadataSchema.safeParse({
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-still-live',
        state: 'unknown',
        observedAt: 123,
      },
    }).success).toBe(false);
  });

  it('permits destructive deletion only with explicit terminal retirement evidence', () => {
    const canDelete = (protocol as any).isSessionTerminalPermanentlyAbsent;
    expect(canDelete(undefined)).toBe(false);
    expect(canDelete({ v: 1, state: 'unknown', observedAt: 1 })).toBe(false);
    expect(canDelete({ v: 1, state: 'servable', observedAt: 1 })).toBe(false);
    expect(canDelete({ v: 1, state: 'recoverable_unservable', observedAt: 1 })).toBe(false);
    expect(canDelete({ v: 1, state: 'unknown', observedAt: 1, retired: true })).toBe(true);
  });
});
