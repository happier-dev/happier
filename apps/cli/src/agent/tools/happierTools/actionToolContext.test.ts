import { getActionSpec } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { bindContextualActionToolInput, projectSessionBoundActionToolInputSchema } from './actionToolContext';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '@/daemon/local/services/preview/registry';
import { createLocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import { createLocalServicePublicPreviewServerRoutes } from '@/daemon/local/services/public/routes';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { DaemonLocalServicePublicPreviewCreateRequestV1Schema, DaemonLocalServicePublicPreviewRevokeRequestV1Schema, DaemonLocalServicePublicPreviewStatusRequestV1Schema, LocalServicePublicPreviewSnapshotV1Schema } from '@happier-dev/protocol/local/services/public/v1';

describe('session-bound Action tool context', () => {
  it('projects only session-owned Machine and workspace fields, keeping file operands and explicit scopes strict', () => {
    const context = { defaultSessionId: 'session', defaultSessionMachineId: 'session-machine', defaultSessionRootPath: '/repo' };
    for (const [actionId, input] of [
      ['code.definition.get', { path: 'a.ts', line: 1, symbol: 'example' }],
      ['code.codeAction.apply', { path: 'a.ts', operation: { kind: 'codeAction', expectedHash: 'a'.repeat(64),
        action: { serverId: 'server', title: 'Fix', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, files: [], hasCommand: false } } }],
      ['workspace.files.search', { query: 'example' }],
      ['workspace.files.replace.preview', { query: 'example', replacement: 'next' }],
      ['machines.processes.list', {}], ['machines.processes.check', { refs: ['process'] }],
      ['machines.processes.stop', { targets: [{ ref: 'process', expect: { level: 'proven' } }] }],
      ['machines.processes.kill', { targets: [{ ref: 'process', expect: { level: 'proven' } }], tree: true }],
      ['machines.processes.startAgain', { ref: 'process' }], ['machines.processes.leftBehind.cleanUp', { refs: ['process'] }],
    ] as const) {
      const schema = getActionSpec(actionId).inputSchema;
      const projected = projectSessionBoundActionToolInputSchema({ actionId, inputSchema: schema, context }) as z.ZodMiniType;
      expect(projected.safeParse(input).success, actionId).toBe(true);
      expect(schema.safeParse(bindContextualActionToolInput({ actionId, input, context })).success, actionId).toBe(true);
      expect(schema.safeParse(input).success, actionId).toBe(false);
      expect(projected.safeParse({ ...input, machineId: 42 }).success, actionId).toBe(false);
    }
    const input = { path: 'a.ts', line: 1, symbol: 'example' };
    expect(bindContextualActionToolInput({ actionId: 'code.definition.get', input: { ...input, machineId: 'other' }, context }))
      .toEqual({ ...input, machineId: 'other' });
    expect(bindContextualActionToolInput({ actionId: 'code.definition.get', input: { ...input, rootPath: '/explicit' }, context }))
      .toEqual({ ...input, rootPath: '/explicit', machineId: 'session-machine' });
    const schema = getActionSpec('code.definition.get').inputSchema;
    const projected = projectSessionBoundActionToolInputSchema({ actionId: 'code.definition.get', inputSchema: schema, context }) as z.ZodMiniType;
    expect(projected.safeParse({ line: 1, symbol: 'example' }).success).toBe(false);
    expect(projectSessionBoundActionToolInputSchema({ actionId: 'code.definition.get', inputSchema: schema, context: {} })).toBe(schema);
  });
  it.each([
    ['session.capabilities.get', {}],
    ['session.capabilities.set', { kind: 'mcp_server', id: 'catalog-server', state: 'on' }],
  ] as const)('defaults %s to the invoking session before strict input validation', (actionId, input) => {
    const context = { defaultSessionId: 'invoking-session' };
    const schema = getActionSpec(actionId).inputSchema;
    const projected = projectSessionBoundActionToolInputSchema({ actionId, inputSchema: schema, context }) as z.ZodMiniType;
    expect(projected.safeParse(input).success).toBe(true);
    expect(schema.parse(bindContextualActionToolInput({ actionId, input, context })))
      .toEqual({ ...input, sessionId: 'invoking-session' });
    expect(schema.parse(bindContextualActionToolInput({ actionId, input: { ...input, sessionId: 'another-session' }, context })))
      .toEqual({ ...input, sessionId: 'another-session' });
    expect(projectSessionBoundActionToolInputSchema({ actionId, inputSchema: schema, context: {} })).toBe(schema);
    expect(schema.safeParse(bindContextualActionToolInput({ actionId, input, context: {} })).success).toBe(false);
  });
  it('uses the page Session Machine for omitted Storage targets while preserving an explicitly requested Machine', () => {
    const context = { defaultSessionId: 'page-session', defaultSessionMachineId: 'page-machine' };
    const refs = [{ itemId: '/scanned/cache', path: '/scanned/cache' }];
    for (const [actionId, input] of [
      ['machines.storage.summary.get', {}], ['machines.storage.scan.get', { scanId: 'scan' }],
      ['machines.storage.items.check', { refs }], ['machines.storage.pile.set', { add: refs }],
    ] as const) {
      const schema = getActionSpec(actionId).inputSchema;
      expect(schema.parse(bindContextualActionToolInput({ actionId, input, context })))
        .toEqual({ ...input, machineId: context.defaultSessionMachineId });
      expect(bindContextualActionToolInput({ actionId, input: { ...input, machineId: 'explicit-machine' }, context }))
        .toEqual({ ...input, machineId: 'explicit-machine' });
      expect(schema.safeParse(bindContextualActionToolInput({ actionId, input, context: {} })).success).toBe(false);
    }
  });
  it('uses the current Session Machine for eligible Events while preserving an explicit target', () => {
    const actionId = 'workflow.events.list';
    const context = { defaultSessionId: 'session_current', defaultSessionMachineId: 'f8748a14-65ec-42f1-a3f9-4e70a63f793c' };
    const schema = getActionSpec(actionId).inputSchema;
    const projected = projectSessionBoundActionToolInputSchema({ actionId, inputSchema: schema, context }) as z.ZodMiniType;
    expect(projected.safeParse({}).success).toBe(true);
    expect(schema.parse(bindContextualActionToolInput({ actionId, input: {}, context })))
      .toEqual({ machineId: context.defaultSessionMachineId });
    expect(bindContextualActionToolInput({ actionId, input: { machineId: 'another-machine' }, context }))
      .toEqual({ machineId: 'another-machine' });
    expect(projectSessionBoundActionToolInputSchema({ actionId, inputSchema: schema, context: {} })).toBe(schema);
    expect(schema.safeParse(bindContextualActionToolInput({ actionId, input: {}, context: {} })).success).toBe(false);
  });
  it.each(['localServices.preview.openOrCreate', 'localServices.publicPreview.create', 'localServices.publicPreview.status',
    'localServices.publicPreview.revoke', 'localServices.publicPreview.copyUrl'] as const)(
    'preserves the actual sessionless service through contextual %s binding and execution', async actionId => {
      const context = { defaultSessionId: 'actual-invoking-session', defaultSessionMachineId: 'machine_1' };
      const owner = createManagedServicesOwner({
        processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
        // Native Project custody cannot reach plugin dependency installation.
        dependencies: Object.freeze({}) as never, resolveScope: scope => scope,
      });
      const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine_1', rootPath: process.cwd(), createdAtMs: 1 };
      const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'web' } };
      let stopped = false;
      const handle = await owner.superviseProject({ kind: 'workspace', workspace, declaration, cwd: workspace.rootPath,
        serviceId: 'web', specIdentity: 'web', isCurrent: () => true,
        requester: { serverId: 'home', accountId: 'starter', machineId: 'machine_1', installationId: 'installation' },
        processSpec: { mode: { kind: 'native',
          instance: { adapter: { pluginId: 'fixture.plugin', localId: 'web' }, nativeResourceId: 'exact-web' },
          // Only the native platform lifecycle is replaced; owner and supervisor remain real.
          lifecycle: { inspect: async () => ({ phase: stopped ? 'stopped' : 'running', readiness: 'ready', endpoint: 'http://127.0.0.1:5173' }),
            stop: async () => { stopped = true; return { status: 'stopped' }; } } } },
        authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, release: async () => undefined }),
      });
      try {
      const serviceTarget = { kind: 'managed_service' as const, machineId: 'machine_1', managedServiceId: handle.instanceId,
        workspaceId: workspace.id, cwd: workspace.rootPath, declaration };
      const resource = LocalServicePreviewResourceV1Schema.parse({ previewId: handle.instanceId, machineId: 'machine_1', serviceTarget,
        owner: { kind: 'user', id: 'starter' }, target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        initialPath: { pathname: '/', search: '' }, display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host' });
      const registry = createLocalServicePreviewRegistry();
      const registered = registerLocalServicePreview(registry, resource);
      if (!registered.ok) throw new Error(registered.reasonCode);
      const previewRoutes = createLocalServicePreviewRoutes({ machineId: 'machine_1', registry, projectManagedServices: owner, server: {
        token: 'owner-token', serverBaseUrl: 'https://home.example.test', http: {
          // Home HTTP is the boundary. Binding, Action validation and preview owners remain real.
          async post(_url, body) {
            const actual = LocalServicePreviewResourceV1Schema.parse(body);
            return { data: { resource: actual, accessUrl: 'https://actual-preview.example.test/?previewToken=own', expiresAt: 61_000 } };
          }, async delete() { return { data: { ok: true } }; },
        },
      } });
      const exposure = { exposureId: 'actual-public', previewId: resource.previewId, machineId: resource.machineId,
        serviceTarget, mode: 'secret_link' as const, state: 'active' as const,
        publicUrl: 'https://public.example.test/?publicToken=own', issuedAt: 1_000, expiresAt: 61_000,
        auditEventIds: [], rateLimitProfileId: 'default' };
      const snapshot = LocalServicePublicPreviewSnapshotV1Schema.parse({ v: 1, machineId: resource.machineId,
        previewId: resource.previewId, generatedAt: 2_000, refreshState: 'idle', policy: { enabled: true,
          allowedModes: ['secret_link'], maxTtlMs: 60_000, dnsTlsRequired: false, auditRequired: false, rateLimitProfileIds: [] },
        exposures: [exposure], diagnostics: [] });
      let returnedSnapshot = snapshot;
      const publicPreviewRoutes = createLocalServicePublicPreviewServerRoutes({ token: 'owner-token',
        serverBaseUrl: 'https://home.example.test', http: {
          async post(url, body) {
            if (url.endsWith('/status')) {
              DaemonLocalServicePublicPreviewStatusRequestV1Schema.parse(body);
              return { data: { protocolVersion: 1, snapshot: returnedSnapshot } };
            }
            DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse(body);
            return { data: { exposure } };
          }, async delete(_url, config) {
            DaemonLocalServicePublicPreviewRevokeRequestV1Schema.parse(config?.data);
            returnedSnapshot = LocalServicePublicPreviewSnapshotV1Schema.parse({ ...snapshot,
              exposures: [{ ...exposure, state: 'revoked', revokedAt: 3_000 }] });
            return { data: { ok: true } };
          },
        } });
      const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
        status: 'ready', features: FeaturesResponseSchema.parse({ features: { localServices: {
          enabled: true, inventory: { enabled: true }, preview: { enabled: true }, publicPreview: { enabled: true },
        }, browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }),
      }) });
      await featureGate.refresh();
      const execute = createLocalServicesDaemonRuntimeActionExecutor({ featureGate, routes: { previewRoutes, publicPreviewRoutes } });
      const input = { machineId: resource.machineId, serviceTarget,
        ...(actionId === 'localServices.preview.openOrCreate' ? { targetId: 'managed:web' }
          : actionId === 'localServices.publicPreview.status' ? { previewId: resource.previewId }
            : actionId === 'localServices.publicPreview.create' ? { previewId: resource.previewId,
              mode: 'secret_link', ttlMs: 60_000, confirmation: { acknowledged: true } }
              : { previewId: resource.previewId, exposureId: exposure.exposureId }) };
      if (actionId === 'localServices.publicPreview.status') {
        // The same by-id selector remains a supported Session adapter. Only an
        // explicit source-qualified arm may avoid its contextual Session scope.
        returnedSnapshot = LocalServicePublicPreviewSnapshotV1Schema.parse({ ...snapshot,
          sessionId: context.defaultSessionId, exposures: [{ ...exposure, serviceTarget: undefined,
            sessionId: context.defaultSessionId }] });
        const legacy = bindContextualActionToolInput({ actionId,
          input: { machineId: resource.machineId, previewId: resource.previewId }, context });
        expect(legacy).toMatchObject({ sessionId: context.defaultSessionId });
        await expect(execute({ actionId, input: legacy, context: { surface: 'ui' } })).resolves.toEqual(returnedSnapshot);
        returnedSnapshot = snapshot;
      }
      const bound = bindContextualActionToolInput({ actionId, input, context });
      const result = await execute({ actionId, input: bound, context: { surface: 'ui' } });
      expect(result).toMatchObject(actionId === 'localServices.preview.openOrCreate'
        ? { status: 'existing', preview: { resource: { serviceTarget }, accessUrl: 'https://actual-preview.example.test/?previewToken=own' } }
        : actionId === 'localServices.publicPreview.status' ? snapshot
          : actionId === 'localServices.publicPreview.revoke' ? { protocolVersion: 1, exposureId: exposure.exposureId,
            revokedAt: 3_000, snapshot: { exposures: [{ serviceTarget, state: 'revoked' }] } }
            : actionId === 'localServices.publicPreview.copyUrl' ? { protocolVersion: 1, publicUrl: exposure.publicUrl, serviceTarget }
              : { protocolVersion: 1, exposure: { serviceTarget, publicUrl: exposure.publicUrl } });
      expect(bound).not.toHaveProperty('sessionId');
      // The supported Session adapter still inherits omitted scope and preserves explicit scope.
      expect(bindContextualActionToolInput({ actionId, input: { machineId: 'machine_1', targetId: 'inventory-entry' }, context }))
        .toMatchObject({ sessionId: context.defaultSessionId });
      expect(bindContextualActionToolInput({ actionId, input: { machineId: 'machine_1', sessionId: 'explicit-session' }, context }))
        .toMatchObject({ sessionId: 'explicit-session' });
      } finally { await handle.stop(); await owner.dispose(); }
    },
  );

  it('binds the browser target to the invoking Happier session before input validation', () => {
    const schema = getActionSpec('browser.automation.snapshot').inputSchema;
    const input = {
      v: 1, automationRequestId: 'request', viewId: 'view', navigationGeneration: 0,
      requestedBy: 'agent', requesterRef: { kind: 'session', id: 'happier_session' },
      actionKind: 'snapshot', payload: {}, timeoutMs: 30_000,
    };
    const context = { defaultSessionId: 'happier_session' };
    const projected = projectSessionBoundActionToolInputSchema({
      actionId: 'browser.automation.snapshot', inputSchema: schema, context,
    }) as z.ZodMiniType;
    expect(projected.safeParse(input).success).toBe(true);
    expect(schema.safeParse(bindContextualActionToolInput({
      actionId: 'browser.automation.snapshot', input, context,
    })).data).toMatchObject({ browserSessionId: 'happier_session', viewId: 'view' });
    expect(bindContextualActionToolInput({
      actionId: 'browser.automation.snapshot', input: { browserSessionId: 'explicit', viewId: 'view' }, context,
    })).toEqual({ browserSessionId: 'explicit', viewId: 'view' });
    expect(bindContextualActionToolInput({
      actionId: 'browser.recording.stop', input: { recordingId: 'recording' }, context,
    })).toEqual({ recordingId: 'recording' });
    expect(projectSessionBoundActionToolInputSchema({
      actionId: 'browser.automation.snapshot', inputSchema: schema, context: {},
    })).toBe(schema);
  });

  it('preserves explicit detached execution-run scope while binding only omitted scope', () => {
    expect(bindContextualActionToolInput({
      actionId: 'execution.run.start',
      input: { sessionId: null },
      context: { defaultSessionId: 'session_current' },
    })).toEqual({ sessionId: null });
    expect(bindContextualActionToolInput({
      actionId: 'execution.run.start',
      input: {},
      context: { defaultSessionId: 'session_current' },
    })).toEqual({ sessionId: 'session_current' });
  });

  it('preserves sessionless Project Start selection without replacing an explicit Session adapter scope', () => {
    const input = { machineId: 'machine-1', targetId: 'project-service:selected',
      workspace: { serverId: 'home-1', machineId: 'machine-1', workspaceId: 'accepted', rootPath: '/accepted' },
      declaration: { workspaceRefId: 'accepted', selection: { kind: 'manifest', name: 'web' } } };
    const context = { defaultSessionId: 'cli-global' };
    expect(bindContextualActionToolInput({ actionId: 'localServices.launcher.start', input, context })).toEqual(input);
    expect(bindContextualActionToolInput({ actionId: 'localServices.launcher.start',
      input: { ...input, sessionId: 'actual-invoking-session' }, context,
    })).toEqual({ ...input, sessionId: 'actual-invoking-session' });
  });

  it('optionalizes only the built-in fields whose declared host context is available', () => {
    const search = projectSessionBoundActionToolInputSchema({
      actionId: 'memory.search',
      inputSchema: getActionSpec('memory.search').inputSchema,
      context: { defaultSessionId: 'current-session', defaultSessionMachineId: 'machine-1' },
    }) as z.ZodMiniType;
    expect(search.safeParse({
      query: { v: 1, query: 'handoff', scope: { type: 'global' }, mode: 'hints' },
    }).success).toBe(true);
  });

  it('projects contextual Machine scope across both real memory window union arms without weakening their scope', () => {
    const schema = getActionSpec('memory.get_window').inputSchema;
    const context = { defaultSessionId: 'current-session', defaultSessionMachineId: 'machine-1' };
    const window = projectSessionBoundActionToolInputSchema({
      actionId: 'memory.get_window', inputSchema: schema, context,
    }) as z.ZodMiniType;
    const native = { source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
      sourceItemId: 'message', cursor: 'older' };
    const historical = { sessionId: 'historical-session', seqFrom: 1, seqTo: 2 };
    expect(window.safeParse({ seqFrom: 1, seqTo: 2 }).success).toBe(false);
    for (const input of [historical, native]) {
      expect(window.safeParse(input).success).toBe(true);
      expect(schema.parse(bindContextualActionToolInput({ actionId: 'memory.get_window', input, context })))
        .toEqual({ ...input, machineId: context.defaultSessionMachineId });
      expect(window.parse({ ...input, machineId: 'explicit-machine' })).toMatchObject({ machineId: 'explicit-machine' });
    }
    expect(window.safeParse({ ...native, seqFrom: 1, seqTo: 2 }).success).toBe(false);
    expect(projectSessionBoundActionToolInputSchema({ actionId: 'memory.get_window', inputSchema: schema, context: {} })).toBe(schema);
  });

  it('projects the same contextual schema for a trusted plugin Action tool', () => {
    const pluginToolCatalog: readonly ProjectedPluginToolCatalogEntry[] = [{
      toolId: 'acme.memory/search-tool',
      actionId: 'acme.memory/actions/search',
      name: 'acme_memory_search',
      title: 'Search Acme memory',
      description: 'Search memory.',
      inputSchema: {
        type: 'object',
        properties: { machineId: { type: 'string' }, query: { type: 'string' } },
        required: ['machineId', 'query'],
        additionalProperties: false,
      },
      contextualDefaults: { machineId: 'current_session_machine' },
      surfaces: ['agent'],
    }];

    expect(projectSessionBoundActionToolInputSchema({
      actionId: 'acme.memory/actions/search',
      inputSchema: pluginToolCatalog[0]!.inputSchema,
      context: { defaultSessionMachineId: 'machine-1' },
      pluginToolCatalog,
    })).toMatchObject({ required: ['query'] });
  });
});
