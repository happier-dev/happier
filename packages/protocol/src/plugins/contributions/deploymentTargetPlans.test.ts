import { expect, it } from 'vitest';
import { DeploymentTargetContributionV1Schema } from './deploymentTargets.js';

const closed = { type: 'object', properties: {}, additionalProperties: false };
const target = { id: 'example', role: 'runtime', title: 'Example', icon: 'server-outline', targetKind: 'example',
    targetSchema: closed, linkSchema: closed, actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' } };
const plan = { id: 'free', title: 'Free', price: { amount: '0', currency: 'USD', unit: 'month' },
    facts: [{ label: 'Builds', value: '500 a month' }], included: ['Custom domains'],
    source: { url: 'https://example.com/pricing', checkedAt: '2026-11-16' } };

it('admits declared plan facts without requiring plans on existing targets', () => {
    expect(DeploymentTargetContributionV1Schema.parse(target)).toEqual(target);
    expect(DeploymentTargetContributionV1Schema.parse({ ...target, plans: [plan] })).toEqual({ ...target, plans: [plan] });
});

it('rejects unknown plan fields and malformed source provenance', () => {
    for (const invalid of [
        { ...plan, priceCalculator: 'external' },
        { ...plan, price: { ...plan.price, amount: '$0' } },
        { ...plan, price: { ...plan.price, text: 'free' } },
        // One price shape (O-DEPLOY, owner ruling A1): a price written as a text fact beside it is refused.
        { ...plan, facts: [{ label: 'Price', value: '$0 a month' }] },
        { ...plan, facts: [{ label: 'price', value: 'Free' }] },
        { ...plan, facts: [{ ...plan.facts[0], currency: 'USD' }] },
        { ...plan, source: { ...plan.source, live: true } },
        { ...plan, source: { ...plan.source, url: 'not a URL' } },
        { ...plan, source: { ...plan.source, checkedAt: '2026-02-30' } },
    ]) expect(DeploymentTargetContributionV1Schema.safeParse({ ...target, plans: [invalid] }).success).toBe(false);
});
