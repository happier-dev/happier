import { describe, expect, it } from 'vitest';

import { buildCopilotAcpArgv } from './callbacks.js';

describe('Copilot ACP callbacks', () => {
  it.each([
    { mode: 'default', expected: ['--acp'] },
    { mode: 'safe-yolo', expected: ['--acp'] },
    { mode: 'yolo', expected: ['--acp', '--yolo'] },
    { mode: 'bypassPermissions', expected: ['--acp', '--yolo'] },
  ])('maps permissionMode="$mode" to Copilot ACP argv', ({ mode, expected }) => {
    expect(buildCopilotAcpArgv({
      baseArgs: ['--acp'],
      cwd: '/workspace',
      permissionMode: mode,
    })).toEqual(expected);
  });
});
