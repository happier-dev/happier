import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const appliedRuntimeMock = vi.hoisted(() => ({
  execute: vi.fn(),
  release: vi.fn(async () => undefined),
  tryAcquire: vi.fn(),
}));

vi.mock('@/plugins/runtime/invocation/actions/executeContributedAction', () => ({
  executeContributedAction: appliedRuntimeMock.execute,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    tryAcquireRuntimeRegistry: appliedRuntimeMock.tryAcquire,
  },
}));

import {
  PLUGIN_ACTION_EXECUTE_PATH,
  PLUGIN_CATALOG_READ_PATH,
  PLUGIN_CHANGE_LIST_PATH,
  PLUGIN_CHANGE_STATUS_PATH,
  PLUGIN_DEVELOPMENT_CONTROL_PATH,
  registerDaemonPluginChangeRoutes,
} from './controlRoutes';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { createDaemonPluginChangeService } from './changeService';

type RouteParams = Parameters<typeof registerDaemonPluginChangeRoutes>[1];

/** One route registration whose owners are observable boundaries of the route. */
function createRouteHarness(requireAuth: RouteParams['requireAuth'] = vi.fn(async () => undefined)) {
  const app = fastify();
  const owners = {
    requestPluginChange: vi.fn(),
    decidePluginChange: vi.fn(),
    statusPluginChange: vi.fn(async () => ({ kind: 'expired' as const })),
    listPendingPluginChanges: vi.fn(async () => ({ changes: [] })),
    controlPluginDevelopment: vi.fn(),
    executeAction: vi.fn(),
  };
  registerDaemonPluginChangeRoutes(app, {
    service: {
      requestPluginChange: owners.requestPluginChange,
      decidePluginChange: owners.decidePluginChange,
      statusPluginChange: owners.statusPluginChange,
      listPendingPluginChanges: owners.listPendingPluginChanges,
      controlPluginDevelopment: owners.controlPluginDevelopment,
      shutdown: async () => undefined,
    },
    requireAuth,
    executeAction: owners.executeAction,
  });
  return { app, owners, requireAuth };
}

const committedGeneration = {
  kind: 'committed' as const,
  pluginId: 'acme.example',
  desiredGeneration: 'generation-1',
  appliedGeneration: 'generation-1',
  pendingSurfaces: [],
};
const curatedListing = {
  source: { id: 'marketplace:curated', kind: 'curated', sourceUrl: 'https://marketplace.example.test/catalog.json' },
  pluginId: 'acme.example',
  publisher: { id: 'acme', displayName: 'Acme' },
  packageName: '@acme/example',
  registryOrigin: 'https://registry.npmjs.org',
  version: '1.2.3',
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  manifestDigest: `sha256:${'a'.repeat(64)}`,
  review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
  updatePolicy: 'allowed',
};
const userSource = {
  id: 'source_team_catalog',
  kind: 'user',
  sourceUrl: 'https://catalog.example.test/index.json',
};
const PLUGIN_CHANGE_REQUEST_URL = '/plugins/change/request';
const PLUGIN_CHANGE_DECISION_URL = '/plugins/change/decide';

