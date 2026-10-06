import http from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('unexpected server address'));
      resolve({ port: address.port });
    });
  });
}

describe('daemon control client plugin changes', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let home: string | null = null;

  afterEach(async () => {
    await clearDaemonStateForTestTeardown();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    if (home) await removeTempDir(home);
    home = null;
  });

  it('sends plugin changes and action invocation over authenticated canonical controls', async () => {
    const observed: Array<{ url: string; token: string; body: unknown }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsedBody = JSON.parse(body);
        observed.push({
          url: request.url ?? '',
          token: String(request.headers['x-happier-daemon-token'] ?? ''),
          body: parsedBody,
        });
        if (
          request.url?.endsWith('/execute')
          && parsedBody.actionId === 'acme.older-daemon/run'
        ) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(
          request.url?.endsWith('/request')
            ? parsedBody.locator === '/tmp/plugin-invalid'
              ? { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-invalid', review: {} }
              : {
                  kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
                  pendingChangeId: 'pending-1',
                  review: createPluginInstallationReviewFixture(),
                }
            : request.url?.endsWith('/status')
              ? { kind: 'applying', pendingChangeId: parsedBody.pendingChangeId }
            : request.url?.endsWith('/plugins/development/control')
              ? { kind: 'status', status: { roots: [], plugins: [] } }
            : request.url?.endsWith('/execute')
              ? { matched: true, result: { ok: true, result: { stored: 'hello' } } }
              : { kind: 'cancelled' },
        ));
      });
    });
    try {
      const { port } = await listen(server);
      home = await createTempDir('happier-plugin-control-client-');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'control-token',
      });
      const client = await import('./controlClient');

      await expect(client.requestDaemonPluginChange({
        kind: 'installPath',
        locator: '/tmp/plugin',
        development: false,
      })).resolves.toMatchObject({
        kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
        pendingChangeId: 'pending-1',
        review: { pluginId: 'acme.example' },
      });
      await expect(client.requestDaemonPluginChange({
        kind: 'installPath',
        locator: '/tmp/plugin-invalid',
        development: false,
      })).resolves.toEqual({
        kind: 'unavailable',
        code: 'daemon_invalid_response',
      });
      await client.decideDaemonPluginChange({
        pendingChangeId: 'pending-1',
        decision: 'cancel',
      });
      await expect(client.readDaemonPluginChangeStatus({
        pendingChangeId: 'pending-1',
      })).resolves.toEqual({
        kind: 'applying',
        pendingChangeId: 'pending-1',
      });
      await expect(client.controlDaemonPluginDevelopment({
        kind: 'registerExplicit',
        rootPath: './relative-plugin',
      })).resolves.toMatchObject({ kind: 'status' });
      await client.requestDaemonPluginActionExecution({
        actionId: 'acme.notes/store',
        input: { value: 'hello' },
        surface: 'cli',
      });
      await expect(client.requestDaemonPluginActionExecution({
        actionId: 'acme.older-daemon/run',
        input: {},
        surface: 'cli',
      })).resolves.toEqual({
        matched: true,
        result: {
          ok: false,
          errorCode: 'daemon_unavailable',
          error: 'Request failed: /plugins/actions/execute, HTTP 404',
        },
      });

      expect(observed).toEqual([
        {
          url: '/plugins/change/request',
          token: 'control-token',
          body: { kind: 'installPath', locator: '/tmp/plugin', development: false },
        },
        {
          url: '/plugins/change/request',
          token: 'control-token',
          body: { kind: 'installPath', locator: '/tmp/plugin-invalid', development: false },
        },
        {
          url: '/plugins/change/decide',
          token: 'control-token',
          body: {
            pendingChangeId: 'pending-1',
            decision: 'cancel',
          },
        },
        {
          url: '/plugins/change/status',
          token: 'control-token',
          body: { pendingChangeId: 'pending-1' },
        },
        {
          url: '/plugins/development/control',
          token: 'control-token',
          body: { kind: 'registerExplicit', rootPath: resolve('./relative-plugin') },
        },
        {
          url: '/plugins/actions/execute',
          token: 'control-token',
          body: {
            actionId: 'acme.notes/store',
            input: { value: 'hello' },
            surface: 'cli',
          },
        },
        {
          url: '/plugins/actions/execute',
          token: 'control-token',
          body: {
            actionId: 'acme.older-daemon/run',
            input: {},
            surface: 'cli',
          },
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('degrades a missing predecessor status route without resubmitting a plugin change', async () => {
    const observed: Array<{ url: string; token: string; body: unknown }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        observed.push({
          url: request.url ?? '',
          token: String(request.headers['x-happier-daemon-token'] ?? ''),
          body: JSON.parse(body),
        });
        response.statusCode = 404;
        response.end();
      });
    });
    try {
      const { port } = await listen(server);
      home = await createTempDir('happier-plugin-control-client-');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'control-token',
      });
      const client = await import('./controlClient');

      await expect(client.readDaemonPluginChangeStatus({
        pendingChangeId: 'pending-1',
      })).resolves.toEqual({ kind: 'daemonUnavailable' });
      expect(observed).toEqual([
        {
          url: '/plugins/change/status',
          token: 'control-token',
          body: { pendingChangeId: 'pending-1' },
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reads the outstanding pending changes and drops entries it cannot type', async () => {
    const review = createPluginInstallationReviewFixture();
    const observed: Array<{ url: string; body: unknown }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        observed.push({ url: request.url ?? '', body: JSON.parse(body) });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          changes: [
            {
              kind: 'reviewRequired', reviewKind: 'projectTrust',
              pendingChangeId: 'pending-1',
              review: { source: { kind: 'path', locator: '/tmp/agent-authored' } },
            },
            { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-2', review },
            { kind: 'applying', pendingChangeId: 'pending-3' },
            // A malformed review is dropped rather than shown to a user who
            // would be asked to approve a payload the client cannot read.
            { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-4', review: {} },
            { kind: 'terminal', pendingChangeId: 'pending-5' },
          ],
        }));
      });
    });
    try {
      const { port } = await listen(server);
      home = await createTempDir('happier-plugin-change-list-client-');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'control-token',
      });
      const client = await import('./controlClient');

      const listed = await client.listDaemonPluginChanges();
      expect(listed.changes.map((entry) => [entry.kind, entry.pendingChangeId])).toEqual([
        ['reviewRequired', 'pending-1'],
        ['reviewRequired', 'pending-2'],
        ['applying', 'pending-3'],
      ]);
      expect(observed).toEqual([{ url: '/plugins/change/list', body: {} }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports no outstanding pending changes when the daemon cannot answer', async () => {
    // Pending changes are in-memory daemon-lifetime state. An unreachable
    // daemon holds none, so enumeration degrades to "nothing to decide" rather
    // than to an error a settings screen would have to model.
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.statusCode = 404;
        response.end();
      });
    });
    try {
      const { port } = await listen(server);
      home = await createTempDir('happier-plugin-change-list-client-');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'control-token',
      });
      const client = await import('./controlClient');

      await expect(client.listDaemonPluginChanges()).resolves.toEqual({ changes: [] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reads additive tool projections while accepting an older catalog response without tools', async () => {
    let reads = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        reads += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(reads === 1
          ? {
              kind: 'available',
              plugins: [],
            }
          : {
              kind: 'available',
              plugins: [],
              tools: [{
                toolId: 'acme.review/tool',
                actionId: 'acme.review/run',
                name: 'acme_review_run',
                title: 'Run review',
                description: 'Run review',
                inputSchema: { type: 'object' },
                surfaces: ['cli', 'mcp', 'agent'],
              }],
            }));
      });
    });
    try {
      const { port } = await listen(server);
      home = await createTempDir('happier-plugin-catalog-control-client-');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'control-token',
      });
      const client = await import('./controlClient');

      await expect(client.readDaemonPluginCatalog()).resolves.toEqual({
        kind: 'available',
        plugins: [],
        tools: [],
      });
      await expect(client.readDaemonPluginCatalog()).resolves.toEqual({
        kind: 'available',
        plugins: [],
        tools: [{
          toolId: 'acme.review/tool',
          actionId: 'acme.review/run',
          name: 'acme_review_run',
          title: 'Run review',
          description: 'Run review',
          inputSchema: { type: 'object' },
          surfaces: ['cli', 'mcp', 'agent'],
        }],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses MCP startup with a typed dependency failure when the daemon catalog is unavailable', async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ kind: 'unavailable', code: 'daemon_unavailable' }));
      });
    });
    try {
      const { port } = await listen(server);
      home = await createTempDir('happier-mcp-catalog-failure-');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid, httpPort: port, startedAt: Date.now(),
        startedWithCliVersion: 'test', controlToken: 'control-token',
      });
      const { startHappyServer } = await import('@/mcp/startHappyServer');
      const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
      const { classifyPrimarySessionRuntimeIssue } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
      const outcome = await startHappyServer({
        sessionId: 'catalog-failure-session',
        getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example' }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'catalog-failure-session', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' }),
        updateMetadata: () => {},
      }).then((mcp) => { mcp.stop(); return null; }, (error: unknown) => error);
      expect(outcome).toMatchObject({ code: 'daemon_plugin_catalog_unavailable' });
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: outcome })).toMatchObject({
        code: 'daemon_plugin_catalog_unavailable', source: 'dependency_failure',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns a typed HTTP failure after the running MCP server loses its daemon catalog', async () => {
    let available = true;
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(available
          ? { kind: 'available', plugins: [], tools: [] }
          : { kind: 'unavailable', code: 'daemon_unavailable' }));
      });
    });
    let mcp: Awaited<ReturnType<typeof import('@/mcp/startHappyServer').startHappyServer>> | null = null;
    try {
      const { port } = await listen(server);
      home = await createTempDir('happier-mcp-catalog-lost-');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid, httpPort: port, startedAt: Date.now(),
        startedWithCliVersion: 'test', controlToken: 'control-token',
      });
      const { startHappyServer } = await import('@/mcp/startHappyServer');
      const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
      mcp = await startHappyServer({
        sessionId: 'catalog-lost-session',
        getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example' }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'catalog-lost-session', encryptionMode: 'plain' }),
        updateMetadata: () => {},
      });
      available = false;
      const response = await fetch(mcp.url, { method: 'POST', body: '{}' });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ errorCode: 'daemon_plugin_catalog_unavailable' });
    } finally {
      mcp?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});
