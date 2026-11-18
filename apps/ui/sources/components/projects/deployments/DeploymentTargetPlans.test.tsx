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
    facts: [{ label: 'Price', value: '$0 a month' }],
    source: {
      url: 'https://vercel.com/docs/plans/hobby',
      checkedAt: '2026-11-16',
    },
  },
  {
    id: 'pro',
    title: 'Pro',
    facts: [{ label: 'Price', value: '$20 a month' }],
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
      expect(bundled.getTextContent()).toContain('$20 a month');
      await bundled.unmount();
    }
  });
});
