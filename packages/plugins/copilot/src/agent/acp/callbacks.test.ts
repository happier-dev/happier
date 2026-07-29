import { describe, expect, it } from 'vitest';

import { buildCopilotAcpArgv } from './callbacks.js';

describe('Copilot ACP callbacks', () => {
  it.each([
    { mode: 'default', expected: ['--acp'] },
    { mode: 'read-only', expected: ['--acp'] },
    { mode: 'safe-yolo', expected: ['--acp'] },
    { mode: 'plan', expected: ['--acp'] },
    { mode: 'yolo', expected: ['--acp', '--yolo'] },
  ] as const)('maps canonical permission intent "$mode" to Copilot ACP argv', ({ mode, expected }) => {
    expect(buildCopilotAcpArgv({
      baseArgs: ['--acp'],
      permissionIntent: mode,
    })).toEqual(expected);
  });
});
