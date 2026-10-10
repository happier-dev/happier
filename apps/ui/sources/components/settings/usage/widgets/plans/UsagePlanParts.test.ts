import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPreferredLanguage,
  preloadTranslationsForSettings,
  setPreferredLanguageFromSettings,
} from '@/text';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

import { formatPlanMoment } from './UsagePlanParts';

const previousLanguage = getPreferredLanguage();
beforeEach(async () => {
  await preloadTranslationsForSettings('en');
  setPreferredLanguageFromSettings('en');
});
afterEach(() => setPreferredLanguageFromSettings(previousLanguage));

const now = new Date(2026, 9, 10, 12).getTime();
const date = (at: number, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(getPreferredLanguage(), options).format(at);

describe('formatPlanMoment', () => {
  it.each([
    ['the same day number in the previous month', new Date(2026, 8, 10, 12).getTime()],
    ['an observation more than a week ago', new Date(2026, 9, 2, 12).getTime()],
    ['a reset more than a week ahead', new Date(2026, 9, 18, 12).getTime()],
  ])('keeps the calendar date for %s', (_case, at) => {
    expect(formatPlanMoment(at, now)).toBe(date(at, { day: 'numeric', month: 'short' }));
  });

  it('keeps the year for a historical observation from another year', () => {
    const at = new Date(2025, 9, 10, 12).getTime();
    expect(formatPlanMoment(at, now)).toBe(date(at, { day: 'numeric', month: 'short', year: 'numeric' }));
  });

  it('keeps clock time for today and weekday plus time for a nearby future reset', () => {
    const today = new Date(2026, 9, 10, 18, 15).getTime();
    const soon = new Date(2026, 9, 12, 18, 15).getTime();
    const clock = { hour: '2-digit', minute: '2-digit' } as const;
    expect(formatPlanMoment(today, now)).toBe(date(today, clock));
    expect(formatPlanMoment(soon, now)).toBe(`${date(soon, { weekday: 'short' })} ${date(soon, clock)}`);
  });

  it('uses the selected app language when the device formatter has another locale', async () => {
    const deviceLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
    const appLanguage = deviceLocale.startsWith('fr') ? 'de' : 'fr';
    await preloadTranslationsForSettings(appLanguage);
    setPreferredLanguageFromSettings(appLanguage);
    const at = new Date(2026, 9, 18, 12).getTime();
    const options = { day: 'numeric', month: 'short' } as const;
    expect(date(at, options)).not.toBe(new Intl.DateTimeFormat(undefined, options).format(at));
    expect(formatPlanMoment(at, now)).toBe(date(at, options));
  });
});
