import { describe, expect, it } from 'vitest';

// A value import: the resolver loads the executor lazily, so the test loads its module graph up front.
import '../actions/actionExecutor.js';
import type { ActionExecutorDeps } from '../actions/actionExecutor.js';
import { resolveInputOptions } from './inputOptions.js';
import { DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1, DEPLOYMENT_TELEMETRY_ROUTES_OPTIONS_SOURCE_ID_V1 } from './deploymentTelemetryEnvironmentOptions.js';

const context = {
  surface: 'ui',
  authority: 'present_user',
  actionCaller: { kind: 'host' },
  serverId: 'home-1',
} as const;

const environment = (id: string, extra: Record<string, unknown>) => ({
  v: 1,
  id,
  serverId: 'home-1',
  projectSourceId: 'source-billing',
  revision: 1,
  owner: { kind: 'account', accountId: 'owner' },
  protection: 'production',
  purpose: 'standard',
  deployerMode: 'managers',
  dataEditorMode: 'managers',
  dataAgentAccess: 'none',
  controllerMachineId: 'machine-1',
  contentArtifactId: `artifact-${id}`,
  contentHeaderVersion: 1,
  contentBodyVersion: 1,
  createdByAccountId: 'owner',
  createdAtMs: 1,
  updatedAtMs: 1,
  capabilities: {
    editData: false,
    role: 'manager',
    read: true,
    deploy: true,
    manage: true,
    manageBindings: true,
    manageTargets: true,
    delete: true,
  },
  ...extra,
});

describe('deployments.environments.telemetry options', () => {
  it("offers every page of the Home's Environments whose telemetry is on, named Source · Environment", async () => {
    const reads: unknown[] = [];
    // Only the deployments transport is a boundary; option projection and the executor stay real.
    const deps = {
      deploymentAction: async (actionId: string, input: { cursor?: string }) => {
        reads.push([actionId, input]);
        return input.cursor === undefined
          ? { ok: true, nextCursor: 'page-2', projectSources: [{ id: 'source-billing', name: 'billing-api' }], items: [
            environment('env-production', { name: 'Production', telemetryMachineId: 'collector-1' }),
            environment('env-staging', { name: 'Staging', telemetryMachineId: null, protection: 'nonProduction' }),
          ] }
          : { ok: true, nextCursor: null, projectSources: [{ id: 'source-billing', name: 'billing-api' }], items: [
            environment('env-preview', { name: 'Preview', telemetryMachineId: 'collector-1', protection: 'nonProduction' }),
          ] };
      },
    } as unknown as ActionExecutorDeps;
    const resolved = await resolveInputOptions({
      deps,
      ctx: context,
      actionId: null,
      optionsSourceId: DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1,
      input: {},
      readFailure: () => null,
      resolveSessionId: () => null,
      reviewScope: () => undefined,
    });
    expect(resolved).toEqual({ ok: true, result: [
      { value: { serverId: 'home-1', environmentId: 'env-production' }, label: 'billing-api · Production' },
      { value: { serverId: 'home-1', environmentId: 'env-preview' }, label: 'billing-api · Preview' },
    ] });
    expect(reads).toEqual([
      ['deployments.environments.list', { serverId: 'home-1' }],
      ['deployments.environments.list', { serverId: 'home-1', cursor: 'page-2' }],
    ]);
  });

  it('needs a selected Home before it reads anything', async () => {
    let reads = 0;
    const deps = {
      deploymentAction: async () => {
        reads++;
        return { ok: true, items: [], nextCursor: null };
      },
    } as unknown as ActionExecutorDeps;
    const resolved = await resolveInputOptions({
      deps,
      ctx: { ...context, serverId: undefined },
      actionId: null,
      optionsSourceId: DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1,
      input: {},
      readFailure: () => null,
      resolveSessionId: () => null,
      reviewScope: () => undefined,
    });
    expect(resolved).toMatchObject({
      ok: false,
      errorCode: 'server_not_selected',
    });
    expect(reads).toBe(0);
  });
});

describe('deployments.environments.telemetry.routes options', () => {
  const resolve = (deps: ActionExecutorDeps, input: Record<string, unknown>) => resolveInputOptions({
    deps, ctx: context, actionId: null, optionsSourceId: DEPLOYMENT_TELEMETRY_ROUTES_OPTIONS_SOURCE_ID_V1,
    input, readFailure: () => null, resolveSessionId: () => null, reviewScope: () => undefined,
  });

  it("offers every route the chosen Environment's collector served, once each, named METHOD /route", async () => {
    const invoked: unknown[] = [];
    // The deployments transport and the contributed-Action host adapter are the boundaries; the executor stays real.
    const deps = {
      deploymentAction: async () => ({ ok: true, nextCursor: null, items: [
        environment('env-production', { name: 'Production', telemetryMachineId: 'collector-1' }),
      ] }),
      invokeContributedAction: async ({ input, context: invocation }: { input: Record<string, unknown>; context: Record<string, unknown> }) => {
        invoked.push([input, invocation.externalActionTarget]);
        const page = input.page as { before?: unknown };
        return { ok: true, result: page.before === undefined
          ? { ok: true, source: input.source, items: [
            { serviceName: 'api', method: 'POST', route: '/checkout', requestCount: 4812, errorCount: 116, errorRate: 0.024, totalDurationMs: 1, databaseTimeMs: 1 },
            { serviceName: 'api', method: 'GET', route: '/api/cart', requestCount: 9104, errorCount: 0, errorRate: 0, totalDurationMs: 1, databaseTimeMs: 1 },
          ], nextCursor: { serviceName: 'api', method: 'GET', route: '/api/cart' } }
          : { ok: true, source: input.source, items: [
            { serviceName: 'worker', method: 'POST', route: '/checkout', requestCount: 3, errorCount: 0, errorRate: 0, totalDurationMs: 1, databaseTimeMs: 1 },
          ] } };
      },
    } as unknown as ActionExecutorDeps;
    const resolved = await resolve(deps, { environment: { serverId: 'home-1', environmentId: 'env-production' } });
    expect(resolved).toEqual({ ok: true, result: [
      { value: { method: 'POST', route: '/checkout' }, label: 'POST /checkout' },
      { value: { method: 'GET', route: '/api/cart' }, label: 'GET /api/cart' },
    ] });
    expect(invoked).toHaveLength(2);
    expect(invoked[0]).toEqual([expect.objectContaining({ source: { kind: 'environment', serverId: 'home-1', environmentId: 'env-production' } }),
      { kind: 'machine', machineId: 'collector-1' }]);
    expect((invoked[1] as unknown[])[0]).toMatchObject({ page: { before: { serviceName: 'api', method: 'GET', route: '/api/cart' } } });
  });

  it('asks for the Environment first and reads nothing without it', async () => {
    let reads = 0;
    const deps = { deploymentAction: async () => { reads++; return { ok: true, items: [], nextCursor: null }; } } as unknown as ActionExecutorDeps;
    expect(await resolve(deps, {})).toMatchObject({ ok: false, errorCode: 'missing_option_dependency',
      details: { requiredDraftPath: 'environment' } });
    expect(reads).toBe(0);
  });
});
