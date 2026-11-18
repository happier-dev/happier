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
    expect(matchAccountPlan(plans, 'Pro', 'Vercel')?.id).toBe('pro');
    expect(matchAccountPlan(plans, 'hobby', 'Vercel')?.id).toBe('hobby');
    expect(matchAccountPlan(plans, 'Enterprise', 'Vercel')).toBeNull();
    expect(matchAccountPlan(plans, null, 'Vercel')).toBeNull();
  });

  it('a plan named with its product matches only that product\u2019s plans: a Workers plan is never the Pages plan (R5)', () => {
    const plan = (id: string, title: string) => ({ id, title, facts: [],
      source: { url: 'https://developers.cloudflare.com/workers/platform/pricing/', checkedAt: '2026-11-16' } });
    const workers = [plan('free', 'Free'), plan('paid', 'Paid')];
    const pages = [plan('free', 'Free')];
    expect(matchAccountPlan(workers, 'Workers Paid', 'Cloudflare Workers')?.id).toBe('paid');
    expect(matchAccountPlan(workers, 'Workers Free', 'Cloudflare Workers')?.id).toBe('free');
    expect(matchAccountPlan(pages, 'Workers Free', 'Cloudflare Pages')).toBeNull();
    expect(matchAccountPlan(pages, 'Workers Paid', 'Cloudflare Pages')).toBeNull();
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
