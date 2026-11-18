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

  it('checks the held snapshot without rereading owners and is available only with deployments', async () => {
    const catalog = DeploySuggestionCatalogV1Schema.parse({ starters: [{ id: 'website', title: 'Website', deploy }],
      apps: [], targets, machines: [], stores: [], forges });
    const recommendation = { source: { kind: 'starter', starterId: 'website' }, targetId: 'own-server',
      whatToBuild: 'Bakery website', stack: deploy, data: { kind: 'none' }, variables: [] };
    const result = await createActionExecutor({}).execute('deployments.suggestions.check', {
      catalog, suggestion: { recommendations: [recommendation, { ...recommendation, targetId: 'invented' }] },
    }, context);
    expect(result, JSON.stringify(result)).toEqual({ ok: true, result: { recommendations: [recommendation],
      dropped: [{ index: 1, reason: 'unknown_id' }], questions: null } });
    expect(getActionSpec('deployments.suggestions.check').sideEffectClass).toBe('read');
    expect(getActionRequiredServerFeatureId('deployments.suggestions.check')).toBe('deployments');
    expect(getActionRequiredServerFeatureId('deployments.suggestions.catalog')).toBe('deployments');
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
