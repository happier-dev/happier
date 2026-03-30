import { describe, expect, it } from 'vitest';

import { readDaemonTerminalPtyConfig } from './terminalPtyConfig';

describe('readDaemonTerminalPtyConfig', () => {
  it('defaults enabled to true', () => {
    expect(readDaemonTerminalPtyConfig({}).enabled).toBe(true);
  });

  it('treats invalid truthy strings as fallback (enabled remains true by default)', () => {
    expect(readDaemonTerminalPtyConfig({ HAPPIER_DAEMON_TERMINAL_ENABLED: 'nope' }).enabled).toBe(true);
  });

  it('accepts short tokens like y/n', () => {
    expect(readDaemonTerminalPtyConfig({ HAPPIER_DAEMON_TERMINAL_ENABLED: 'y' }).enabled).toBe(true);
    expect(readDaemonTerminalPtyConfig({ HAPPIER_DAEMON_TERMINAL_ENABLED: 'n' }).enabled).toBe(false);
  });
});
