import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getPreferredLanguage,
  preloadTranslationsForSettings,
  setPreferredLanguageFromSettings,
} from '@/text';

import { formatMoment } from './formatMoment';

const previousLanguage = getPreferredLanguage();
beforeEach(async () => {
  await preloadTranslationsForSettings('en');
  setPreferredLanguageFromSettings('en');
});
afterEach(() => setPreferredLanguageFromSettings(previousLanguage));

const now = new Date(2026, 9, 10, 12).getTime();
const date = (at: number, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(getPreferredLanguage(), options).format(at);

describe('formatMoment', () => {
  it.each([
    ['the same day number in the previous month', new Date(2026, 8, 10, 12).getTime()],
    ['an observation more than a week ago', new Date(2026, 9, 2, 12).getTime()],
    ['a reset more than a week ahead', new Date(2026, 9, 18, 12).getTime()],
  ])('keeps the calendar date for %s', (_case, at) => {
    expect(formatMoment(at, now)).toBe(date(at, { day: 'numeric', month: 'short' }));
  });

  it('keeps the year for a historical observation from another year', () => {
    const at = new Date(2025, 9, 10, 12).getTime();
    expect(formatMoment(at, now)).toBe(date(at, { day: 'numeric', month: 'short', year: 'numeric' }));
  });

  it('keeps clock time for today and weekday plus time for a nearby future reset', () => {
    const today = new Date(2026, 9, 10, 18, 15).getTime();
    const soon = new Date(2026, 9, 12, 18, 15).getTime();
    const clock = { timeStyle: 'short' } as const;
    expect(formatMoment(today, now)).toBe(date(today, clock));
    expect(formatMoment(soon, now)).toBe(`${date(soon, { weekday: 'short' })} ${date(soon, clock)}`);
  });

  it('says a morning clock time the way the language does, without a padded hour', () => {
    const morning = new Date(2026, 9, 10, 7, 27).getTime();
    expect(formatMoment(morning, now)).toMatch(/^7:27/);
  });

  it('uses the selected app language when the device formatter has another locale', async () => {
    const deviceLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
    const appLanguage = deviceLocale.startsWith('fr') ? 'de' : 'fr';
    await preloadTranslationsForSettings(appLanguage);
    setPreferredLanguageFromSettings(appLanguage);
    const at = new Date(2026, 9, 18, 12).getTime();
    const options = { day: 'numeric', month: 'short' } as const;
    expect(date(at, options)).not.toBe(new Intl.DateTimeFormat(undefined, options).format(at));
    expect(formatMoment(at, now)).toBe(date(at, options));
  });
});
