import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { WidgetDefinitionDraftV1Schema, WidgetPublicSnapshotPresentationV1Schema } from '@happier-dev/protocol/widgets';

import { renderHook } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readUsageWidgetPageContext, readUsageWidgetPageScope, usageWidgetSurfaceContext } from '@/components/settings/usage/usageWidgetPageContext';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import type { AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { widgetInstalledPackage, widgetProjectionEntry, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { EMPTY_PLUGIN_UI_PROJECTION, normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
  'widgets.item.add': ['ui'], 'widgets.area.layout.create': ['ui'], 'widgets.item.remove': ['ui'],
  'widgets.definition.create': ['ui'], 'widgets.definition.update': ['ui'],
} });
let failReads = false;
let readGate: Promise<void> | null = null;
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: policy } }, version: 0 });
  if (/^\/v1\/artifacts\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET') {
    if (readGate) await readGate;
    if (failReads) return Response.json({ error: 'Artifact read unavailable' }, { status: 500 });
  }
  return artifacts.handle(path + new URL(String(url)).search, init);
} });

// Collection owns the full real executor graph; hooks only initialize this suite's consumers.
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeLoader = await installRealActionExecutorModuleLoader();
let usePublicProfileWidgetArea: typeof import('./usePublicProfileWidgetArea')['usePublicProfileWidgetArea'];
let useMountedActionExecution: typeof import('@/components/approvals/useMountedActionExecution')['useMountedActionExecution'];
let AppShellPluginUiProjectionValueProvider: typeof import('@/components/appShell/plugins/AppShellPluginUiProjection')['AppShellPluginUiProjectionValueProvider'];
beforeAll(async () => {
  ({ usePublicProfileWidgetArea } = await import('./usePublicProfileWidgetArea'));
  ({ useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution'));
  ({ AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection'));
});
afterAll(() => disposeLoader());
beforeEach(() => {
  artifacts.clear(); failReads = false; readGate = null;
  storage.setState({ settingsScope: { serverId: runtime.serverId, accountId: 'account-a' },
    settings: { ...storage.getState().settings, actionsSettingsV1: policy } });
});

async function openArea(context?: () => WidgetSurfaceContext, wrapper?: React.ComponentType<React.PropsWithChildren>) {
  return renderHook(() => {
    const execution = useMountedActionExecution({ serverId: runtime.serverId, accountId: 'account-a' });
    return { ...usePublicProfileWidgetArea(runtime.serverId, execution, undefined, context?.()), execution };
  }, { wrapper });
}

function declarationValue(projection = EMPTY_PLUGIN_UI_PROJECTION): AppShellPluginUiProjectionValue {
  return { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
    machineId: null, serverId: runtime.serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
    reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {} };
}

function installedDaysProjection(label: string | null, unrelated = false) {
  const days = { ...widgetProjectionEntry({ pluginId: 'acme.public', localId: 'days', target: 'app', title: 'Shared days',
    inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } }),
    publicPresentation: WidgetPublicSnapshotPresentationV1Schema.parse({ kind: 'declarative', document: { version: 1,
      root: { kind: 'metric', label: label ?? 'Active days', data: { kind: 'value', value: { kind: 'public_profile' } },
        value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } }) };
  const entries = [...(label === null ? [] : [days]), ...(unrelated
    ? [widgetProjectionEntry({ pluginId: 'acme.other', localId: 'unrelated', target: 'app' })] : [])];
  return normalizePluginUiProjection({ v: 2, generation: unrelated ? 2 : 1,
    installedPackagesById: { 'acme.public': widgetInstalledPackage('acme.public', 'Public facts'),
      // Gallery provenance changes, but this installed View's reviewed public copy does not.
      ...(unrelated ? { 'acme.other': widgetInstalledPackage('acme.other', 'Public facts') } : {}) },
    agentsById: {}, actionsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
    familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(entries.map(entry => [entry.id, entry])) } } });
}

it('preserves the captured builtin copy across declaration readiness and unrelated projection publications', async () => {
  let value = declarationValue();
  let declarationReady = false;
  const wrapper = ({ children }: React.PropsWithChildren) => <AppShellPluginUiProjectionValueProvider value={value}
    declarationReady={declarationReady}>{children}</AppShellPluginUiProjectionValueProvider>;
  const hook = await openArea(undefined, wrapper);
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const captured = hook.getCurrent().candidate!;
    const execution = hook.getCurrent().execution;
    const selected = hook.getCurrent().area.state;
    if (selected.status !== 'ready') throw new Error('Expected admitted private widget area');
    expect(captured).toHaveProperty('selection', { v: 1, surface: selected.surface, items: selected.items });
    expect(captured.layout.items.map(item => item.id)).toEqual(['totals', 'days', 'crew', 'planet']);
    declarationReady = true;
    await hook.rerender();
    value = { ...value, pluginUiProjection: widgetProjectionOf([{ pluginId: 'acme.unrelated', localId: 'status', target: 'app' }],
      { 'acme.unrelated': widgetInstalledPackage('acme.unrelated', 'Unrelated') }) };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    expect(execution.isCurrent()).toBe(true);
    expect(execution.getSignal().aborted).toBe(false);
  } finally { await hook.unmount(); }
});

it('recompiles changed installed declarations while keeping the captured copy independent', async () => {
  let value = declarationValue(installedDaysProjection('Active days'));
  const wrapper = ({ children }: React.PropsWithChildren) => <AppShellPluginUiProjectionValueProvider value={value}>
    {children}</AppShellPluginUiProjectionValueProvider>;
  const hook = await openArea(undefined, wrapper);
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    await act(async () => {
      expect(await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.add', size: 'medium',
        instance: { v: 1, id: 'installed-days', definition: { kind: 'installed', surface: { pluginId: 'acme.public', localId: 'days' } }, bindings: {} },
      })).toMatchObject({ ok: true });
      await hook.getCurrent().area.reload();
    });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toContainEqual(expect.objectContaining({ id: 'installed-days', title: 'Shared days' })));
    const captured = hook.getCurrent().candidate!;
    value = { ...value, pluginUiProjection: installedDaysProjection('Active days', true) };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    const beforeEdit = hook.getCurrent().candidate!;
    value = { ...value, pluginUiProjection: installedDaysProjection('Updated days', true) };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toContainEqual(expect.objectContaining({ id: 'installed-days',
      presentation: expect.objectContaining({ document: expect.objectContaining({ root: expect.objectContaining({ label: 'Updated days' }) }) }) })));
    expect(beforeEdit.layout.items).toContainEqual(expect.objectContaining({ id: 'installed-days',
      presentation: expect.objectContaining({ document: expect.objectContaining({ root: expect.objectContaining({ label: 'Active days' }) }) }) }));
    value = { ...value, pluginUiProjection: installedDaysProjection(null, true) };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
    expect(hook.getCurrent().candidate).toBeNull();
    value = { ...value, pluginUiProjection: installedDaysProjection('Restored days') };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const lifetime = captureActiveServerAccountScopeLifetime();
    retireActiveServerAccountScopeLifetime();
    expect(lifetime?.isCurrent()).toBe(false);
  } finally { await hook.unmount(); }
});

