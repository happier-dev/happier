import { describe, expect, it } from 'vitest';

import { buildAntigravityCliPrintLaunchArgs } from './launchArgs.js';

describe('Antigravity cliPrint launch args', () => {
  it('builds print-mode args with the prompt bound to -p before flags', () => {
    const args = buildAntigravityCliPrintLaunchArgs({
      cwd: '/repo/app',
      prompt: 'summarize this workspace',
      modelId: 'Gemini 3.5 Flash (Medium)',
      sandbox: true,
      conversationId: 'conversation-123',
      includeWorkspaceScope: true,
    });

    expect(args).toEqual([
      '-p',
      'summarize this workspace',
      '--model',
      'Gemini 3.5 Flash (Medium)',
      '--sandbox',
      '--conversation',
      'conversation-123',
      '--add-dir',
      '/repo/app',
    ]);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('omits optional mode args when they are absent or set to default', () => {
    expect(buildAntigravityCliPrintLaunchArgs({
      cwd: '/repo/app',
      prompt: 'hello',
      modelId: 'default',
      sandbox: false,
      conversationId: '   ',
      includeWorkspaceScope: false,
    })).toEqual(['-p', 'hello']);
  });
});
