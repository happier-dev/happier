import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { getActionSpec } from '../actionSpecs.js';
import { getActionRequiredServerFeatureId } from '../actionRequiredServerFeature.js';
import { RegistryItemSummaryV1Schema } from '../../registries/registryItemsV1.js';
import { listHappierStarterCatalogV1, parseStarterCatalogV1 } from '../../registries/formats/happierStarterCatalog.js';
import { DeploySuggestionCatalogV1Schema } from '../../deployments/suggestions/deploySuggestionsV1.js';

const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'profile-alias', serverIdentityId: 'home' } as const;
const deploy = { framework: 'html', output: 'static' } as const;
const forges = [{ providerKind: 'github', title: 'GitHub' }];
const targets = DeploySuggestionCatalogV1Schema.parse({ starters: [], apps: [], machines: [], stores: [], forges: [], targets: [
  { id: 'own-server', title: 'Own server', targetClass: 'ownServer', availability: 'available',
    accepts: ['static', 'server', 'container', 'compose'], needs: [], sources: { gitIntegration: ['github'], upload: false } },
] }).targets;

describe('deploy suggestion read Actions', () => {
  it.each(['available', 'unavailable'] as const)('reads only activated publishers for the forge projection (%s)', async status => {
    const calls: string[] = [];
    const executor = createActionExecutor({
      deploymentSuggestionForges: async () => {
        calls.push('forges');
        if (status === 'unavailable') throw Object.assign(new Error('Publisher unavailable'), { code: 'hosting_unavailable' });
        return forges;
      },
      registryActionExecute: async () => { calls.push('registry'); return { pages: [] }; },
      connectedServiceAction: async () => { calls.push('accounts'); return { accounts: [], pools: [], healthBasis: 'credentials',
        source: { completeness: 'complete', observedAtMs: 1 } }; },
      machinesList: async () => { calls.push('machines'); return { items: [] }; },
      deploymentSuggestionTargets: async () => { calls.push('targets'); return { targets: [], stores: [] }; },
      machineSetupPlan: async () => { calls.push('setup'); return { ok: false, errorCode: 'machine_unreachable', error: 'machine_unreachable' }; },
    });
    expect(await executor.execute('deployments.suggestions.catalog', { projection: 'forges' }, context)).toEqual({ ok: true,
      result: { starters: [], apps: [], targets: [], stores: [], machines: [], connectedAccounts: [],
        forges: status === 'available' ? forges : [],
        issues: status === 'available' ? [] : [{ section: 'forges', code: 'hosting_unavailable' }] } });
    expect(calls).toEqual(['forges']);
  });

  it('lists starter deploy facts without reading every starter', () => {
    const catalog = parseStarterCatalogV1({ schemaVersion: 1, starters: [{ itemId: 'website', starter: {
      repository: 'https://github.com/example/site', title: 'Website', description: 'Small website', tags: ['web'], buildGoal: 'Build it', deploy,
    } }] });
    const summary = listHappierStarterCatalogV1({ sourceId: 'starters', catalog, fetchedAt: 1 }).items[0];
    expect(RegistryItemSummaryV1Schema.parse(summary)).toMatchObject({ starterDeploy: deploy });
  });

  it('composes one snapshot with one starter list, every app page, one account list, one Machine list and online readiness only', async () => {
    const calls: string[] = [];
    const executor = createActionExecutor({
      // These ports terminate at registry HTTP, Home account reads and the installed Machine.
      registryActionExecute: async ({ input }) => {
        const value = input as { kind: string; cursor?: string; sourceIds?: string[] };
        calls.push(`${value.kind}:${value.cursor ?? 'first'}`);
        if (value.kind === 'starter') return { pages: [{ sourceId: 'starters', status: { state: 'ok', fetchedAt: 1 }, nextCursor: null,
          items: [{ sourceId: 'starters', kind: 'starter', itemId: 'website', title: 'Website', starterDeploy: deploy }] }] };
        return { pages: [{ sourceId: 'apps', status: { state: 'ok', fetchedAt: 1 }, nextCursor: value.cursor ? null : 'page2',
          items: [{ sourceId: 'apps', kind: 'app', itemId: value.cursor ? 'analytics' : 'database', title: value.cursor ? 'Analytics' : 'Database' }] }] };
      },
      connectedServiceAction: async () => { calls.push('accounts'); return { accounts: [], pools: [], healthBasis: 'credentials',
        source: { completeness: 'complete', observedAtMs: 1 } }; },
      machinesList: async () => { calls.push('machines'); return { items: [
        { machineId: 'online', label: 'Dev box', active: true, homeDir: '/home/dev' }, { machineId: 'offline', label: 'Offline', active: false },
      ] }; },
      deploymentSuggestionTargets: async () => { calls.push('targets'); return { targets: [...targets], stores: [] }; },
      deploymentSuggestionForges: async () => { calls.push('forges'); return forges; },
      machineSetupPlan: async ({ input }) => {
        expect(input.homeId).toBe('home');
        calls.push('docker'); return { ok: false, errorCode: 'machine_unreachable', error: 'machine_unreachable' };
      },
    });
    const result = await executor.execute('deployments.suggestions.catalog', {}, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { starters: [{ id: JSON.stringify(['starters', 'website']), deploy }],
      apps: [{ id: JSON.stringify(['apps', 'database']) }, { id: JSON.stringify(['apps', 'analytics']) }], targets,
      forges, machines: [
        { machineId: 'online', online: true, readiness: 'unknown', homeDir: '/home/dev' }, { machineId: 'offline', online: false, readiness: 'unknown' },
      ] } });
    expect(calls.filter(call => call.startsWith('starter:'))).toHaveLength(1);
    expect(calls.filter(call => call.startsWith('app:'))).toHaveLength(2);
    expect(calls.filter(call => call === 'accounts')).toHaveLength(1);
    expect(calls.filter(call => call === 'machines')).toHaveLength(1);
    expect(calls.filter(call => call === 'docker')).toHaveLength(1);
    expect(calls.filter(call => call === 'targets')).toHaveLength(1);
    expect(calls.filter(call => call === 'forges')).toHaveLength(1);
  });

  it('leaves out a Machine name its owner says is not a name yet, so the placeholder never reaches the model', async () => {
    const executor = createActionExecutor({
      registryActionExecute: async () => ({ pages: [] }),
      // The Home's Machine inventory: one Machine is still hydrating, so its label is the owner's placeholder.
      machinesList: async () => ({ items: [
        { machineId: 'named', label: 'Dev box', named: true, presence: 'offline' },
        { machineId: 'loading', label: 'Loading…', named: false, presence: 'offline' },
      ] }),
    });
    const result = await executor.execute('deployments.suggestions.catalog', {}, context);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const catalog = DeploySuggestionCatalogV1Schema.parse(result.result);
    expect(catalog.machines).toEqual([
      { machineId: 'named', label: 'Dev box', online: false, readiness: 'unknown' },
      { machineId: 'loading', online: false, readiness: 'unknown' },
    ]);
  });

  it('says why there are no starters when no Machine is online to read them (AUTO-LIVE F2)', async () => {
    const executor = createActionExecutor({
      // A fresh Account: no Machine supplies the starters package, so the starter list is empty with no failing source.
      registryActionExecute: async () => ({ pages: [] }),
      machinesList: async () => ({ items: [{ machineId: 'away', label: 'Dev box', named: true, presence: 'offline' }] }),
    });
    const result = await executor.execute('deployments.suggestions.catalog', {}, context);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const catalog = DeploySuggestionCatalogV1Schema.parse(result.result);
    expect(catalog.starters).toEqual([]);
    expect(catalog.issues).toContainEqual({ section: 'starters', code: 'needs_machine' });
  });

  // F-S8-SNAPSHOT: a Session agent cannot echo the whole catalog (131 KB measured live, 957 catalog apps) back as
  // tool input, so the check reads the current catalog itself through the same composition as the catalog Action.
  it('checks a suggestion against the current catalog it reads itself, and returns the catalog rows its cards need', async () => {
    const executor = createActionExecutor({
      registryActionExecute: async ({ input }) => {
        const value = input as { kind: string };
        return { pages: [{ sourceId: value.kind === 'starter' ? 'starters' : 'apps', status: { state: 'ok', fetchedAt: 1 }, nextCursor: null,
          items: value.kind === 'starter'
            ? [{ sourceId: 'starters', kind: 'starter', itemId: 'website', title: 'Website', starterDeploy: deploy }]
            : [{ sourceId: 'apps', kind: 'app', itemId: 'database', title: 'Database' }, { sourceId: 'apps', kind: 'app', itemId: 'wiki', title: 'Wiki' }] }] };
      },
      machinesList: async () => ({ items: [] }),
      deploymentSuggestionTargets: async () => ({ targets: [...targets], stores: [] }),
      deploymentSuggestionForges: async () => forges,
    });
    const starterId = JSON.stringify(['starters', 'website']);
    const databaseId = JSON.stringify(['apps', 'database']);
    const recommendation = { source: { kind: 'starter', starterId }, targetId: 'own-server', title: 'Bakery website',
      why: 'A static site fits a few pages.', whatToBuild: 'Bakery website', stack: deploy, data: { kind: 'catalogApp', appId: databaseId }, variables: [] };
    const result = await executor.execute('deployments.suggestions.check', {
      suggestion: { recommendations: [recommendation, { ...recommendation, targetId: 'invented' }] }, description: 'A bakery site',
    }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { recommendations: [recommendation],
      dropped: [{ index: 1, reason: 'unknown_id' }], questions: null,
      // Only the catalog apps a surviving card names travel back; the small sections stay whole for the cards and Adjust.
      catalog: { starters: [{ id: starterId }], apps: [{ id: databaseId, title: 'Database' }], targets, forges } } });
    if (!result.ok) throw new Error('unreachable');
    expect((result.result as { catalog: { apps: unknown[] } }).catalog.apps).toHaveLength(1);
    expect(getActionSpec('deployments.suggestions.check').sideEffectClass).toBe('read');
    expect(getActionRequiredServerFeatureId('deployments.suggestions.check')).toBe('deployments');
    expect(getActionRequiredServerFeatureId('deployments.suggestions.catalog')).toBe('deployments');
  });

  // AUTO-LIVE step 8 (11-21, Session cmwqtdux): a Session agent sent its valid recommendations as a bare array. An
  // unknown `suggestion` admitted it, the validator found no `recommendations` and answered none with no drop reason, so
  // no cards rendered and the agent created the starter itself. The check's input declares the shape it validates.
  it('refuses a suggestion that is not the declared shape, naming the field, instead of answering no cards', async () => {
    // The captured `action_execute` input, unchanged.
    const live = { description: 'make me a tiny invoice app and deploy it', suggestion: [{ data: { kind: 'none' },
      source: { kind: 'starter', starterId: '["happier.deployment.templates/starters","static-website"]' },
      stack: { framework: 'html', output: 'static' }, targetId: 'own-server', variables: [],
      whatToBuild: 'Tiny invoice app - create, list and print invoices stored locally', repositoryProviderKind: 'github' }] };
    const result = await createActionExecutor({}).execute('deployments.suggestions.check', live, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    if (result.ok) throw new Error('unreachable');
    expect(result.details).toMatchObject({ issues: [{ path: ['suggestion'] }] });
  });

  it('refuses a held catalog in the check input: the check reads its own', async () => {
    const catalog = DeploySuggestionCatalogV1Schema.parse({ starters: [], apps: [], targets, machines: [], stores: [], forges });
    const result = await createActionExecutor({}).execute('deployments.suggestions.check', { catalog, suggestion: { recommendations: [] } }, context);
    expect(result.ok).toBe(false);
  });

  it('withdraws only forge suggestions when the hosting owner refuses the read', async () => {
    const executor = createActionExecutor({
      registryActionExecute: async () => ({ pages: [] }),
      connectedServiceAction: async () => ({ accounts: [], pools: [], healthBasis: 'credentials',
        source: { completeness: 'complete', observedAtMs: 1 } }),
      machinesList: async () => ({ items: [] }),
      deploymentSuggestionTargets: async () => ({ targets, stores: [] }),
      deploymentSuggestionForges: async () => { throw Object.assign(new Error('Forge owner unavailable'), { code: 'hosting_unavailable' }); },
    });
    expect(await executor.execute('deployments.suggestions.catalog', {}, context)).toMatchObject({
      // No Machine at all, so the empty starter list also says why (AUTO-LIVE F2).
      ok: true, result: { targets, forges: [], issues: [{ section: 'forges', code: 'hosting_unavailable' },
        { section: 'starters', code: 'needs_machine' }] },
    });
  });

  it('retains starters from later source-owned pages', async () => {
    const reads: unknown[] = [];
    const executor = createActionExecutor({
      // The registry transport owns its opaque cursor and source selection.
      registryActionExecute: async ({ input }) => {
        const value = input as { kind: string; cursor?: string; sourceIds?: string[] };
        reads.push(value);
        if (value.kind !== 'starter') return { pages: [] };
        return { pages: [{ sourceId: 'starters', status: { state: 'ok', fetchedAt: 1 },
          nextCursor: value.cursor ? null : 'starter-page2', items: [{ sourceId: 'starters', kind: 'starter',
            itemId: value.cursor ? 'later' : 'first', title: value.cursor ? 'Later starter' : 'First starter', starterDeploy: deploy }] }] };
      },
      connectedServiceAction: async () => ({ accounts: [], pools: [], healthBasis: 'credentials',
        source: { completeness: 'complete', observedAtMs: 1 } }),
      machinesList: async () => ({ items: [] }),
      deploymentSuggestionTargets: async () => ({ targets, stores: [] }),
    });
    const result = await executor.execute('deployments.suggestions.catalog', {}, context);
    expect(result).toMatchObject({ ok: true, result: { starters: [
      { id: JSON.stringify(['starters', 'first']), deploy }, { id: JSON.stringify(['starters', 'later']), deploy },
    ] } });
    expect(reads).toContainEqual({ kind: 'starter', cursor: 'starter-page2', sourceIds: ['starters'] });
  });
});
