import { describe, expect, it } from 'vitest';

import { applySettings, settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { voiceSettingsDefaults, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

import { createVoiceQaTemporarySettingsScopeCoordinator } from './voiceQaTemporarySettingsScope';

function createSettingsHarness(initial: Settings) {
  let settings = initial;
  let failNextApply = false;
  return {
    readSettings: () => settings,
    applySettingsLocal: (delta: Partial<Settings>) => {
      if (failNextApply) {
        failNextApply = false;
        settings = applySettings(settings, delta);
        throw new Error('settings_apply_failed');
      }
      settings = applySettings(settings, delta);
    },
    failNextApply: () => {
      failNextApply = true;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createVoiceSettings(marker: string) {
  return voiceSettingsParse({
    ...voiceSettingsDefaults,
    assistantLanguage: marker,
  });
}

function createBaselineSettings(): Settings {
  return applySettings(settingsDefaults, {
    experiments: false,
    featureToggles: { voice: false, unrelated: true },
    voice: createVoiceSettings('baseline'),
  });
}

describe('voice QA temporary settings scope', () => {
  it('restores the exact prior settings after successful and failed serial actions', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);

    await expect(coordinator.run({
      ownerId: 'screen-a',
      delta: {
        experiments: true,
        featureToggles: { voice: true },
        voice: createVoiceSettings('first'),
      },
    }, async () => {
      expect(harness.readSettings()).toMatchObject({
        experiments: true,
        featureToggles: { voice: true },
        voice: expect.objectContaining({ assistantLanguage: 'first' }),
      });
      return 'ok';
    })).resolves.toBe('ok');
    expect(harness.readSettings()).toMatchObject(baseline);

    await expect(coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('second') },
    }, async () => {
      throw new Error('transcription_failed');
    })).rejects.toThrow('transcription_failed');
    expect(harness.readSettings()).toMatchObject(baseline);
  });

  it('keeps overlapping actions isolated and restores the previous active override in stack order', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);
    const first = deferred<string>();
    const second = deferred<string>();

    const firstRun = coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('first') },
    }, () => first.promise);
    expect(harness.readSettings().voice.assistantLanguage).toBe('first');

    const secondRun = coordinator.run({
      ownerId: 'screen-b',
      delta: { experiments: true, voice: createVoiceSettings('second') },
    }, () => second.promise);
    expect(harness.readSettings().voice.assistantLanguage).toBe('second');

    second.resolve('second');
    await expect(secondRun).resolves.toBe('second');
    expect(harness.readSettings().voice.assistantLanguage).toBe('first');

    first.resolve('first');
    await expect(firstRun).resolves.toBe('first');
    expect(harness.readSettings()).toMatchObject(baseline);
  });

  it('restores immediately on cancellation or owner teardown and keeps later cleanup idempotent', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);
    const action = deferred<string>();
    const abortController = new AbortController();

    const run = coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('temporary') },
      signal: abortController.signal,
    }, () => action.promise);
    expect(harness.readSettings().voice.assistantLanguage).toBe('temporary');

    abortController.abort();
    coordinator.releaseOwner('screen-a');
    expect(harness.readSettings()).toMatchObject(baseline);

    action.resolve('done');
    await expect(run).resolves.toBe('done');
    expect(harness.readSettings()).toMatchObject(baseline);
  });

  it('rolls back a partial setup when applying the temporary override throws', async () => {
    const baseline = createBaselineSettings();
    const harness = createSettingsHarness(baseline);
    const coordinator = createVoiceQaTemporarySettingsScopeCoordinator(harness);
    harness.failNextApply();

    await expect(coordinator.run({
      ownerId: 'screen-a',
      delta: { experiments: true, voice: createVoiceSettings('temporary') },
    }, async () => 'unreachable')).rejects.toThrow('settings_apply_failed');
    expect(harness.readSettings()).toMatchObject(baseline);
  });
});
