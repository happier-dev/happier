import { describe, expect, it } from 'vitest';

describe('buildActionDraftSeedInput', () => {
  it('seeds backend selection + required selects for review.start', async () => {
    const { buildActionDraftSeedInput, getActionSpec } = await import('./index.js');
    const spec = getActionSpec('review.start');

    const seed = buildActionDraftSeedInput(spec, { defaultBackendId: 'codex', instructions: 'Please review.' });
    expect(seed).toMatchObject({
      engineIds: ['codex'],
      instructions: 'Please review.',
      changeType: 'committed',
      base: { kind: 'none' },
    });
  });

  it('seeds backend selection for plan.start and uses textarea instructions', async () => {
    const { buildActionDraftSeedInput, getActionSpec } = await import('./index.js');
    const spec = getActionSpec('plan.start');

    const seed = buildActionDraftSeedInput(spec, { defaultBackendId: 'claude', instructions: 'Make a plan.' });
    expect(seed).toMatchObject({
      backendIds: ['claude'],
      instructions: 'Make a plan.',
    });
  });
});

