import { describe, expect, it } from 'vitest';

import { buildClaudeStartOptionsFromParsedArgs } from './command';
import { partitionClaudeSessionArgs } from './partitionClaudeSessionArgs';
import { buildHappySessionControlArgs } from '@/daemon/sessionSpawnArgs';

describe('buildClaudeStartOptionsFromParsedArgs', () => {
  it('threads --agent-mode plan into StartOptions so a plan-created session spawns Claude in plan mode (incident cmq9hemcs)', () => {
    const parsed = partitionClaudeSessionArgs([
      '--happy-starting-mode', 'remote',
      '--started-by', 'daemon',
      '--permission-mode', 'safe-yolo',
      '--permission-mode-updated-at', '1781181377912',
      '--agent-mode', 'plan',
      '--agent-mode-updated-at', '1781181377912',
      '--model', 'claude-haiku-4-5',
      '--model-updated-at', '1781181377912',
    ]);

    const options = buildClaudeStartOptionsFromParsedArgs(parsed, undefined);

    expect(options.agentModeId).toBe('plan');
    expect(options.agentModeUpdatedAt).toBe(1781181377912);
    expect(options.permissionMode).toBe('safe-yolo');
    expect(options.permissionModeUpdatedAt).toBe(1781181377912);
    expect(options.modelId).toBe('claude-haiku-4-5');
    expect(options.startedBy).toBe('daemon');
  });

  it('omits agent-mode fields when --agent-mode is not provided', () => {
    const parsed = partitionClaudeSessionArgs(['--permission-mode', 'yolo']);

    const options = buildClaudeStartOptionsFromParsedArgs(parsed, undefined);

    expect('agentModeId' in options).toBe(false);
    expect('agentModeUpdatedAt' in options).toBe(false);
  });

  it('seeds the session model from --model without pinning it as a Claude provider arg', () => {
    // A `--model` copied into claudeArgs is read by every Claude runtime as a fixed override,
    // so later model changes from the app were silently ignored for the rest of the session.
    const parsed = partitionClaudeSessionArgs([
      '--happy-starting-mode', 'remote',
      '--started-by', 'daemon',
      ...buildHappySessionControlArgs({ modelId: 'claude-model-a', modelUpdatedAt: 1781181377912 }),
    ]);

    const options = buildClaudeStartOptionsFromParsedArgs(parsed, undefined);

    expect(options.modelId).toBe('claude-model-a');
    expect(options.modelUpdatedAt).toBe(1781181377912);
    expect(parsed.providerArgs).not.toContain('--model');
    expect(parsed.providerArgs).not.toContain('claude-model-a');
  });

  it('does not pin a terminal-typed --model either', () => {
    const parsed = partitionClaudeSessionArgs(['--model', 'claude-model-a', '--verbose']);

    expect(parsed.modelId).toBe('claude-model-a');
    expect(parsed.providerArgs).toEqual(['--verbose']);
  });
});
