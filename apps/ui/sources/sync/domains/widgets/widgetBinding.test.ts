import { describe, expect, it } from 'vitest';
import { resolveConfiguredWidgetTarget } from './widgetBinding';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveConfiguredWidgetInputs, readBuiltinWidgetDescriptorV1, WidgetDefinitionV1Schema, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { widgetProjectionOf, widgetInstalledPackage } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { resolveInstalledWidgetMount } from '@/components/widgets/installedWidgetMount';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { readProjectWidgetAreaContextV1 } from './projectWidgetAreaContext';
import '@/sync/syncEngine';

const runtime = (serverId: string, machineId: string): PluginUiProjectionCurrentness => ({
  serverId, machineId, phase: 'current', interactionEnabled: true, platform: 'web',
  pluginUiProjection: null, pluginBrowserProjection: null, accountLifetime: null,
});
const session = (id: string, serverId = 'home'): Session => createSessionFixture({ id, serverId });

describe('configured widget executable target', () => {
  it('uses the admitted Project target on its own dashboard without borrowing an App or Session target', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://project-widget.test', accountId: 'viewer' });
    try {
      const lifetime = captureActiveServerAccountScopeLifetime()!;
      const checkout = { serverId: connection.home.id, id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
      const project = readProjectWidgetAreaContextV1({ serverId: connection.home.id, projectRef: checkout, activeCheckout: checkout, authority: lifetime });
      expect(project.target).not.toBeNull();
      const input = { scope: { ...lifetime.scope, owner: { kind: 'project' as const, projectId: project.target!.projectKey } },
        definition: { kind: 'installed' as const, surface: { pluginId: 'acme.project', localId: 'status' } },
        descriptor: {}, targetKind: 'project' as const, projectContext: project,
        appRuntime: { ...runtime(connection.home.id, 'machine'), accountLifetime: lifetime },
        resolvedInput: { status: 'ready' as const, input: {} },
        readSession: () => { throw new Error('Project widgets must not read Session context'); } };
      const result = resolveConfiguredWidgetTarget(input);
      expect(result).toMatchObject({ status: 'ready', target: project.target });
      if (result.status === 'ready') expect(result.target).toBe(project.target);
      if (result.status === 'ready') expect(result.projectContext).toBe(project);
      expect(resolveConfiguredWidgetTarget({ ...input, projectContext: null })).toMatchObject({ status: 'unavailable' });
      expect(resolveConfiguredWidgetTarget({ ...input, scope: { ...input.scope, owner: { kind: 'home' } } })).toMatchObject({ status: 'denied' });
      expect(resolveConfiguredWidgetTarget({ ...input, scope: { ...input.scope, owner: { kind: 'project', projectId: 'other' } } })).toMatchObject({ status: 'denied' });
      expect(resolveConfiguredWidgetTarget({ ...input, projectContext: { ...project, scope: { ...project.scope, serverId: 'another-home' } } })).toMatchObject({ status: 'denied' });
      expect(resolveConfiguredWidgetTarget({ ...input, projectContext: { ...project, scope: { ...project.scope, authority: { isCurrent: () => false } } } })).toMatchObject({ status: 'denied' });
      const nextAccount = await restoreServerAccountForTest({ serverUrl: 'https://project-widget.test', accountId: 'another-viewer' });
      try {
        const nextLifetime = captureActiveServerAccountScopeLifetime()!;
        expect(nextLifetime.isCurrent()).toBe(true);
        expect(lifetime.isCurrent()).toBe(false);
        expect(resolveConfiguredWidgetTarget({ ...input,
          scope: { ...input.scope, accountId: nextLifetime.scope.accountId },
          appRuntime: { ...input.appRuntime, accountLifetime: nextLifetime },
        })).toMatchObject({ status: 'denied', reasonCode: 'widget_target_scope_mismatch' });
      } finally { await nextAccount.dispose(); }
      await connection.dispose();
      expect(resolveConfiguredWidgetTarget(input)).toMatchObject({ status: 'denied' });
    } finally { await connection.dispose(); }
  });

  it('admits an installed Home widget from its current Account projection without inventing a union machine', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://home-widget-union.test', accountId: 'viewer' });
    try {
      const lifetime = captureActiveServerAccountScopeLifetime()!;
      const definition = { kind: 'installed', surface: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'latest' } } as const;
      const union = unionPluginUiProjections([
        { machineId: 'origin-a', serverId: connection.home.id, phase: 'current', interactionEnabled: true,
          projection: widgetProjectionOf([{ ...definition.surface, target: 'app', homeDefault: 'shown' }], {
            [definition.surface.pluginId]: widgetInstalledPackage(definition.surface.pluginId, 'PRs & Issues'),
          }) },
        { machineId: 'origin-b', serverId: connection.home.id, phase: 'current', interactionEnabled: true, projection: EMPTY_PLUGIN_UI_PROJECTION },
      ]);
      const descriptor = readWidgetDescriptor(union.pluginUiProjection, definition)!;
      expect(descriptor).not.toBeNull();
      const appRuntime = { ...runtime(connection.home.id, 'unused'), ...union, accountLifetime: lifetime };
      expect(appRuntime.serverId).toBeNull();
      expect(appRuntime.machineId).toBeNull();
      const input = { scope: { serverId: connection.home.id, accountId: 'viewer', owner: { kind: 'home' as const } },
        definition, descriptor, targetKind: 'app' as const, appRuntime, resolvedInput: { status: 'ready' as const, input: {} },
        readSession: () => { throw new Error('The app widget must not borrow a Session'); } };
      const admitted = resolveConfiguredWidgetTarget(input);
      expect(admitted).toMatchObject({ status: 'ready', target: { kind: 'app' }, runtime: appRuntime });
      // The exact installed identity still resolves through the canonical mount selector.
      expect(resolveInstalledWidgetMount({ source: { kind: 'installedSurface', surface: definition.surface }, target: 'app',
        presentation: 'content', runtime: appRuntime }).placement?.pluginId).toBe(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1);
      expect(resolveConfiguredWidgetTarget({ ...input, scope: { ...input.scope, serverId: 'foreign-home' } }))
        .toMatchObject({ status: 'denied', reasonCode: 'widget_target_scope_mismatch' });
      await connection.dispose();
      expect(resolveConfiguredWidgetTarget(input)).toMatchObject({ status: 'denied', reasonCode: 'widget_target_scope_mismatch' });
    } finally { await connection.dispose(); }
  });

  it('admits a saved native Session body without plugin runtime identity and retains Session denial', () => {
    const native = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'changes' })!;
    const body = { kind: 'builtin', id: 'changes' } as const;
    const selected = session('B');
    const nativeRuntime = { ...runtime('home', 'machine'), serverId: null, machineId: null };
    const input = { scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } },
      definition: { kind: 'artifact' as const, artifactId: 'saved-changes' }, authoredBody: body,
      descriptor: native, targetKind: 'session' as const,
      resolvedInput: { status: 'ready' as const, input: { session: { serverId: 'home', sessionId: 'B' } } },
      appRuntime: nativeRuntime, readSession: () => ({ status: 'ready' as const, session: selected, runtime: nativeRuntime }) };
    expect(resolveConfiguredWidgetTarget(input)).toMatchObject({ status: 'ready', target: { kind: 'session', sessionId: 'B' } });
    expect(resolveConfiguredWidgetTarget({ ...input, readSession: () => ({ status: 'denied', reasonCode: 'widget_session_access_denied' }) }))
      .toMatchObject({ status: 'denied', reasonCode: 'widget_session_access_denied' });
    expect(resolveConfiguredWidgetTarget({ ...input, readSession: () => ({ status: 'ready', session: session('B', 'other-home'), runtime: nativeRuntime }) }))
      .toMatchObject({ status: 'denied', reasonCode: 'widget_target_identity_mismatch' });
  });
  it('uses the same Home identity for portable Session inputs and local executable facts', async () => {
    const serverIdentityId = 'srv_0123456789abcdefghijklmnopqrstuv';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-target-alias.test', serverIdentityId, accountId: 'viewer' });
    try {
      const serverId = connection.home.id;
      const b = session('B', serverId);
      const input = { scope: { serverId, accountId: 'viewer', owner: { kind: 'home' as const } },
        definition: { kind: 'builtin' as const, id: 'session_summary' }, targetKind: 'session' as const,
        descriptor: readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'session_summary' })!,
        resolvedInput: { status: 'ready' as const, input: { session: { serverId: serverIdentityId, sessionId: 'B' } } },
        appRuntime: runtime(serverId, 'machine'), readSession: () => ({ status: 'ready' as const, session: b, runtime: runtime(serverId, 'machine') }) };
      expect(resolveConfiguredWidgetTarget(input)).toMatchObject({ status: 'ready', target: { kind: 'session', sessionId: 'B', session: b } });
      expect(resolveConfiguredWidgetTarget({ ...input, resolvedInput: { status: 'ready', input: { session: { serverId: 'other-home', sessionId: 'B' } } } }))
        .toMatchObject({ status: 'denied', reasonCode: 'widget_target_scope_mismatch' });
      expect(resolveConfiguredWidgetTarget({ ...input, readSession: () => ({ status: 'ready', session: session('B', 'other-home'), runtime: runtime(serverId, 'machine') }) }))
        .toMatchObject({ status: 'denied', reasonCode: 'widget_target_identity_mismatch' });
      const checkout = { serverId, id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
      expect(resolveConfiguredWidgetTarget({ ...input, definition: { kind: 'builtin', id: 'project_code' }, targetKind: 'app',
        descriptor: readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' })!, workspaceRefs: [checkout], providedContext: { checkout: [checkout] },
        resolvedInput: { status: 'ready', input: { checkout: { ...checkout, serverId: serverIdentityId } } } }))
        .toMatchObject({ status: 'ready', target: { kind: 'workspace', checkout } });
    } finally { await connection.dispose(); }
  });
  it('admits native app reads in the captured Account without borrowing a daemon or Session', () => {
    const input = { scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } },
      definition: { kind: 'builtin' as const, id: 'app-read-fixture' }, targetKind: 'app' as const,
      descriptor: { inputs: { fields: [{ path: 'period', title: 'Period', widget: 'integer' as const }] } },
      appRuntime: { ...runtime('home', 'machine'), serverId: null, machineId: null },
      resolvedInput: { status: 'ready' as const, input: { period: 7 } },
      readSession: () => { throw new Error('App inputs never grant Session authority'); } };
    expect(resolveConfiguredWidgetTarget(input)).toMatchObject({ status: 'ready', target: { kind: 'app' }, input: { period: 7 } });
    expect(resolveConfiguredWidgetTarget({ ...input, resolvedInput: { status: 'denied', fields: [{ path: 'period', status: 'denied', reasonCode: 'read_retired' }] } }))
      .toMatchObject({ status: 'denied', reasonCode: 'read_retired' });
  });

  it('admits declared Session and Workspace targets through their exact authority', () => {
    const checkout = { serverId: 'home', id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
    const base = { scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } },
      targetKind: 'app' as const, appRuntime: { ...runtime('home', 'machine'), serverId: null },
      providedContext: { checkout: [checkout] }, workspaceRefs: [checkout], readSession: () => { throw new Error('No Session for a checkout'); } };
    expect(resolveConfiguredWidgetTarget({ ...base, definition: { kind: 'builtin', id: 'project_code' },
      descriptor: readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' })!, resolvedInput: { status: 'ready', input: { checkout } } }))
      .toMatchObject({ status: 'ready', target: { kind: 'workspace', checkout } });
    const source = { serverId: 'home', sessionId: 'B' };
    const descriptor = { inputs: { fields: [{ path: 'source', title: 'Source', widget: 'json' as const, inputType: { hostType: 'session' as const } }] } };
    const selected = session('B');
    expect(resolveConfiguredWidgetTarget({ ...base, descriptor, definition: { kind: 'builtin', id: 'session_summary' },
      resolvedInput: { status: 'ready', input: { source: { ...source, retired: true } } },
      readSession: () => ({ status: 'ready', session: selected, runtime: runtime('home', 'machine') }) }))
      .toMatchObject({ status: 'ready', target: { kind: 'session', sessionId: 'B' } });
    expect(resolveConfiguredWidgetTarget({ ...base, descriptor, definition: { kind: 'builtin', id: 'session_summary' },
      resolvedInput: { status: 'ready', input: { source } }, readSession: () => ({ status: 'denied', reasonCode: 'widget_session_access_denied' }) }))
      .toMatchObject({ status: 'denied', reasonCode: 'widget_session_access_denied' });
  });
  it('admits the exact authorized checkout on every host without borrowing AppShell or trusting page values', () => {
    const checkout = { serverId: 'home', id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0,
      repositoryIdentity: { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/repo' } };
    const base = { scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'project' as const, projectId: 'stable-project' } },
      definition: { kind: 'builtin' as const, id: 'project_code' }, targetKind: 'app' as const,
      descriptor: readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'project_code' })!, providedContext: { checkout: [checkout], project: [] }, workspaceRefs: [checkout],
      resolvedInput: { status: 'ready' as const, input: { checkout } }, appRuntime: runtime('home', 'machine'),
      readSession: () => { throw new Error('Project widgets must not request a Session'); } };
    expect(resolveConfiguredWidgetTarget(base)).toMatchObject({ status: 'ready', target: { kind: 'workspace', checkout, workspace: {
      serverId: 'home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/repo' } } });
    expect(resolveConfiguredWidgetTarget({ ...base, resolvedInput: { status: 'ready', input: { checkout: { ...checkout, rootPath: '/other' } } } }))
      .toMatchObject({ status: 'denied', reasonCode: 'widget_target_identity_mismatch' });
    expect(resolveConfiguredWidgetTarget({ ...base, appRuntime: { ...runtime('home', 'other-machine'), serverId: null, machineId: null } }))
      .toMatchObject({ status: 'ready', target: { kind: 'workspace', workspace: { serverId: 'home', machineId: 'machine' } } });
    expect(resolveConfiguredWidgetTarget({ ...base, resolvedInput: { status: 'ready', input: { checkout: { ...checkout, serverId: 'other-home' } } } }))
      .toMatchObject({ status: 'denied', reasonCode: 'widget_target_scope_mismatch' });
    expect(resolveConfiguredWidgetTarget({ ...base, resolvedInput: { status: 'ready', input: { checkout: { ...checkout, rootPath: '/repo/' } } } }))
      .toMatchObject({ status: 'ready', target: { kind: 'workspace', workspace: { rootPath: '/repo' } } });
    for (const owner of [{ kind: 'home' }, { kind: 'workBoard', boardId: 'board' },
      { kind: 'pluginArea', pluginId: 'acme.page', pageId: 'page', area: 'main' }, { kind: 'corePage', pageId: 'usage', area: 'main' }] as const) {
      expect(resolveConfiguredWidgetTarget({ ...base, scope: { ...base.scope, owner }, providedContext: {} }))
        .toMatchObject({ status: 'ready', target: { kind: 'workspace', checkout } });
    }
    expect(resolveConfiguredWidgetTarget({ ...base, workspaceRefs: [] }))
      .toMatchObject({ status: 'denied', reasonCode: 'widget_target_identity_mismatch' });
    expect(resolveConfiguredWidgetTarget({ ...base, workspaceRefs: [checkout, checkout] }))
      .toMatchObject({ status: 'denied', reasonCode: 'widget_target_identity_mismatch' });
  });
  it('admits the saved inputless constant on every host without borrowing a machine scope', () => {
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'qa-e-semantic-sizes', name: 'QA E semantic sizes',
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'A constant body' } } },
      sizeDeclaration: { sizes: ['small', 'tall'], defaultSize: 'tall' }, provenance: { source: { kind: 'authored' } } });
    const instance: WidgetInstanceV1 = { v: 1, id: 'saved-copy', definition: { kind: 'artifact', artifactId: 'qa-definition' }, bindings: {} };
    const owners = [
      { kind: 'home' }, { kind: 'sessionBoard', sessionId: 'A' }, { kind: 'companion', sessionId: 'A' },
      { kind: 'workBoard', boardId: 'board' }, { kind: 'pluginArea', pluginId: 'acme.page', pageId: 'page', area: 'pinned' },
    ] as const;
    for (const owner of owners) {
      const appRuntime: PluginUiProjectionCurrentness = { ...runtime('home', 'machine'), serverId: null, machineId: null };
      const input = { scope: { serverId: 'home', accountId: 'viewer', owner }, definition: instance.definition,
        descriptor: definition, authoredBody: definition.body, targetKind: 'app' as const, appRuntime,
        resolvedInput: resolveConfiguredWidgetInputs({ instance, descriptor: definition, providedContext: {}, viewerValues: {} }),
        readSession: () => { throw new Error('A constant must not request a Session'); } };
      expect(resolveConfiguredWidgetTarget(input)).toMatchObject({ status: 'ready', target: { kind: 'app' }, runtime: appRuntime, input: {} });
    }
  });

  it('still denies an executable app contribution with absent or foreign runtime scope', () => {
    for (const serverId of [null, 'other-home']) {
      expect(resolveConfiguredWidgetTarget({ scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
        definition: { kind: 'installed', surface: { pluginId: 'acme.metrics', localId: 'widget' } },
        descriptor: {}, targetKind: 'app', resolvedInput: { status: 'ready', input: {} }, appRuntime: { ...runtime('home', 'machine'), serverId },
        readSession: () => { throw new Error('No Session input'); },
      })).toEqual({ status: 'denied', reasonCode: 'widget_target_scope_mismatch' });
    }
  });
  it('admits HTML copies in the viewer Account without inventing an AppShell machine', () => {
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'html-copy', name: 'HTML',
      inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
      body: { kind: 'html', source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPkNvcHk8L2gxPg==' } } } },
      sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, provenance: { source: { kind: 'authored' } } });
    const result = resolveConfiguredWidgetTarget({ scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
      definition: { kind: 'inline', definition }, authoredBody: definition.body, descriptor: definition, targetKind: 'app',
      resolvedInput: { status: 'ready', input: {} }, appRuntime: { ...runtime('home', 'machine'), serverId: null, machineId: null },
      readSession: () => { throw new Error('HTML content grants no Session access'); } });
    expect(result).toMatchObject({ status: 'ready', target: { kind: 'app' }, input: {} });
  });
  it('retains the failed pinned value and field identity as a typed repair outcome', () => {
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' },
      bindings: { repo: { kind: 'value', value: 'removed-repo' } } };
    const descriptor = { inputs: { fields: [{ path: 'repo', title: 'Repository', widget: 'select' as const,
      options: [{ value: 'removed-repo', label: 'Old repository' }] }] },
      inputSchema: { type: 'object' as const, properties: { repo: { type: 'string' as const, enum: ['active-repo'] } } } };
    const resolvedInput = resolveConfiguredWidgetInputs({ instance, descriptor, providedContext: {}, viewerValues: {} });
    const result = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } }, resolvedInput,
      descriptor, targetKind: 'app', appRuntime: runtime('home', 'machine'), repairContext: { instance, descriptor },
      readSession: () => { throw new Error('an invalid pin must never read a Session'); },
    });
    expect(result).toMatchObject({ status: 'invalid', repair: { kind: 'input',
      field: { path: 'repo', label: 'Repository', selectedLabel: 'Old repository' } } });
  });

  it('preserves denied and missing exact Session facts even when they carry repair fields', () => {
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' },
      bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } } };
    const descriptor = { sessionInputPath: 'session', inputs: { fields: [{ path: 'session', title: 'Source session', widget: 'select' as const,
      options: [{ value: { serverId: 'home', sessionId: 'B' }, label: 'Build release' }] }] } };
    for (const status of ['denied', 'unavailable'] as const) {
      const reasonCode = status === 'denied' ? 'widget_session_access_denied' : 'widget_session_unavailable';
      const result = resolveConfiguredWidgetTarget({
        scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'companion', sessionId: 'A' } },
        resolvedInput: { status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } },
        targetKind: 'session', descriptor, appRuntime: runtime('home', 'machine-A'),
        repairContext: { instance, descriptor },
        readSession: () => ({ status, reasonCode, fields: [{ path: 'session', status, reasonCode }] }),
      });
      expect(result).toMatchObject({ status, repair: { kind: status === 'denied' ? 'session_denied' : 'session_unavailable',
        field: { path: 'session', label: 'Source session', selectedLabel: 'Build release' } } });
    }
    const noLongerInChoices = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
      resolvedInput: { status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } },
      targetKind: 'session', descriptor, appRuntime: runtime('home', 'machine'),
      repairContext: { instance, descriptor: { ...descriptor, inputs: { fields: [{ ...descriptor.inputs.fields[0]!, options: [] }] } } },
      readSession: () => ({ status: 'unavailable', reasonCode: 'widget_session_unavailable',
        fields: [{ path: 'session', status: 'unavailable', reasonCode: 'widget_session_unavailable' }] }),
    });
    expect(noLongerInChoices).toMatchObject({ repair: { kind: 'session_unavailable', field: { label: 'Source session' } } });
    if (noLongerInChoices.status !== 'unavailable') throw new Error('Expected an unavailable Session');
    expect(noLongerInChoices.repair?.field).not.toHaveProperty('selectedLabel');
  });

  it('keeps secret values out of the repair outcome, including their option labels', () => {
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'checks' },
      bindings: { token: { kind: 'value', value: 'private-token' } } };
    const descriptor = { inputs: { fields: [{ path: 'token', title: 'Token', widget: 'secret' as const,
      options: [{ value: 'private-token', label: 'private-token' }] }] } };
    const result = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } },
      resolvedInput: resolveConfiguredWidgetInputs({ instance, descriptor, providedContext: {}, viewerValues: {} }),
      descriptor, targetKind: 'app', appRuntime: runtime('home', 'machine'), repairContext: { instance, descriptor },
      readSession: () => { throw new Error('secret bindings cannot execute'); },
    });
    expect(result).toMatchObject({ status: 'invalid', repair: { kind: 'input', field: { path: 'token', label: 'Token' } } });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it('uses selected B data and runtime when hosted in A or Home, without ambient authority', () => {
    const b = session('B');
    const bRuntime = runtime('home', 'machine-B');
    const result = resolveConfiguredWidgetTarget({
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'companion', sessionId: 'A' } },
      resolvedInput: { status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } },
      descriptor: { sessionInputPath: 'session' }, appRuntime: runtime('home', 'machine-A'),
      targetKind: 'session',
      readSession: () => ({ status: 'ready', session: b, runtime: bRuntime }),
    });
    expect(result).toMatchObject({ status: 'ready', target: { kind: 'session', sessionId: 'B', session: b }, runtime: bRuntime });
  });

  it('refuses missing, cross-Home, revoked or mismatched target facts without invoking fallback', () => {
    const base = {
      scope: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } },
      resolvedInput: { status: 'ready' as const, input: { session: { serverId: 'home', sessionId: 'B' } } },
      descriptor: { sessionInputPath: 'session' }, appRuntime: runtime('home', 'machine-A'),
      targetKind: 'session' as const,
    };
    expect(resolveConfiguredWidgetTarget({ ...base, readSession: () => ({ status: 'denied', reasonCode: 'session_access_denied' }) })).toEqual({ status: 'denied', reasonCode: 'session_access_denied' });
    expect(resolveConfiguredWidgetTarget({ ...base, readSession: () => ({ status: 'ready', session: session('A'), runtime: runtime('home', 'machine-A') }) })).toMatchObject({ status: 'denied' });
    expect(resolveConfiguredWidgetTarget({ ...base, resolvedInput: { status: 'ready', input: {} }, readSession: () => { throw new Error('must not read without a target'); } })).toMatchObject({ status: 'selection_required' });
    expect(resolveConfiguredWidgetTarget({ ...base, resolvedInput: { status: 'ready', input: { session: { serverId: 'other-home', sessionId: 'B' } } }, readSession: () => { throw new Error('must not borrow another Home'); } })).toMatchObject({ status: 'denied' });
  });
});
