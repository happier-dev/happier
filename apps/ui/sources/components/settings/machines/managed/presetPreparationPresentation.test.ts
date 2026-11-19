import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

const { describePreparedImageBuilt, describePresetImage, isMachineImageOlderThanPreset, projectPresetPreparationSteps } =
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

describe('the prepared image in one word (preset page, Presets table, Sandboxes table)', () => {
  type Preset = Parameters<typeof describePresetImage>[0];
  const preset = (fields: Partial<Preset>): Preset => ({ id: 'p1', ...fields }) as Preset;
  const ready = { status: 'ready' } as NonNullable<Preset['prepared']>;
  const built = { builtAt: null, builtFromRevision: 7, storageBytes: null };

  it('speaks only when the image needs the person, with the next step it offers', () => {
    const cases = [
      describePresetImage(preset({}), null),
      describePresetImage(preset({ preparation: { enabled: false } }), null),
      describePresetImage(preset({ preparation: { enabled: true } }), null),
      describePresetImage(preset({ preparation: { enabled: true }, prepared: { status: 'building' } as Preset['prepared'] }), null),
      describePresetImage(preset({ preparation: { enabled: true }, prepared: ready }), { ...built, stale: false }),
      describePresetImage(preset({ preparation: { enabled: true }, prepared: ready }), { ...built, stale: true }),
      describePresetImage(preset({ preparation: { enabled: true }, prepared: { status: 'failed' } as Preset['prepared'] }), null),
      describePresetImage(preset({ preparation: { enabled: true }, prepared: { status: 'cancelled' } as Preset['prepared'] }), null),
    ];
    expect(cases.map((image) => [image.kind, image.tone, image.next])).toEqual([
      ['none', 'quiet', null],
      ['off', 'quiet', null],
      ['notBuilt', 'quiet', 'build'],
      ['building', 'running', null],
      ['ready', 'quiet', null],
      ['stale', 'warning', 'rebuild'],
      ['failed', 'danger', 'retry'],
      // A build the person stopped reads as not built yet, quietly (its Build is in the row's "…").
      ['notBuilt', 'quiet', 'build'],
    ]);
  });

  it('keeps when it was built under a ready or out-of-date image', () => {
    const stale = describePresetImage(preset({ preparation: { enabled: true }, prepared: ready }), { ...built, stale: true });
    expect(stale.word).toBe('machinePresets.prepareStale');
    expect(stale.line).toBe(describePreparedImageBuilt({ ...built }));
  });

  it('an image kept from before says Off once its switch is turned off', () => {
    expect(describePresetImage(preset({ preparation: { enabled: false }, prepared: ready }), { ...built, stale: false }).kind).toBe('off');
  });
});

describe('a Machine made from a preset whose image was rebuilt since', () => {
  const summary = (builtFromRevision: number | null) => ({ builtAt: null, builtFromRevision, storageBytes: null, stale: false });
  it('flags only an image older than the one the preset keeps now', () => {
    expect(isMachineImageOlderThanPreset(3, summary(5))).toBe(true);
    expect(isMachineImageOlderThanPreset(5, summary(5))).toBe(false);
    // Started cold, or the preset keeps no ready image: nothing to compare.
    expect(isMachineImageOlderThanPreset(undefined, summary(5))).toBe(false);
    expect(isMachineImageOlderThanPreset(3, null)).toBe(false);
    expect(isMachineImageOlderThanPreset(3, summary(null))).toBe(false);
  });
});