const acceptedRequests: ReadonlyArray<Readonly<{
  name: string;
  url: string;
  owner: 'requestPluginChange' | 'executeAction';
  payload: Readonly<Record<string, unknown>>;
  result: unknown;
}>> = [{
  name: 'exact marketplace pointer without caller-described listing authority',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: { kind: 'installMarketplace', sourceId: 'catalog', pluginId: 'acme.example', packageName: '@acme/example', version: '1.2.3' },
  result: committedGeneration,
}, {
  name: 'destructive uninstall',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: { kind: 'uninstallAndDeleteData', pluginId: 'acme.example' },
  result: {
    kind: 'committed',
    pluginId: 'acme.example',
    desiredGeneration: null,
    appliedGeneration: null,
    pendingSurfaces: [],
    dataRemoval: { alreadyUninstalled: false, removedData: { daemonStorage: true, secrets: true } },
  },
}, {
  name: 'canonical update policy',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: { kind: 'setUpdatePolicy', pluginId: 'acme.example', policy: 'allowed' },
  result: committedGeneration,
}, {
  name: 'pre-evaluation one-file development request without a plugin id',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: { kind: 'development', sourceRootPath: '/tmp/plugin.ts' },
  result: { kind: 'failed', code: 'fixture' },
}, {
  name: 'installed-plugin update identity',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: { kind: 'update', pluginId: 'acme.example' },
  result: { kind: 'failed', code: 'plugin_update_pinned' },
}, {
  name: 'exact approved curated marketplace listing',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: {
    kind: 'installNpm',
    packageName: '@acme/example',
    selector: '1.2.3',
    registryOrigin: 'https://registry.npmjs.org',
    registryProfileId: 'registry_private',
    expectedMarketplaceListing: { ...curatedListing, registryProfileId: 'registry_private' },
  },
  result: committedGeneration,
}, {
  name: 'exact unreviewed community npm listing',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: {
    kind: 'installNpm',
    packageName: '@acme/example',
    selector: '1.2.3',
    registryOrigin: 'https://registry.npmjs.org',
    expectedMarketplaceListing: {
      ...curatedListing,
      source: {
        id: 'marketplace:community-npm',
        kind: 'community-npm',
        sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100',
      },
      review: { status: 'unreviewed', reviewedAt: null },
    },
  },
  result: { kind: 'failed', code: 'fixture' },
}, {
  name: 'exact unreviewed user-source listing',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: {
    kind: 'installNpm',
    packageName: '@acme/example',
    selector: '1.2.3',
    registryOrigin: 'https://registry.example.test',
    registryProfileId: 'registry_private',
    expectedMarketplaceListing: {
      ...curatedListing,
      source: userSource,
      registryOrigin: 'https://registry.example.test',
      registryProfileId: 'registry_private',
      review: { status: 'unreviewed', reviewedAt: null },
      updatePolicy: 'pinned',
    },
  },
  result: { kind: 'failed', code: 'fixture' },
}, {
  name: 'canonical expected archive SHA-256',
  url: PLUGIN_CHANGE_REQUEST_URL,
  owner: 'requestPluginChange',
  payload: {
    kind: 'installArchive',
    locator: '/tmp/plugin.tgz',
    expectedIntegrity: `sha256-${Buffer.alloc(32, 2).toString('base64')}`,
  },
  result: { kind: 'failed', code: 'fixture' },
}, {
  name: 'qualified action invocation through the applied-daemon runtime',
  url: PLUGIN_ACTION_EXECUTE_PATH,
  owner: 'executeAction',
  payload: { actionId: 'acme.example/echo', input: { value: 'hello' }, surface: 'cli' },
  result: { matched: true, result: { ok: true, result: { echoed: 'hello' } } },
}];

const rejectedRequests: ReadonlyArray<Readonly<{
  name: string;
  url: string;
  payload: Readonly<Record<string, unknown>>;
}>> = [{
  name: 'a non-canonical update policy',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: { kind: 'setUpdatePolicy', pluginId: 'acme.example', policy: 'automatic' },
}, {
  name: 'a malformed request',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: { kind: 'installPath', locator: '', development: false, unexpected: true },
}, {
  name: 'a legacy direct development install-path request',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: { kind: 'installPath', locator: '/tmp/example', development: true },
}, {
  name: 'the retired manual LKG request',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: { kind: 'lkg', pluginId: 'acme.example' },
}, {
  name: 'a user-source listing that claims an approved review',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: {
    kind: 'installNpm',
    packageName: '@acme/example',
    selector: '1.2.3',
    registryOrigin: 'https://registry.example.test',
    expectedMarketplaceListing: { ...curatedListing, source: userSource, registryOrigin: 'https://registry.example.test' },
  },
}, {
  // The listing a caller claims to have reviewed is a closed schema. An
  // unrecognized field is rejected rather than carried past the route into
  // the daemon change owner.
  name: 'caller-injected fields on an approved curated marketplace listing',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: {
    kind: 'installNpm',
    packageName: '@acme/example',
    selector: '1.2.3',
    registryOrigin: 'https://registry.npmjs.org',
    expectedMarketplaceListing: { ...curatedListing, approvedByCaller: true },
  },
}, {
  name: 'a malformed expected archive SHA-256',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: {
    kind: 'installArchive',
    locator: '/tmp/plugin.tgz',
    expectedIntegrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
  },
}, {
  name: 'a non-approved marketplace listing',
  url: PLUGIN_CHANGE_REQUEST_URL,
  payload: {
    kind: 'installNpm',
    packageName: '@acme/example',
    selector: '1.2.3',
    registryOrigin: 'https://registry.npmjs.org',
    expectedMarketplaceListing: {
      ...curatedListing,
      review: { status: 'withdrawn', reviewedAt: '2026-07-21T00:00:00.000Z' },
    },
  },
}];

