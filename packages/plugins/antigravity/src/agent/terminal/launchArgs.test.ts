import { describe, expect, it } from 'vitest';

import {
  ANTIGRAVITY_PRINT_MODE_SUPPORTED,
  buildAntigravityTerminalLaunchArgs,
  resolveAntigravityTerminalLaunchArgsInput,
} from './launchArgs.js';

describe('Antigravity terminal launch arguments', () => {
  it('builds only documented interactive TUI flags', () => {
    expect(buildAntigravityTerminalLaunchArgs({
      promptInteractive: true,
      conversationId: 'conv-123',
      continueLatest: true,
      sandbox: true,
      logFile: '/tmp/agy.log',
      modelId: 'Gemini 3.5 Flash (High)',
    })).toEqual([
      '--prompt-interactive',
      '--conversation',
      'conv-123',
      '--continue',
      '--sandbox',
      '--log-file',
      '/tmp/agy.log',
      '--model',
      'Gemini 3.5 Flash (High)',
    ]);
  });

  it('omits the model flag when the selected model is blank or the default sentinel', () => {
    expect(buildAntigravityTerminalLaunchArgs({
      modelId: '   ',
    })).toEqual([]);
    expect(buildAntigravityTerminalLaunchArgs({
      modelId: 'default',
    })).toEqual([]);
  });

  it('uses the canonical provider session identity for terminal continuation', () => {
    expect(resolveAntigravityTerminalLaunchArgsInput({
      providerSessionId: 'conversation-current',
      terminalRuntime: { conversationId: 'conversation-stale' },
      antigravity: { conversationId: 'conversation-older' },
    })).toMatchObject({
      conversationId: 'conversation-current',
    });
  });

  it('keeps print mode and unsafe permission skipping out of terminal v1', () => {
    expect(ANTIGRAVITY_PRINT_MODE_SUPPORTED).toBe(false);
    expect(() => buildAntigravityTerminalLaunchArgs({
      unsafeSkipPermissions: true,
    })).toThrow(/unsafe permission/i);
    expect(() => buildAntigravityTerminalLaunchArgs({
      print: true,
    })).toThrow(/print mode/i);
  });
});