it('compiles the acknowledged named area and copied placements, preserving a saved empty layout', async () => {
  const hook = await openArea();
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout.items.map(item => item.id)).toEqual(['totals', 'days', 'crew', 'planet']);
    expect(artifacts.list()).toHaveLength(0);
    const original = hook.getCurrent().candidate!;
    await act(async () => { expect(await hook.getCurrent().binding.createLayout('empty', 'Empty')).toMatchObject({ ok: true }); });
    await act(async () => { expect(await hook.getCurrent().binding.selectLayout('empty')).toMatchObject({ ok: true }); });
    await vi.waitFor(() => expect(hook.getCurrent().binding.surface?.owner).toMatchObject({ layoutId: 'empty' }));
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    // Create copies the current layout. Removing its last widget is an acknowledged empty document.
    for (const id of ['totals', 'days', 'crew', 'planet']) {
      await act(async () => { expect(await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.remove', instanceId: id })).toMatchObject({ ok: true }); });
    }
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toEqual([]));
    expect(original.layout.items.map(item => item.id)).toEqual(['totals', 'days', 'crew', 'planet']);
    await act(async () => { const added = await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.add',
      instance: { v: 1, id: 'copied-shipped', definition: { kind: 'builtin', id: 'usage_outcomes' }, bindings: { style: { kind: 'value', value: 'shipped' } } },
      size: 'wide' }); if (!added.ok) throw new Error(JSON.stringify(added)); });
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout).toEqual({ v: 1, items: [expect.objectContaining({ id: 'copied-shipped', size: 'wide',
      presentation: { kind: 'usage', widgetId: 'usage_outcomes', inputs: { style: 'shipped' } } })] }));
  } finally { await hook.unmount(); }
});

