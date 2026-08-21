import { describe, expect, it } from 'vitest';

import { isTmuxAllowedCommand, listRootHelpCommands } from './commandSurfaceManifest';
import { buildRootHelpText } from './buildRootHelpText';

describe('CLI command-surface manifest', () => {
  it('exposes the current root help command list from one manifest', () => {
    const entries = listRootHelpCommands();
    expect(entries.map((entry) => entry.command)).toEqual([
      null,
      'setup',
      'auth',
      'automation',
      'mcp',
      'codex',
      'opencode',
      'gemini',
      'connect',
      'notify',
      'install',
      'status',
      'service',
      'daemon',
      'doctor',
      'session',
      'resume',
    ]);

    for (const entry of entries) {
      expect(entry.rootHelpLabel).toBeTypeOf('string');
      expect(entry.rootHelpLabel).toMatch(/^happier\b/u);
    }
  });

  it('keeps tmux disallow decisions aligned with the command manifest', () => {
    expect(isTmuxAllowedCommand('codex')).toBe(true);
    expect(isTmuxAllowedCommand('resume')).toBe(true);
    expect(isTmuxAllowedCommand('daemon')).toBe(false);
    expect(isTmuxAllowedCommand('service')).toBe(false);
    expect(isTmuxAllowedCommand('status')).toBe(false);
    expect(isTmuxAllowedCommand('session')).toBe(false);
    expect(isTmuxAllowedCommand('sessions')).toBe(false);
    expect(isTmuxAllowedCommand('automation')).toBe(false);
    expect(isTmuxAllowedCommand('install')).toBe(false);
  });

  // The installers gate every post-install `happier <command>` invocation on the
  // CLI's own root help (scripts/release/installers/install.sh
  // `installed_cli_supports_command_surface`, install.ps1
  // `Test-InstalledCliSupportsCommandSurface`). If `setup` ever stops being
  // listed there, `install --run setup` and the guided first-run handoff both
  // refuse to run, so pin the exact shape those installers look for.
  it('lists the command surfaces the installers gate their post-install handoff on', () => {
    const help = buildRootHelpText();
    const installerGate = (subcommand: string): RegExp =>
      new RegExp(String.raw`^\s*(happier\.exe|happier)\s+${subcommand}\b`, 'mu');

    expect(help).toMatch(installerGate('setup'));
    expect(help).toMatch(installerGate('auth'));
    // A surface the CLI does not advertise must not satisfy the gate, or the
    // check would pass for anything.
    expect(help).not.toMatch(installerGate('definitely-not-a-command'));
  });
});
