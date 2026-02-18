import { describe, expect, it } from 'vitest';

import {
  chooseWindowsClaudePathFromPathAndNative,
  buildClaudeBinarySpawnInvocation,
} from '../scripts/claude_version_utils.cjs';

describe('claude_version_utils (win32 reliability helpers)', () => {
  describe('chooseWindowsClaudePathFromPathAndNative', () => {
    it('prefers the native installer .exe when PATH resolves to a .cmd shim', () => {
      const selected = chooseWindowsClaudePathFromPathAndNative(
        { path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', source: 'npm' },
        'C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe',
      );
      expect(selected).toBe('C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe');
    });

    it('prefers the native installer .exe when PATH resolves to a WindowsApps alias', () => {
      const selected = chooseWindowsClaudePathFromPathAndNative(
        { path: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe', source: 'PATH' },
        'C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe',
      );
      expect(selected).toBe('C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe');
    });

    it('keeps the PATH .exe when it is already a native binary path', () => {
      const selected = chooseWindowsClaudePathFromPathAndNative(
        { path: 'C:\\Program Files\\Claude\\claude.exe', source: 'native installer' },
        'C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe',
      );
      expect(selected).toBe('C:\\Program Files\\Claude\\claude.exe');
    });

    it('falls back to PATH when no native installer is detectable', () => {
      const selected = chooseWindowsClaudePathFromPathAndNative(
        { path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', source: 'npm' },
        null,
      );
      expect(selected).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
    });
  });

  describe('buildClaudeBinarySpawnInvocation', () => {
    it('wraps Windows .cmd shims in cmd.exe so they can be executed reliably', () => {
      const inv = buildClaudeBinarySpawnInvocation({
        cliPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
        args: ['--version'],
        platform: 'win32',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
      });

      expect(inv.command).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(inv.args.slice(3)).toEqual(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', '--version']);
    });

    it('spawns .exe directly on Windows by default', () => {
      const inv = buildClaudeBinarySpawnInvocation({
        cliPath: 'C:\\Users\\me\\.local\\bin\\claude.exe',
        args: ['--version'],
        platform: 'win32',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
      });

      expect(inv.command).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
      expect(inv.args).toEqual(['--version']);
    });

    it('can force wrapping a Windows .exe via cmd.exe using HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC', () => {
      const original = process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC;
      process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC = '1';
      try {
        const inv = buildClaudeBinarySpawnInvocation({
          cliPath: 'C:\\Users\\me\\.local\\bin\\claude.exe',
          args: ['--version'],
          platform: 'win32',
          comspec: 'C:\\Windows\\System32\\cmd.exe',
        });

        expect(inv.command).toBe('C:\\Windows\\System32\\cmd.exe');
        expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
        expect(inv.args.slice(3)).toEqual(['C:\\Users\\me\\.local\\bin\\claude.exe', '--version']);
      } finally {
        if (original === undefined) delete process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC;
        else process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC = original;
      }
    });

    it('spawns the binary directly on non-Windows platforms', () => {
      const inv = buildClaudeBinarySpawnInvocation({
        cliPath: '/usr/local/bin/claude',
        args: ['--version'],
        platform: 'linux',
        comspec: null,
      });

      expect(inv.command).toBe('/usr/local/bin/claude');
      expect(inv.args).toEqual(['--version']);
    });
  });
});
