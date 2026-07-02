import { describe, expect, it } from 'vitest';

import {
  looksLikeCodexAppServerFilePath,
  readCodexAppServerOverrideCommand,
  readCodexAppServerProbeTimeoutMs,
} from './availability.js';

describe('Codex app-server execution-run availability policy', () => {
  it('reads override commands in provider precedence order', () => {
    expect(readCodexAppServerOverrideCommand({
      HAPPIER_CODEX_APP_SERVER_BIN: '  /tmp/app-server  ',
      HAPPIER_CODEX_TUI_BIN: '/tmp/tui',
      HAPPY_CODEX_TUI_BIN: '/tmp/legacy-tui',
    })).toBe('/tmp/app-server');

    expect(readCodexAppServerOverrideCommand({
      HAPPIER_CODEX_TUI_BIN: 'codex-tui',
      HAPPY_CODEX_TUI_BIN: '/tmp/legacy-tui',
    })).toBe('codex-tui');
  });

  it('classifies command strings that need direct file checks', () => {
    expect(looksLikeCodexAppServerFilePath('/tmp/codex')).toBe(true);
    expect(looksLikeCodexAppServerFilePath('.bin/codex')).toBe(true);
    expect(looksLikeCodexAppServerFilePath('codex')).toBe(false);
  });

  it('defaults invalid probe timeouts and accepts positive integer overrides', () => {
    expect(readCodexAppServerProbeTimeoutMs({})).toBe(1_500);
    expect(readCodexAppServerProbeTimeoutMs({ HAPPIER_CODEX_APP_SERVER_PROBE_TIMEOUT_MS: '0' })).toBe(1_500);
    expect(readCodexAppServerProbeTimeoutMs({ HAPPIER_CODEX_APP_SERVER_PROBE_TIMEOUT_MS: '2500' })).toBe(2_500);
  });
});
