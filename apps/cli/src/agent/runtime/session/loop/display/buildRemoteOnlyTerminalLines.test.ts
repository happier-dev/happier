import { describe, expect, it } from 'vitest';

import {
  buildRemoteOnlyTerminalFooterLines,
  buildRemoteOnlyTerminalTitle,
} from './buildRemoteOnlyTerminalLines';

describe('remote-only terminal display lines', () => {
  it('shows unsupported-terminal confirmation only when terminal mode was requested', () => {
    const terminalRequestLines = buildRemoteOnlyTerminalFooterLines({
      backendDisplayName: 'Qwen Code',
      requestedMode: 'terminal',
    }).join('\n');
    const remoteRequestLines = buildRemoteOnlyTerminalFooterLines({
      backendDisplayName: 'Qwen Code',
      requestedMode: 'remote',
    }).join('\n');

    expect(terminalRequestLines).toContain('Terminal mode was requested');
    expect(remoteRequestLines).not.toContain('Terminal mode was requested');
    expect(remoteRequestLines).toContain('Remote-only session');
  });

  it('falls back to a generic backend label when no display name is available', () => {
    expect(buildRemoteOnlyTerminalTitle({ backendDisplayName: '  ' })).toBe('this backend remote session');
  });
});
