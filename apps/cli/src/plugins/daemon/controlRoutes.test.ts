import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const appliedRuntimeMock = vi.hoisted(() => ({
  execute: vi.fn(),
  release: vi.fn(async () => undefined),
  tryAcquire: vi.fn(),
}));

vi.mock('@/plugins/projection/actions/execute', () => ({
  executePluginActionIfAvailable: appliedRuntimeMock.execute,
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
  registerDaemonPluginChangeRoutes,
} from './controlRoutes';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

describe('registerDaemonPluginChangeRoutes', () => {
  it('admits destructive uninstall only through the authenticated daemon change route', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: null,
      appliedGeneration: null,
      pendingSurfaces: [],
      dataRemoval: {
        alreadyUninstalled: false,
        removedData: { daemonStorage: true, secrets: true },
      },
    }));
    const requireAuth = vi.fn(async () => undefined);
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth,
    });
    const actorEvidence = {
      kind: 'authenticatedLocalUser',
      interactionId: 'destructive-uninstall',
      occurredAtMs: 1,
    } as const;

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: {
        kind: 'uninstallAndDeleteData',
        pluginId: 'acme.example',
        actorEvidence,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(requireAuth).toHaveBeenCalledOnce();
    expect(requestPluginChange).toHaveBeenCalledWith({
      kind: 'uninstallAndDeleteData',
      pluginId: 'acme.example',
      actorEvidence,
    });
  });

  it('projects a daemon-owned pending change status without creating another request', async () => {
    const app = fastify();
    const statusPluginChange = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
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
      kind: 'reviewRequired',
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
          kind: 'sourceRootReviewRequired' as const,
          pendingChangeId: 'pending-1',
          review: { source: { kind: 'path' as const, locator: '/tmp/agent-authored' } },
        },
        { kind: 'reviewRequired' as const, pendingChangeId: 'pending-2', review },
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
          kind: 'sourceRootReviewRequired',
          pendingChangeId: 'pending-1',
          review: { source: { kind: 'path', locator: '/tmp/agent-authored' } },
        },
        { kind: 'reviewRequired', pendingChangeId: 'pending-2', review: JSON.parse(JSON.stringify(review)) },
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

  it('serves the current normalized tool view and retires it without a client-side catalog cache', async () => {
    const app = fastify();
    let tools = [{
      toolId: 'acme.example/roundtrip-tool',
      actionId: 'acme.example/roundtrip',
      name: 'acme_roundtrip',
      title: 'Roundtrip',
      description: 'Run roundtrip',
      inputSchema: {},
      surfaces: ['agent', 'mcp', 'cli'] as const,
    }];
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
      readCatalogSnapshot: async () => ({
        plugins: [],
        tools,
      }),
    });

    const installed = await app.inject({
      method: 'POST',
      url: PLUGIN_CATALOG_READ_PATH,
      payload: {},
    });
    expect(installed.json()).toMatchObject({
      kind: 'available',
      tools: [{
        actionId: 'acme.example/roundtrip',
        name: 'acme_roundtrip',
      }],
    });

    tools = [];
    const retired = await app.inject({
      method: 'POST',
      url: PLUGIN_CATALOG_READ_PATH,
      payload: {},
    });
    expect(retired.json()).toEqual({
      kind: 'available',
      plugins: [],
      tools: [],
    });
  });

  it('exposes plugin changes through the authenticated daemon boundary', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: createPluginInstallationReviewFixture(),
    }));
    const decidePluginChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));
    const requireAuth = vi.fn(async () => undefined);
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange,
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth,
    });

    const requestResponse = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: { kind: 'installPath', locator: '/tmp/example', development: false },
    });
    expect(requestResponse.statusCode).toBe(200);
    expect(requestResponse.json()).toEqual(expect.objectContaining({ kind: 'reviewRequired', pendingChangeId: 'pending-1' }));

    const decisionResponse = await app.inject({
      method: 'POST',
      url: '/plugins/change/decide',
      payload: {
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
        actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'interaction-1', occurredAtMs: 1 },
      },
    });
    expect(decisionResponse.statusCode).toBe(200);
    expect(decisionResponse.json()).toEqual(expect.objectContaining({ kind: 'committed' }));
    expect(requireAuth).toHaveBeenCalledTimes(2);
  });

  it('forwards explicit CLI trust provenance only as typed authenticated actor evidence', async () => {
    const app = fastify();
    const decidePluginChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
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
      provenance: {
        kind: 'explicitCliTrustFlag',
        command: 'plugins install',
        flag: '--trust',
        source: { kind: 'path', locator: '/tmp/example-plugin-source' },
        pluginId: 'acme.example',
      },
    } as const;
    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/decide',
      payload: {
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
        actorEvidence,
        optionalSelections: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(decidePluginChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence,
      optionalSelections: [],
    });
  });

  it('rejects malformed explicit CLI trust provenance before the daemon decision owner', async () => {
    const app = fastify();
    const decidePluginChange = vi.fn();
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange,
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/decide',
      payload: {
        pendingChangeId: 'pending-1',
        decision: 'installAndTrust',
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: 'explicit-cli-trust-1',
          occurredAtMs: 1,
          provenance: {
            kind: 'explicitCliTrustFlag',
            command: 'plugins marketplace install',
            flag: '--trust',
            source: { kind: 'path', locator: '/tmp/example-plugin-source' },
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(decidePluginChange).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before the service owner sees them', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn();
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: { kind: 'installPath', locator: '', development: false, unexpected: true },
    });
    expect(response.statusCode).toBe(400);
    expect(requestPluginChange).not.toHaveBeenCalled();
  });

  it('accepts a pre-evaluation one-file development request without a plugin id', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn(async () => ({
      kind: 'failed' as const,
      code: 'fixture',
    }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: { kind: 'development', sourceRootPath: '/tmp/plugin.ts' },
    });

    expect(response.statusCode).toBe(200);
    expect(requestPluginChange).toHaveBeenCalledWith({
      kind: 'development',
      sourceRootPath: '/tmp/plugin.ts',
    });
  });

  it('rejects the retired manual LKG request instead of advertising a broken recovery owner', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn();
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: { kind: 'lkg', pluginId: 'acme.example' },
    });

    expect(response.statusCode).toBe(400);
    expect(requestPluginChange).not.toHaveBeenCalled();
  });

  it('passes an installed-plugin update identity to the daemon owner', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn(async () => ({
      kind: 'failed' as const,
      code: 'plugin_update_pinned',
    }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: { kind: 'update', pluginId: 'acme.example' },
    });

    expect(response.statusCode).toBe(200);
    expect(requestPluginChange).toHaveBeenCalledWith({
      kind: 'update',
      pluginId: 'acme.example',
    });
  });

  it('passes an exact approved curated marketplace listing to the daemon change owner', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn(async () => ({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });
    const expectedMarketplaceListing = {
      source: { id: 'marketplace:curated', kind: 'curated', sourceUrl: 'https://marketplace.example.test/catalog.json' },
      pluginId: 'acme.example',
      publisher: { id: 'acme', displayName: 'Acme' },
      packageName: '@acme/example',
      registryOrigin: 'https://registry.npmjs.org',
      registryProfileId: 'registry_private',
      version: '1.2.3',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
      updatePolicy: 'automatic',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: {
        kind: 'installNpm',
        packageName: '@acme/example',
        selector: '1.2.3',
        registryOrigin: 'https://registry.npmjs.org',
        registryProfileId: 'registry_private',
        expectedMarketplaceListing,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(requestPluginChange).toHaveBeenCalledWith({
      kind: 'installNpm',
      packageName: '@acme/example',
      selector: '1.2.3',
      registryOrigin: 'https://registry.npmjs.org',
      registryProfileId: 'registry_private',
      expectedMarketplaceListing,
    });
  });

  it('passes an exact unreviewed community npm listing to the daemon change owner', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn(async () => ({ kind: 'failed' as const, code: 'fixture' }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });
    const expectedMarketplaceListing = {
      source: {
        id: 'marketplace:community-npm',
        kind: 'community-npm',
        sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100',
      },
      pluginId: 'acme.example',
      publisher: { id: 'acme', displayName: 'Acme' },
      packageName: '@acme/example',
      registryOrigin: 'https://registry.npmjs.org',
      version: '1.2.3',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      review: { status: 'unreviewed', reviewedAt: null },
      updatePolicy: 'manual',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: {
        kind: 'installNpm',
        packageName: '@acme/example',
        selector: '1.2.3',
        registryOrigin: 'https://registry.npmjs.org',
        expectedMarketplaceListing,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(requestPluginChange).toHaveBeenCalledWith(expect.objectContaining({ expectedMarketplaceListing }));
  });

  it('rejects caller-injected evidence on an approved curated marketplace listing', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn();
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: {
        kind: 'installNpm',
        packageName: '@acme/example',
        selector: '1.2.3',
        registryOrigin: 'https://registry.npmjs.org',
        expectedMarketplaceListing: {
          source: {
            id: 'marketplace:curated',
            kind: 'curated',
            sourceUrl: 'https://marketplace.example.test/catalog.json',
          },
          pluginId: 'acme.example',
          publisher: { id: 'acme', displayName: 'Acme' },
          packageName: '@acme/example',
          registryOrigin: 'https://registry.npmjs.org',
          version: '1.2.3',
          integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
          updatePolicy: 'automatic',
          actorEvidence: {
            kind: 'authenticatedLocalUser',
            interactionId: 'caller-selected',
            occurredAtMs: 20,
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(requestPluginChange).not.toHaveBeenCalled();
  });

  it('passes a canonical expected archive SHA-256 to the daemon change owner', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn(async () => ({ kind: 'failed' as const, code: 'fixture' }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });
    const expectedIntegrity = `sha256-${Buffer.alloc(32, 2).toString('base64')}`;

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: { kind: 'installArchive', locator: '/tmp/plugin.tgz', expectedIntegrity },
    });

    expect(response.statusCode).toBe(200);
    expect(requestPluginChange).toHaveBeenCalledWith({
      kind: 'installArchive',
      locator: '/tmp/plugin.tgz',
      expectedIntegrity,
    });
  });

  it('rejects a malformed expected archive SHA-256 before the daemon change owner', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn();
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: {
        kind: 'installArchive',
        locator: '/tmp/plugin.tgz',
        expectedIntegrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(requestPluginChange).not.toHaveBeenCalled();
  });

  it('rejects a non-approved marketplace listing before the daemon change owner sees it', async () => {
    const app = fastify();
    const requestPluginChange = vi.fn();
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange,
        decidePluginChange: vi.fn(),
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/request',
      payload: {
        kind: 'installNpm',
        packageName: '@acme/example',
        selector: '1.2.3',
        registryOrigin: 'https://registry.npmjs.org',
        expectedMarketplaceListing: {
          source: { id: 'marketplace:curated', kind: 'curated', sourceUrl: 'https://marketplace.example.test/catalog.json' },
          pluginId: 'acme.example',
          publisher: { id: 'acme', displayName: 'Acme' },
          packageName: '@acme/example',
          registryOrigin: 'https://registry.npmjs.org',
          version: '1.2.3',
          integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          review: { status: 'withdrawn', reviewedAt: '2026-07-21T00:00:00.000Z' },
          updatePolicy: 'automatic',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(requestPluginChange).not.toHaveBeenCalled();
  });

  it('accepts cancellation without manufacturing authenticated-user approval evidence', async () => {
    const app = fastify();
    const decidePluginChange = vi.fn(async () => ({ kind: 'cancelled' as const }));
    registerDaemonPluginChangeRoutes(app, {
      service: {
        requestPluginChange: vi.fn(),
        decidePluginChange,
        statusPluginChange: async () => ({ kind: 'expired' }),
        listPendingPluginChanges: async () => ({ changes: [] }),
        shutdown: async () => undefined,
      },
      requireAuth: async () => undefined,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/plugins/change/decide',
      payload: { pendingChangeId: 'pending-1', decision: 'cancel' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'cancelled' });
    expect(decidePluginChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it('invokes a qualified action through the authenticated applied-daemon runtime', async () => {
    const app = fastify();
    const executeAction = vi.fn(async () => ({
      matched: true as const,
      result: { ok: true as const, result: { echoed: 'hello' } },
    }));
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
      executeAction,
    });

    const response = await app.inject({
      method: 'POST',
      url: PLUGIN_ACTION_EXECUTE_PATH,
      payload: {
        actionId: 'acme.example/echo',
        input: { value: 'hello' },
        surface: 'cli',
        authority: 'present_user',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      matched: true,
      result: { ok: true, result: { echoed: 'hello' } },
    });
    expect(executeAction).toHaveBeenCalledWith({
      actionId: 'acme.example/echo',
      input: { value: 'hello' },
      surface: 'cli',
      authority: 'present_user',
    });
    expect(requireAuth).toHaveBeenCalledOnce();
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
        authority: 'account_automation',
        expectedContributorImmutableGenerationId: 'generation-g',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(appliedRuntimeMock.execute).toHaveBeenCalledWith({
      runtimeRegistry: appliedRegistry,
      actionId: 'acme.example/echo',
      input: { value: 'hello' },
      expectedContributorImmutableGenerationId: 'generation-g',
      context: { surface: 'cli' },
    });
    expect(appliedRuntimeMock.release).toHaveBeenCalledOnce();
  });
});
