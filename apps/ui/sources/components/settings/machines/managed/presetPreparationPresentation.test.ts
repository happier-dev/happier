import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

const { describePreparedImageBuilt, projectPresetPreparationSteps } =
  await import('./presetPreparationPresentation');

describe('Prepare ahead phases and ready image', () => {
  it('lists the owner-named steps in order, with a time only for the ones that finished', () => {
    const steps = projectPresetPreparationSteps([
      {
        id: 'prepare-inputs',
        label: 'Prepare build inputs',
        state: 'succeeded',
        startedAt: 1_000,
        settledAt: 19_000,
      },
      {
        id: 'build-image',
        label: 'Build image',
        state: 'running',
        startedAt: 19_000,
      },
      { id: 'save-image', label: 'Save prepared image', state: 'pending' },
    ]);
    expect(steps.map((step) => [step.key, step.state, step.title])).toEqual([
      ['prepare-inputs', 'done', 'Prepare build inputs'],
      ['build-image', 'running', 'Build image'],
      ['save-image', 'upcoming', 'Save prepared image'],
    ]);
    expect(steps[0]!.meta).toBeTruthy();
    expect(steps[1]!.meta).toBeUndefined();
    expect(steps[2]!.meta).toBeUndefined();
  });

  it('says when and from which revision the image was built, and leaves out what is unknown', () => {
    expect(
      describePreparedImageBuilt({
        builtAt: 1_700_000_000_000,
        builtFromRevision: 7,
      }),
    ).toContain('machinePresets.prepareBuiltFrom');
    expect(
      describePreparedImageBuilt({
        builtAt: 1_700_000_000_000,
        builtFromRevision: null,
      }),
    ).toContain('machinePresets.prepareBuiltAt');
    expect(
      describePreparedImageBuilt({ builtAt: null, builtFromRevision: null }),
    ).toBeNull();
    expect(describePreparedImageBuilt(null)).toBeNull();
  });
});
