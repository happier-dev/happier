import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { persistTerminalAttachmentInfoIfNeeded } from './persistTerminalAttachmentInfo';

type WriteInput = Parameters<typeof writeTerminalAttachmentInfo>[0];

const tmuxTerminal = {
  mode: 'tmux',
  requested: 'tmux',
  tmux: { target: 'happier:happy-window-1', tmpDir: '/tmp/happier-tmux' },
} as NonNullable<Metadata['terminal']>;

describe('persistTerminalAttachmentInfoIfNeeded', () => {
  it('binds tmux metadata as a version-2 write with a derived handle and attachment id', async () => {
    const writes: WriteInput[] = [];
    const writeAttachmentInfo = vi.fn(async (input: WriteInput) => {
      writes.push(input);
    });

    await persistTerminalAttachmentInfoIfNeeded({
      sessionId: 'sess-bound-write',
      terminal: tmuxTerminal,
      writeAttachmentInfo,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.attachmentId).toEqual(expect.any(String));
    expect(writes[0]?.handle).toMatchObject({ kind: 'tmux', sessionName: 'happier' });
  });

  it('falls back to the unbound record when the bound write fails, so a record always exists', async () => {
    const writes: WriteInput[] = [];
    const writeAttachmentInfo = vi.fn(async (input: WriteInput) => {
      writes.push(input);
      if (input.attachmentId) {
        throw new Error('Terminal attachment root does not match its bound host handle');
      }
    });

    await persistTerminalAttachmentInfoIfNeeded({
      sessionId: 'sess-fallback-write',
      terminal: tmuxTerminal,
      writeAttachmentInfo,
    });

    expect(writes).toHaveLength(2);
    expect(writes[1]?.attachmentId).toBeUndefined();
    expect(writes[1]?.handle).toBeUndefined();
    expect(writes[1]?.terminal).toEqual(tmuxTerminal);
  });

  it('writes the unbound record directly for modes without reconstructable host identity', async () => {
    const writes: WriteInput[] = [];
    const writeAttachmentInfo = vi.fn(async (input: WriteInput) => {
      writes.push(input);
    });

    await persistTerminalAttachmentInfoIfNeeded({
      sessionId: 'sess-windows-console',
      terminal: {
        mode: 'windows_console',
        requested: 'console',
        windows: { host: 'console' },
      } as NonNullable<Metadata['terminal']>,
      writeAttachmentInfo,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.attachmentId).toBeUndefined();
    expect(writes[0]?.handle).toBeUndefined();
  });
});
