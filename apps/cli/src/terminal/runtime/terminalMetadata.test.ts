import { describe, expect, it } from 'vitest';

import { buildTerminalMetadataFromRuntimeFlags } from './terminalMetadata';

describe('buildTerminalMetadataFromRuntimeFlags', () => {
  it('builds windows terminal metadata from runtime flags', () => {
    expect(buildTerminalMetadataFromRuntimeFlags({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windowId: 'happy-session-1',
    } as any)).toEqual({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windows: {
        host: 'windows_terminal',
        windowId: 'happy-session-1',
      },
    });
  });

  it('builds windows console metadata from runtime flags', () => {
    expect(buildTerminalMetadataFromRuntimeFlags({
      mode: 'windows_console',
      requested: 'console',
    } as any)).toEqual({
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
      },
    });
  });
});
