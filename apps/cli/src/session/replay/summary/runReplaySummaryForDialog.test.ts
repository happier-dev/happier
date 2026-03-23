import { describe, expect, it } from 'vitest';

import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol';

import { runReplaySummaryForDialog, type ReplaySummaryTextPromptRunner } from './runReplaySummaryForDialog';

describe('runReplaySummaryForDialog', () => {
  it('uses the configured runner and includes dialog messages in the summarizer prompt', async () => {
    const calls: Array<{ backendTarget: unknown; modelId?: string; permissionMode?: string; prompt: string }> = [];

    const runner: LlmTaskRunnerConfigV1 = {
      v: 1,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelId: 'default',
      permissionMode: 'no_tools',
    } as any;
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
          calls.push({
            backendTarget: (args as any).backendTarget,
            modelId: args.modelId,
            permissionMode: args.permissionMode,
            prompt: args.prompt,
          });
          return 'SUMMARY_OK';
        }) satisfies ReplaySummaryTextPromptRunner,
      },
    });

    expect(out).toBe('SUMMARY_OK');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    expect(calls[0]?.modelId).toBe('default');
    expect(calls[0]?.permissionMode).toBe('no_tools');
    expect(String(calls[0]?.prompt ?? '')).toContain('User: hello');
    expect(String(calls[0]?.prompt ?? '')).toContain('Assistant: world');
    expect(String(calls[0]?.prompt ?? '')).toContain('## Goal');
    expect(String(calls[0]?.prompt ?? '')).toContain('## Relevant files / directories');
    expect(String(calls[0]?.prompt ?? '')).toContain('Preserve exact identifiers, codes, names, numbers, paths, and user constraints when they matter.');
  });

  it('passes configured ACP backend targets through to the text-prompt runner', async () => {
    const calls: Array<{ backendTarget: unknown }> = [];

    const runner: LlmTaskRunnerConfigV1 = {
      v: 1,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      modelId: 'review-model',
      permissionMode: 'no_tools',
    } as any;

    const out = await runReplaySummaryForDialog({
      cwd: '/repo',
      parentSessionId: 'sess_parent',
      runner,
      dialog: [{ role: 'User', createdAt: 1, text: 'hello' }],
      deps: {
        runTextPrompt: (async (args) => {
          calls.push({ backendTarget: (args as any).backendTarget });
          return 'SUMMARY_OK';
        }) satisfies ReplaySummaryTextPromptRunner,
      },
    });

    expect(out).toBe('SUMMARY_OK');
    expect(calls).toEqual([{ backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' } }]);
  });
});
