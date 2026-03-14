import { describe, expect, it } from 'vitest';
import { buildActionDraftSeedInput, getActionSpec } from './index.js';

describe('buildActionDraftSeedInput', () => {
  it('requires explicit engine selection for review.start drafts', () => {
    const spec = getActionSpec('review.start');

    const seed = buildActionDraftSeedInput(spec, {
      defaultBackendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      defaultBackendId: 'codex',
      instructions: 'Please review.',
    });
    expect(seed).toMatchObject({
      instructions: 'Please review.',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    });
    expect(seed).not.toHaveProperty('engineIds');
  });

  it('seeds backend selection for subagents.plan.start and uses textarea instructions', () => {
    const spec = getActionSpec('subagents.plan.start');

    const seed = buildActionDraftSeedInput(spec, {
      defaultBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      defaultBackendId: 'claude',
      instructions: 'Make a plan.',
    });
    expect(seed).toMatchObject({
      backendTargetKeys: ['agent:claude'],
      instructions: 'Make a plan.',
    });
  });

  it('preserves configured ACP backend targets for backendTargetKeys fields', () => {
    const spec = getActionSpec('subagents.plan.start');

    const seed = buildActionDraftSeedInput(spec, {
      defaultBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      instructions: 'Make a plan.',
    });
    expect(seed).toMatchObject({
      backendTargetKeys: ['acpBackend:review-bot'],
      instructions: 'Make a plan.',
    });
  });
});
