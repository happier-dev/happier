import { describe, expect, it } from 'vitest';

import { isTmuxAllowedCommand, listRootHelpCommands } from './commandSurfaceManifest';

describe('CLI command-surface manifest', () => {
  it('exposes the current root help command list from one manifest', () => {
    const entries = listRootHelpCommands();
    expect(entries.map((entry) => entry.command)).toEqual([
      null,
      'setup',
      'auth',
      'mcp',
      'codex',
      'opencode',
      'gemini',
      'connect',
      'providers',
      'plugins',
      'notify',
      'install',
      'service',
      'doctor',
      'uninstall',
    ]);

    for (const entry of entries) {
      expect(entry.rootHelpLabel).toBeTypeOf('string');
      expect(entry.rootHelpLabel).toMatch(/^happier\b/u);
    }
  });

  it('keeps tmux disallow decisions aligned with the command manifest', () => {
    expect(isTmuxAllowedCommand('codex')).toBe(true);
    expect(isTmuxAllowedCommand('resume')).toBe(true);
    expect(isTmuxAllowedCommand('service')).toBe(false);
    expect(isTmuxAllowedCommand('daemon')).toBe(false);
    expect(isTmuxAllowedCommand('session')).toBe(false);
    expect(isTmuxAllowedCommand('install')).toBe(false);
  });
});
