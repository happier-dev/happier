import { expect, it } from 'vitest';
import { DeploymentTargetContributionV1Schema } from './deploymentTargets.js';

const closed = { type: 'object', properties: {}, additionalProperties: false };
const target = { id: 'example', role: 'runtime', title: 'Example', icon: 'server-outline', targetKind: 'example',
    targetSchema: closed, linkSchema: closed, actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' } };
const plan = { id: 'free', title: 'Free', facts: [{ label: 'Price', value: '$0' }], included: ['Custom domains'],
    source: { url: 'https://example.com/pricing', checkedAt: '2026-11-16' } };

it('admits declared plan facts without requiring plans on existing targets', () => {
    expect(DeploymentTargetContributionV1Schema.parse(target)).toEqual(target);
    expect(DeploymentTargetContributionV1Schema.parse({ ...target, plans: [plan] })).toEqual({ ...target, plans: [plan] });
});

it('rejects unknown plan fields and malformed source provenance', () => {
    for (const invalid of [
        { ...plan, priceCalculator: 'external' },
        { ...plan, facts: [{ ...plan.facts[0], currency: 'USD' }] },
        { ...plan, source: { ...plan.source, live: true } },
        { ...plan, source: { ...plan.source, url: 'not a URL' } },
        { ...plan, source: { ...plan.source, checkedAt: '2026-02-30' } },
    ]) expect(DeploymentTargetContributionV1Schema.safeParse({ ...target, plans: [invalid] }).success).toBe(false);
});
