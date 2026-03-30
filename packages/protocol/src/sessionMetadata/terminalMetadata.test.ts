import { describe, expect, it } from 'vitest';
import * as protocol from '../index.js';

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
});