it('keeps the last compiled preview through a pending or failed reread and recovers without mutating its copy', async () => {
  const hook = await openArea();
  let release: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const captured = hook.getCurrent().candidate!;
    readGate = new Promise(resolve => { release = resolve; });
    let pending!: ReturnType<ReturnType<typeof hook.getCurrent>['area']['reload']>;
    await act(async () => { pending = hook.getCurrent().area.reload(); });
    const state = hook.getCurrent().area.state;
    if (state.status !== 'ready') throw new Error('Expected retained admitted layout');
    expect(state.isReadPending()).toBe(true);
    expect(state.isCurrent()).toBe(true);
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    await act(async () => { readGate = null; release?.(); await pending; });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    failReads = true;
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('unavailable'));
    expect(hook.getCurrent().candidate).toBe(captured);
    expect(captured.layout.items.map(item => item.id)).toEqual(['totals', 'days', 'crew', 'planet']);
    failReads = false;
    await act(async () => { await hook.getCurrent().area.reload(); });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const lifetime = captureActiveServerAccountScopeLifetime();
    retireActiveServerAccountScopeLifetime();
    expect(lifetime?.isCurrent()).toBe(false);
  } finally { readGate = null; release?.(); await hook.unmount(); }
});

it('recompiles the preview for its new page source without adding a veto to the captured copy', async () => {
  const pageContext = (period: '90days' | '7days') => usageWidgetSurfaceContext(
    readUsageWidgetPageContext(readUsageWidgetPageScope(normalizeUsageQuery({ period: { relative: period } }))), period);
  let context = pageContext('90days');
  const hook = await openArea(() => context);
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    const captured = hook.getCurrent().candidate!;
    context = pageContext('7days');
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    expect(captured).not.toHaveProperty('isCurrent');
    expect(hook.getCurrent().candidate?.selection.surface).toEqual(captured.selection.surface);
  } finally { await hook.unmount(); }
});

it('recompiles an edited Artifact definition in the preview while preserving the already captured copy', async () => {
  const hook = await openArea();
  const account = { serverId: runtime.serverId, accountId: 'account-a' };
  const reviewedArtifactId = '11111111-1111-4111-8111-111111111111';
  const unrelatedArtifactId = '11111111-1111-4111-8111-111111111112';
  const definition = WidgetDefinitionDraftV1Schema.parse({ name: 'Shared days',
    sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
    inputSchema: { type: 'object', additionalProperties: false },
    body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Private live body' } } },
    publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Active days',
      data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } },
  });
  try {
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    await act(async () => {
      await hook.getCurrent().execution.executeValue('widgets.definition.create', { account, artifactId: reviewedArtifactId, definition });
      expect(await hook.getCurrent().binding.port!.execute({ actionId: 'widgets.item.add', size: 'medium',
        instance: { v: 1, id: 'reviewed-days-copy', definition: { kind: 'artifact', artifactId: reviewedArtifactId }, bindings: {} },
      })).toMatchObject({ ok: true });
      await hook.getCurrent().area.reload();
    });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toContainEqual(expect.objectContaining({
      id: 'reviewed-days-copy', title: 'Shared days',
    })));
    const captured = hook.getCurrent().candidate!;
    await act(async () => {
      await hook.getCurrent().execution.executeValue('widgets.definition.create', { account, artifactId: unrelatedArtifactId, definition });
    });
    expect(hook.getCurrent().candidate?.layout).toEqual(captured.layout);
    await act(async () => {
      await hook.getCurrent().execution.executeValue('widgets.definition.update', {
        account, artifactId: reviewedArtifactId, patch: { name: 'Updated days' },
      });
    });
    await vi.waitFor(() => expect(hook.getCurrent().candidate?.layout.items).toContainEqual(expect.objectContaining({
      id: 'reviewed-days-copy', title: 'Updated days',
    })));
    expect(captured.layout.items).toContainEqual(expect.objectContaining({ id: 'reviewed-days-copy', title: 'Shared days' }));
  } finally { await hook.unmount(); }
});
