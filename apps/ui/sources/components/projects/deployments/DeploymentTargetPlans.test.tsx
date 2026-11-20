import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    {},
  ),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { DeploymentTargetPlans, matchAccountPlan } =
  await import('./DeploymentTargetPlans');

/** Vercel's declared plans, as its manifest dates them (Protocol DeploymentTargetPlanV1). */
const plans = [
  {
    id: 'hobby',
    title: 'Hobby',
    price: { amount: '0', currency: 'USD', unit: 'month' },
    facts: [{ label: 'Seats', value: '1 developer' }],
    source: {
      url: 'https://vercel.com/docs/plans/hobby',
      checkedAt: '2026-11-16',
    },
  },
  {
    id: 'pro',
    title: 'Pro',
    price: { amount: '20', currency: 'USD', unit: 'month' },
    facts: [{ label: 'Transfer', value: '1 TB a month' }],
    source: {
      url: 'https://vercel.com/docs/plans/pro-plan',
      checkedAt: '2026-11-16',
    },
  },
];

describe('a platform’s declared plans with the connected account’s plan (deploy auto-mode U3/U4)', () => {
  it('matches the provider’s plan name to a declared plan by id or title, and nothing else', () => {
    expect(matchAccountPlan(plans, 'Pro')?.id).toBe('pro');
    expect(matchAccountPlan(plans, 'hobby')?.id).toBe('hobby');
    expect(matchAccountPlan(plans, 'Enterprise')).toBeNull();
    expect(matchAccountPlan(plans, null)).toBeNull();
  });

  it('a product-named account plan matches its own plan id only: a Workers plan is never the Pages plan (R5, D4)', () => {
    const plan = (id: string, title: string) => ({ id, title, facts: [],
      source: { url: 'https://developers.cloudflare.com/workers/platform/pricing/', checkedAt: '2026-11-16' } });
    const workers = [plan('workers-free', 'Free'), plan('workers-paid', 'Paid')];
    const pages = [plan('free', 'Free')];
    expect(matchAccountPlan(workers, 'Workers Paid')?.id).toBe('workers-paid');
    expect(matchAccountPlan(pages, 'Workers Paid')).toBeNull();
    expect(matchAccountPlan(pages, 'Workers Free')).toBeNull();
  });

  it('prints a priced fact through the shared cost presenter (owner ruling A1)', async () => {
    const priced = [{ ...plans[1]!, facts: [{ label: 'Extra requests', price: { amount: '0.30', currency: 'USD', unit: '1M requests' } }] }];
    const screen = await renderScreen(
      <DeploymentTargetPlans plans={priced} platform="Vercel" columns phone={false} testID="plans" />,
    );
    expect(screen.getTextContent()).toContain('$0.30 per 1M requests');
    await screen.unmount();
  });

  it('names a source its plans share once per card, with the date on its words (DESIGN-ACCEPT P1/P2)', async () => {
    const screen = await renderScreen(
      <DeploymentTargetPlans plans={plans} platform="Vercel" columns={false} phone={false} testID="plans" />,
    );
    const text = screen.getTextContent();
    expect(text.split('Price from vercel.com').length - 1).toBe(1);
    // "checked" and its date stay one phrase: a narrow card never leaves the date alone on a line.
    expect(text).toMatch(/checked \S+ \S+/);
    await screen.unmount();
  });

  it('says “Your plan” only for a declared plan, and dates every plan by its public page', async () => {
    const shown = await renderScreen(
      <DeploymentTargetPlans
        plans={plans}
        platform="Vercel"
        columns
        phone={false}
        testID="plans"
        accountPlanLabel="Pro"
      />,
    );
    expect(shown.findByTestId('plans:yourPlan')).not.toBeNull();
    expect(shown.getTextContent()).toContain('Pro');
    expect(shown.getTextContent()).toContain('vercel.com');
    await shown.unmount();
    for (const label of ['Enterprise', null]) {
      const bundled = await renderScreen(
        <DeploymentTargetPlans
          plans={plans}
          platform="Vercel"
          columns
          phone={false}
          testID="plans"
          accountPlanLabel={label}
        />,
      );
      expect(bundled.findByTestId('plans:yourPlan'), String(label)).toBeNull();
      // The price is data the shared cost presenter prints (owner ruling A1), beside the facts as declared.
      expect(bundled.getTextContent()).toContain('$20.00 a month');
      expect(bundled.getTextContent()).toContain('1 TB a month');
      await bundled.unmount();
    }
  });
});
