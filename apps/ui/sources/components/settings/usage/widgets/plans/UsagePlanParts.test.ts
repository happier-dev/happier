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

import { planAccountStatesMode, readPlanAccountsStatement, planWindowStatement } from './UsagePlanParts';
import type { UsagePlanAccount, UsagePlanWindow } from './usagePlansModel';

const previousLanguage = getPreferredLanguage();
beforeEach(async () => {
  await preloadTranslationsForSettings('en');
  setPreferredLanguageFromSettings('en');
});
afterEach(() => setPreferredLanguageFromSettings(previousLanguage));

const now = new Date(2026, 9, 10, 12).getTime();
const date = (at: number, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(getPreferredLanguage(), options).format(at);

describe('exhausted-window presentation', () => {
  it('gives observed exhaustion priority over a depletion projection, preserving future and unknown cases', () => {
    const window: UsagePlanWindow = { key: 'weekly', meterId: 'weekly', label: 'Weekly', remainingFraction: 0,
      resetAtMs: now + 3600000, windowDurationMs: 7200000, tone: 'danger', estimated: false, comparable: true,
      paceUnavailable: null, pace: { evenPaceRemainingFraction: 0.5, projectedRemainingFraction: 0,
        projectedUsedFraction: 1.2, depletesAtMs: now, observedCurve: [], qualification: 'confirmed',
        sampleCount: 2, empiricalRange: null, windowStartAtMs: now - 3600000 } };
    expect(planWindowStatement(window, now)).toMatchObject({ kind: 'used_up', tone: 'warning' });
    expect(planWindowStatement({ ...window, pace: null }, now)).toMatchObject({ kind: 'used_up' });
    expect(planWindowStatement({ ...window, remainingFraction: 0.1 }, now)).toMatchObject({ kind: 'depletes' });
    expect(planWindowStatement({ ...window, remainingFraction: null, pace: null }, now)).toMatchObject({ kind: 'unavailable' });
  });
});

describe('readPlanAccountsStatement', () => {
  const account = (id: string, status: UsagePlanAccount['state']['status'], current: boolean, asOfMs?: number) =>
    ({ key: id, accountId: id, state: { source: 'quota', status, ...(asOfMs ? { asOfMs } : {}) },
      read: current ? { current: {} } : null, observedAtMs: current ? now : null }) as unknown as UsagePlanAccount;
  const nameOf = (entry: UsagePlanAccount) => ({ title: entry.accountId, qualifier: null }) as never;

  it('states one shared partial read once, for every account, with the oldest time', () => {
    const statement = readPlanAccountsStatement([
      account('a', 'stale', true, now - 2000), account('b', 'stale', true, now - 1000), account('c', 'partial', false),
    ], nameOf);
    expect(statement).toMatchObject({ kind: 'partial', asOf: now - 2000, accounts: 3 });
    expect(statement?.reason).not.toMatch(/\ba\b.*\bb\b/);
    // One quiet clause ("Partial history"), never a paragraph of sources.
    expect(statement?.reason).toBe('Partial history');
  });

  it('names only the affected accounts and lets a failure lead', () => {
    const statement = readPlanAccountsStatement([
      account('fresh', 'available', true), account('lost', 'error', true), account('slow', 'pending', false),
    ], nameOf);
    expect(statement).toMatchObject({ kind: 'failed', accounts: 2 });
    expect(statement?.reason).toContain('lost, slow');
    expect(statement?.reason).not.toContain('fresh');
  });

  it('says nothing when every account read is current', () => {
    expect(readPlanAccountsStatement([account('a', 'available', true), account('b', 'partial', true)], nameOf)).toBeNull();
  });

  it('counts outstanding accounts, clears settled reads and never calls an unissued read pending', () => {
    const accounts = [account('a', 'pending', true), account('b', 'pending', true), account('c', 'available', true)];
    expect(readPlanAccountsStatement(accounts, nameOf)).toMatchObject({ kind: 'pending', accounts: 2 });
    expect(readPlanAccountsStatement(accounts, nameOf)?.reason).toContain('2 accounts');
    expect(readPlanAccountsStatement(accounts.map(entry => ({ ...entry, state: { ...entry.state, status: 'available' } })), nameOf)).toBeNull();
    expect(readPlanAccountsStatement([account('unissued', 'not_loaded', false)], nameOf)?.kind).toBe('partial');
  });

  it('keeps first-read coverage pending when an unanswered account follows an unobserved answer', () => {
    const accounts = [account('observed', 'available', true), account('unobserved', 'partial', false), account('reading', 'pending', false)];
    expect(readPlanAccountsStatement(accounts, nameOf)).toMatchObject({ kind: 'pending' });
    expect(readPlanAccountsStatement(accounts, nameOf)?.reason).toContain('1 account');
    expect(readPlanAccountsStatement(accounts.slice(0, 2), nameOf)?.kind).toBe('partial');
  });
});

describe('planAccountStatesMode', () => {
  it('holds a body with nothing to draw on the first-load skeleton while the page header names the pending read', () => {
    expect(planAccountStatesMode('pending', true, true)).toBe('reading');
    // Beside other content the header's mention is enough, and a host without the header keeps the line.
    expect(planAccountStatesMode('pending', true, false)).toBe('hidden');
    expect(planAccountStatesMode('pending', false, true)).toBe('line');
  });
  it('keeps a failed read as its line with Retry, never a skeleton', () => {
    expect(planAccountStatesMode('failed', true, true)).toBe('line');
  });
});
