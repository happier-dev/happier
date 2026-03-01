import { describe, expect, it } from 'vitest';

import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol';

import { runReplaySummaryForDialog, type ReplaySummaryTextPromptRunner } from './runReplaySummaryForDialog';

describe('runReplaySummaryForDialog', () => {
  it('uses the configured runner and includes dialog messages in the summarizer prompt', async () => {
    const calls: Array<{ backendId: string; modelId?: string; permissionMode?: string; prompt: string }> = [];

    const runner: LlmTaskRunnerConfigV1 = { v: 1, backendId: 'claude', modelId: 'default', permissionMode: 'no_tools' };
    const out = await runReplaySummaryForDialog({
      cwd: '/repo',
      parentSessionId: 'sess_parent',
      runner,
      dialog: [
        { role: 'User', createdAt: 1, text: 'hello' },
        { role: 'Assistant', createdAt: 2, text: 'world' },
      ],
      deps: {
        runTextPrompt: (async (args) => {
          calls.push({ backendId: args.backendId, modelId: args.modelId, permissionMode: args.permissionMode, prompt: args.prompt });
          return 'SUMMARY_OK';
        }) satisfies ReplaySummaryTextPromptRunner,
      },
    });

    expect(out).toBe('SUMMARY_OK');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.backendId).toBe('claude');
    expect(calls[0]?.modelId).toBe('default');
    expect(calls[0]?.permissionMode).toBe('no_tools');
    expect(String(calls[0]?.prompt ?? '')).toContain('User: hello');
    expect(String(calls[0]?.prompt ?? '')).toContain('Assistant: world');
    expect(String(calls[0]?.prompt ?? '')).toContain('## Goal');
    expect(String(calls[0]?.prompt ?? '')).toContain('## Relevant files / directories');
  });
});
