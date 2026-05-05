import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as promptInputModule from './promptInput';
import { promptConfirmYesNo } from './promptConfirmYesNo';

function queueAnswers(answers: readonly string[]) {
  let i = 0;
  return vi.spyOn(promptInputModule, 'promptInput').mockImplementation(async () => {
    return answers[i++] ?? '';
  });
}

describe('promptConfirmYesNo', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empty input returns the default-yes', async () => {
    queueAnswers(['']);
    expect(await promptConfirmYesNo('do it?', { default: 'yes' })).toBe(true);
  });

  it('empty input returns the default-no', async () => {
    queueAnswers(['']);
    expect(await promptConfirmYesNo('do it?', { default: 'no' })).toBe(false);
  });

  it('y / yes → true', async () => {
    queueAnswers(['y']);
    expect(await promptConfirmYesNo('q?', { default: 'no' })).toBe(true);
    queueAnswers(['YES']);
    expect(await promptConfirmYesNo('q?', { default: 'no' })).toBe(true);
  });

  it('n / no → false', async () => {
    queueAnswers(['n']);
    expect(await promptConfirmYesNo('q?', { default: 'yes' })).toBe(false);
    queueAnswers(['no']);
    expect(await promptConfirmYesNo('q?', { default: 'yes' })).toBe(false);
  });

  it('unrecognised input reprompts and then accepts y', async () => {
    queueAnswers(['maybe', 'idk', 'y']);
    expect(await promptConfirmYesNo('q?', { default: 'no' })).toBe(true);
  });

  it('appends [Y/n] for default yes, [y/N] for default no', async () => {
    const spy = queueAnswers(['']);
    await promptConfirmYesNo('label', { default: 'yes' });
    expect(String(spy.mock.calls[0]?.[0])).toContain('[Y/n]');

    spy.mockReset();
    const spy2 = queueAnswers(['']);
    await promptConfirmYesNo('label', { default: 'no' });
    expect(String(spy2.mock.calls[0]?.[0])).toContain('[y/N]');
  });

  it('falls back to default when all attempts exhausted', async () => {
    queueAnswers(['?', '?', '?']);
    expect(await promptConfirmYesNo('q?', { default: 'yes', maxAttempts: 3 })).toBe(true);
  });
});
