import { it, expect } from 'vitest';
import { DeploySuggestionCatalogV1Schema, DeploySuggestionInputV1Schema, validateDeploySuggestionV1, renderDeployPlanBriefV1 } from './deploySuggestionsV1.js';
const catalog = DeploySuggestionCatalogV1Schema.parse({
    starters: [{ id: 'static', title: 'Static', deploy: { framework: 'html', output: 'static' } }],
    apps: [{ id: 'analytics', title: 'Analytics' }],
    targets: [
        { id: 'pages', title: 'Pages', targetClass: 'platform', availability: 'available', accepts: ['static'], needs: ['repository'] },
        { id: 'workers', title: 'Workers', targetClass: 'platform', availability: 'available', accepts: ['workers'], needs: ['stateless'] },
        { id: 'own', title: 'Own server', targetClass: 'ownServer', availability: 'available', accepts: ['compose'], needs: [] },
    ], machines: [], stores: [],
});
const recommendation = { source: { kind: 'starter', starterId: 'static' }, targetId: 'pages',
    whatToBuild: 'A bakery website', stack: { framework: 'html', output: 'static' }, data: { kind: 'none' }, variables: [] };
it('passes valid recommendations unchanged, drops unknown ids, incompatible pairs, price fields and missing fields', () => {
    const result = validateDeploySuggestionV1({ recommendations: [recommendation,
        { ...recommendation, targetId: 'invented' }, { ...recommendation, targetId: 'workers' },
        { ...recommendation, price: '$0' }, { source: recommendation.source },
        { ...recommendation, whatToBuild: 'A bakery website for $20/month' }], questions: null }, catalog);
    expect(result.recommendations).toEqual([recommendation]);
    expect(result.dropped.map(row => row.index)).toEqual([1, 2, 3, 4, 5]);
});
it('drops numeric CAD and dollar-word prices while preserving technical version text', () => {
    const technical = { ...recommendation, whatToBuild: 'A CAD 3D viewer with CSS 3 and React 20' };
    const result = validateDeploySuggestionV1({ recommendations: [technical,
        { ...recommendation, whatToBuild: 'A bakery website for CAD 20 per month' },
        { ...recommendation, whatToBuild: 'A bakery website for 20 dollars per month' }], questions: null }, catalog);
    expect(result).toEqual({ recommendations: [technical], dropped: [
        { index: 1, reason: 'invalid_recommendation' }, { index: 2, reason: 'invalid_recommendation' },
    ], questions: null });
});
it('rejects variable values before a description reaches a run', () => {
    const input = { description: 'Bakery', catalog, variables: [{ key: 'API_KEY', secret: true }] };
    expect(DeploySuggestionInputV1Schema.safeParse(input).success).toBe(true);
    expect(DeploySuggestionInputV1Schema.safeParse({ ...input, variables: [{ key: 'API_KEY', secret: true, value: 'secret' }] }).success).toBe(false);
});
it('renders the original description byte for byte in U1', () => {
    expect(renderDeployPlanBriefV1('  Bakery\n\n', recommendation)).toBe('  Bakery\n\n');
});
it('routes catalog apps only to a declared Compose host', () => {
    const app = { ...recommendation, source: { kind: 'catalogApp', appId: 'analytics' }, targetId: 'own' };
    expect(validateDeploySuggestionV1({ recommendations: [app, { ...app, targetId: 'pages' }] }, catalog).recommendations).toEqual([app]);
});