describe('registerDaemonPluginChangeRoutes', () => {
  it('forwards reversible handoff and final shutdown refusals from the real change owner', async () => {
    const app = fastify();
    const service = createDaemonPluginChangeService({
      prepare: async () => ({
        pluginId: 'acme.example',
        requiresReview: false,
        apply: async () => ({
          kind: 'committed',
          pluginId: 'acme.example',
          desiredGeneration: 'generation-1',
          appliedGeneration: 'generation-1',
          pendingSurfaces: [],
        }),
        cleanup: async () => undefined,
      }),
    });
    registerDaemonPluginChangeRoutes(app, {
      service,
      requireAuth: async (request, reply) => {
        if (request.headers.authorization !== 'Bearer test-token') await reply.code(401).send();
      },
    });
    const request = () => app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      headers: { authorization: 'Bearer test-token' },
      payload: { kind: 'installPath', locator: '/tmp/example', development: false },
    });
    const lease = await service.quiesceForHandoff();
    try {
      const draining = await request();
      expect(draining.statusCode).toBe(200);
      expect(draining.json()).toEqual({ kind: 'unavailable', code: 'daemon_draining' });

      lease.resume();
      const resumed = await request();
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ kind: 'committed', pluginId: 'acme.example' });

      const finalLease = await service.quiesceForHandoff();
      await service.shutdown();
      const stopped = await request();
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json()).toEqual({ kind: 'unavailable', code: 'daemon_shutting_down' });
      finalLease.resume();
      expect((await request()).json()).toEqual({ kind: 'unavailable', code: 'daemon_shutting_down' });
    } finally {
      lease.resume();
      await service.shutdown();
      await app.close();
    }
  });

  it('exposes one authenticated daemon development register/unregister/reload/status contract', async () => {
    const app = fastify();
    const controlPluginDevelopment = vi.fn(async () => ({
      kind: 'status' as const,
      status: { roots: [], plugins: [] },
    }));
    const requireAuth = vi.fn(async () => undefined);
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        controlPluginDevelopment,
        shutdown: async () => undefined,
      },
      requireAuth,
    });

    const response = await app.inject({
      method: 'POST',
      url: PLUGIN_DEVELOPMENT_CONTROL_PATH,
      payload: { kind: 'registerWorkspace', projectRoot: '/workspace/project', trust: 'accept' },
    });

    expect(response.statusCode).toBe(200);
    expect(requireAuth).toHaveBeenCalledOnce();
    expect(controlPluginDevelopment).toHaveBeenCalledWith({
      kind: 'registerWorkspace',
      projectRoot: '/workspace/project',
      trust: 'accept',
    });

    const unregister = await app.inject({
      method: 'POST',
      url: PLUGIN_DEVELOPMENT_CONTROL_PATH,
      payload: { kind: 'unregisterExplicit', rootPath: '/workspace/plugin' },
    });
    expect(unregister.statusCode).toBe(200);
    expect(controlPluginDevelopment).toHaveBeenLastCalledWith({
      kind: 'unregisterExplicit',
      rootPath: '/workspace/plugin',
    });
  });

  it('projects a daemon-owned pending change status without creating another request', async () => {
    const app = fastify();
    const statusPluginChange = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      reviewKind: 'installation' as const,
      pendingChangeId: 'pending-1',
      reason: 'firstInstall' as const,
      currentVersion: null,
      authorityExpansion: [],
      review: createPluginInstallationReviewFixture(),
    }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange: vi.fn(),
        statusPluginChange,
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: PLUGIN_CHANGE_STATUS_PATH,
      payload: { pendingChangeId: 'pending-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
      pendingChangeId: 'pending-1',
    });
    expect(statusPluginChange).toHaveBeenCalledWith({ pendingChangeId: 'pending-1' });
  });

  it('enumerates the outstanding decisions a present user still owes', async () => {
    const app = fastify();
    const review = createPluginInstallationReviewFixture();
    const listPendingPluginChanges = vi.fn(async () => ({
      changes: [
        {
          kind: 'reviewRequired' as const, reviewKind: 'projectTrust' as const,
          pendingChangeId: 'pending-1',
          review: { source: { kind: 'path' as const, locator: '/tmp/agent-authored' } },
        },
        {
          kind: 'reviewRequired' as const,
          reviewKind: 'installation' as const,
          pendingChangeId: 'pending-2',
          reason: 'firstInstall' as const,
          currentVersion: null,
          authorityExpansion: [],
          review,
        },
        { kind: 'applying' as const, pendingChangeId: 'pending-3' },
      ],
    }));
    const requireAuth = vi.fn(async () => undefined);
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges,
        shutdown: async () => undefined,
      },
      requireAuth,
    });

    const response = await app.inject({ method: 'POST', url: PLUGIN_CHANGE_LIST_PATH, payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      changes: [
        {
          kind: 'reviewRequired', reviewKind: 'projectTrust',
          pendingChangeId: 'pending-1',
          review: { source: { kind: 'path', locator: '/tmp/agent-authored' } },
        },
        { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-2', review: JSON.parse(JSON.stringify(review)) },
        { kind: 'applying', pendingChangeId: 'pending-3' },
      ],
    });
    // Enumeration is an authenticated daemon read like every other change route.
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('reads installed/current plugin serving state through the authenticated daemon boundary', async () => {
    const app = fastify();
    const readCatalog = vi.fn(async () => [{
      pluginId: 'acme.example',
      desiredGeneration: 'generation-7',
      appliedGeneration: 'generation-7',
    }]);
    const requireAuth = vi.fn(async () => undefined);
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth,
      readCatalog,
    });

    const response = await app.inject({
      method: 'POST',
      url: PLUGIN_CATALOG_READ_PATH,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: 'available',
      plugins: [{
        pluginId: 'acme.example',
        desiredGeneration: 'generation-7',
        appliedGeneration: 'generation-7',
      }],
    });
    expect(readCatalog).toHaveBeenCalledOnce();
    expect(requireAuth).toHaveBeenCalledOnce();
  });

  it.each(acceptedRequests)('forwards an accepted $name verbatim to its owner', async (row) => {
    const { app, owners, requireAuth } = createRouteHarness();
    owners[row.owner].mockResolvedValueOnce(row.result);

    const response = await app.inject({ method: 'POST', url: row.url, payload: row.payload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(row.result);
    expect(owners[row.owner]).toHaveBeenCalledWith(row.payload);
    expect(requireAuth).toHaveBeenCalledOnce();
  });

  it.each(rejectedRequests)('rejects $name before the daemon change owner sees it', async (row) => {
    const { app, owners } = createRouteHarness();

    const response = await app.inject({ method: 'POST', url: row.url, payload: row.payload });

    expect(response.statusCode).toBe(400);
    expect(owners.requestPluginChange).not.toHaveBeenCalled();
    expect(owners.decidePluginChange).not.toHaveBeenCalled();
  });

  it('refuses every unauthenticated control request before any daemon owner runs', async () => {
    const { app, owners } = createRouteHarness(async (_request, reply) => {
      await reply.code(401).send();
    });

    for (const [url, payload] of [
      [PLUGIN_CHANGE_REQUEST_URL, { kind: 'installPath', locator: '/tmp/example', development: false }],
      [PLUGIN_CHANGE_DECISION_URL, { pendingChangeId: 'pending-1', decision: 'installAndTrust' }],
      [PLUGIN_CHANGE_STATUS_PATH, { pendingChangeId: 'pending-1' }],
      [PLUGIN_CHANGE_LIST_PATH, {}],
      [PLUGIN_DEVELOPMENT_CONTROL_PATH, { kind: 'unregisterExplicit', rootPath: '/workspace/plugin' }],
      [PLUGIN_ACTION_EXECUTE_PATH, { actionId: 'acme.example/echo', input: {}, surface: 'cli' }],
    ] as const) {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    }

    for (const owner of Object.values(owners)) expect(owner).not.toHaveBeenCalled();
  });

  it.each([{
    name: 'trust decision with its optional selections',
    payload: { pendingChangeId: 'pending-1', decision: 'installAndTrust', optionalSelections: [] },
    result: committedGeneration,
  }, {
    name: 'cancellation without manufactured approval evidence',
    payload: { pendingChangeId: 'pending-1', decision: 'cancel' },
    result: { kind: 'cancelled' },
  }])('forwards a $name to the change owner exactly', async (row) => {
    const { app, owners } = createRouteHarness();
    owners.decidePluginChange.mockResolvedValueOnce(row.result);

    const response = await app.inject({ method: 'POST', url: PLUGIN_CHANGE_DECISION_URL, payload: row.payload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(row.result);
    expect(owners.decidePluginChange).toHaveBeenCalledWith(row.payload);
  });

  /**
   * The route already authenticates the caller and the change service already
   * resolves the pending change it names. A caller-described actor, interaction
   * id, or approval timestamp is therefore self-asserted rather than evidence,
   * and the closed request keeps one from reappearing on any decision or on the
   * destructive uninstall request.
   */
  it('rejects caller-asserted actor evidence before the daemon change owner', async () => {
    const app = fastify();
    const decidePluginChange = vi.fn();
    const requestPluginChange = vi.fn();
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange,
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const actorEvidence = {
      kind: 'authenticatedLocalUser',
      interactionId: 'explicit-cli-trust-1',
      occurredAtMs: 1,
    };
    for (const [url, payload] of [
      ['/plugins/change/decide', {
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
        actorEvidence,
        optionalSelections: [],
      }],
      ['/plugins/change/request', {
        kind: 'uninstallAndDeleteData',
        pluginId: 'acme.example',
        actorEvidence,
      }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(400);
    }

    expect(decidePluginChange).not.toHaveBeenCalled();
    expect(requestPluginChange).not.toHaveBeenCalled();
  });

  it('holds the applied daemon registry lease while the default action executor runs', async () => {
    const app = fastify();
    const appliedRegistry = { generationId: 'applied-generation-7' };
    appliedRuntimeMock.release.mockClear();
    appliedRuntimeMock.execute.mockReset().mockResolvedValue({
      matched: true,
      result: { ok: true, result: { generation: 7 } },
    });
    appliedRuntimeMock.tryAcquire.mockReset().mockReturnValue({
      registry: appliedRegistry,
      source: 'active',
      release: appliedRuntimeMock.release,
    });
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: PLUGIN_ACTION_EXECUTE_PATH,
      payload: {
        actionId: 'acme.example/echo',
        input: { value: 'hello' },
        surface: 'cli',
        expectedContributorOccurrenceId: 'occurrence-g',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(appliedRuntimeMock.execute).toHaveBeenCalledWith({
      runtimeRegistry: appliedRegistry,
      actionId: 'acme.example/echo',
      input: { value: 'hello' },
      expectedContributorOccurrenceId: 'occurrence-g',
      context: { surface: 'cli' },
    });
    expect(appliedRuntimeMock.release).toHaveBeenCalledOnce();
  });
});
