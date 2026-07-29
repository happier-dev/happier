import { describe, expect, it } from 'vitest';

import { buildQwenAcpArgv } from './approvalMode.js';

describe('Qwen ACP approval mode argv', () => {
  it.each([
    { intent: 'default', expected: ['--acp'] },
    { intent: 'read-only', expected: ['--acp', '--approval-mode', 'plan'] },
    { intent: 'safe-yolo', expected: ['--acp', '--approval-mode', 'auto-edit'] },
    { intent: 'yolo', expected: ['--acp', '--approval-mode', 'yolo'] },
    { intent: 'plan', expected: ['--acp', '--approval-mode', 'plan'] },
  ] as const)('maps canonical permission intent "$intent" to Qwen argv', ({ intent, expected }) => {
    expect(buildQwenAcpArgv({ baseArgs: ['--acp'], permissionIntent: intent })).toEqual(expected);
  });
});
