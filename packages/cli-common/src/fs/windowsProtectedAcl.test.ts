import { describe, expect, it, vi } from 'vitest';

import {
  createWindowsProtectedAclBoundarySync,
  type WindowsProtectedAclCommandRunnerSync,
} from './windowsProtectedAcl';

describe('Windows protected ACL synchronous boundary', () => {
  it('applies and verifies current-user and SYSTEM-only ACLs through one command owner', () => {
    const runCommand = vi.fn<WindowsProtectedAclCommandRunnerSync>((command) => {
      if (command === 'whoami.exe') {
        return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      }
      if (command === 'icacls.exe') {
        return { exitCode: 0, stdout: 'processed', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ownerSid: 'S-1-5-21-123',
          protected: true,
          reparsePoint: false,
          rules: [
            { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
            { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
          ],
        }),
        stderr: '',
      };
    });
    const boundary = createWindowsProtectedAclBoundarySync({ runCommand });

    boundary.applyAndVerify({ path: 'C:\\Users\\user\\private.json', kind: 'file' });

    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      'whoami.exe',
      'icacls.exe',
      'icacls.exe',
      'powershell.exe',
    ]);
    expect(runCommand.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['/setowner', '*S-1-5-21-123']));
    expect(runCommand.mock.calls[2]?.[1]).toEqual(expect.arrayContaining([
      '/inheritancelevel:r',
      '*S-1-5-21-123:F',
      '*S-1-5-18:F',
    ]));
  });

  it('fails closed when verification reports an inherited ACL', () => {
    const boundary = createWindowsProtectedAclBoundarySync({
      runCommand(command) {
        if (command === 'whoami.exe') {
          return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
        }
        if (command === 'icacls.exe') return { exitCode: 0, stdout: '', stderr: '' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ownerSid: 'S-1-5-21-123',
            protected: false,
            reparsePoint: false,
            rules: [],
          }),
          stderr: '',
        };
      },
    });

    expect(() => boundary.applyAndVerify({ path: 'C:\\unsafe.json', kind: 'file' })).toThrow(/inherits ACL/u);
  });
});
