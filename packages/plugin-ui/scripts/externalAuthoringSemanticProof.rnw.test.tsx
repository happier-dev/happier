import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  readPluginUiTestkitTargetedSurfaceAdmission,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiActionResultFor, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { act } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import {
  createWidgetAreaActionPortV1,
  createWidgetSurfaceArtifactPortV1,
  createWidgetActionInputResolverV1,
  validateWidgetWorkspaceInputV1,
  type WidgetInstanceV1,
  type WidgetInstanceActionIdV1,
  type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '../../protocol/src/boards/workBoardArtifactV1.testkit.js';

import { externalAuthoringPlugin } from '@external-authoring/plugin';
import { renderPhysicalCopyTargetSurface } from '@external-authoring/targeted-surface';
import { manifest as externalContributorManifest } from '@external-authoring/targeted-contributor';

const exactComposerRef = {
  kind: 'session',
  sessionId: 'external-composer-session',
} as const;
const EXTERNAL_SEMANTIC_VIEW_ID = 'external-authoring-semantic';

function selectExternalAuthoringSemanticRendererArtifact(
  ui: typeof externalAuthoringPlugin.manifest.contributes.ui,
  viewId = EXTERNAL_SEMANTIC_VIEW_ID,
): string {
  const view = ui.views?.find(candidate => candidate.id === viewId);
  if (!view) throw new Error('Expected the loaded external authoring semantic view');
  const renderer = ui.renderers?.find(candidate => candidate.id === view.renderer);
  if (renderer?.kind !== 'reactNative') {
    throw new Error('Expected the loaded external authoring semantic React Native renderer');
  }
  return renderer.artifact;
}

async function loadExternalAuthoringSemanticSurface(viewId = EXTERNAL_SEMANTIC_VIEW_ID): Promise<RenderSurface> {
  const artifact = selectExternalAuthoringSemanticRendererArtifact(
    externalAuthoringPlugin.manifest.contributes.ui,
    viewId,
  );
  if (artifact !== 'semantic-surface') {
    throw new Error(`Unsupported external authoring semantic artifact: ${artifact}`);
  }
  const module = await import('@external-authoring/semantic-surface');
  return module.renderExternalAuthoringSemanticSurface;
}

describe('external author semantic proof', () => {
  let externalAuthoringSemanticSurface: RenderSurface;

  beforeAll(async () => {
    externalAuthoringSemanticSurface = await loadExternalAuthoringSemanticSurface();
  });

  it('filters genuine held release stages through the installed plugin page and public adapter without Actions', async () => {
    let actions = 0;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'external-release-stage', mountNonce: 'external-release-stage' },
      authorPlugin: { id: externalAuthoringPlugin.manifest.id, version: externalAuthoringPlugin.manifest.version },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      launchInput: { releaseStage: 'ready' },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => { actions += 1; return null; } },
    });
    try {
      expect((await fixture.getAllByRole('radio')).map(row => row.name)).toEqual(['Choose Release review']);
      expect(actions).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it('edits and saves the actual external page filter in its device location, then reopens, withdraws and restores without Resource demand', async () => {
    let location = '';
    let resourceDemand = 0;
    let actions = 0;
    const mount = () => createPluginUiTestkit({
      identity: { instanceId: 'external-release-editor', mountNonce: 'external-release-editor' },
      authorPlugin: { id: externalAuthoringPlugin.manifest.id, version: externalAuthoringPlugin.manifest.version },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture(),
      subPath: location,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        replacePageLocation: ({ subPath }) => { location = subPath; return subPath; },
        executeAction: async () => { actions += 1; return null; },
        readResource: async () => { resourceDemand += 1; throw new Error('Filter must not read a Resource'); },
        watchResource: async () => { resourceDemand += 1; throw new Error('Filter must not watch a Resource'); },
      },
    });
    let fixture = await mount();
    const click = async (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      expect(element).not.toBeNull();
      await act(async () => { element!.click(); });
    };
    const choices = async () => (await fixture.getAllByRole('radio')).filter(row => row.name?.startsWith('Choose ')).map(row => row.name);
    try {
      expect(await choices()).toEqual([expect.stringContaining('Choose Current review'), 'Choose Terminal review', 'Choose Release review']);
      await fixture.press(await fixture.getByRole('button', { name: 'Edit release filter' }));
      await click('[data-testid="collection-filter-add"]');
      await click('[data-testid^="collection-filter-field:"]');
      await click('[data-testid^="collection-filter-value:"][data-testid$=":ready"]');
      await click('[data-testid="collection-filter-back"]');
      expect(await choices()).toEqual(['Choose Release review']);
      expect(location).toBe('');
      await fixture.press(await fixture.getByRole('button', { name: 'Save release filter' }));
      expect(location).not.toBe('');
      const savedLocation = location;
      await fixture.dispose();
      fixture = await mount();
      expect(await choices()).toEqual(['Choose Release review']);
      await fixture.press(await fixture.getByRole('button', { name: 'Edit release filter' }));
      await expect(fixture.getByText('Release stage')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Withdraw release field' }));
      await expect(fixture.getByText('Release stage unavailable')).resolves.toBeDefined();
      expect(document.querySelector('[data-testid="external-review-choose:release"]')).toBeNull();
      expect(location).toBe(savedLocation);
      await fixture.press(await fixture.getByRole('button', { name: 'Restore release field' }));
      expect(await choices()).toEqual(['Choose Release review']);
      expect({ resourceDemand, actions }).toEqual({ resourceDemand: 0, actions: 0 });
    } finally { await fixture.dispose(); }
  });

  it('reconciles host release-field currentness on an already mounted external page', async () => {
    let fieldCurrent = false;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'external-release-currentness', mountNonce: 'external-release-currentness' },
      authorPlugin: { id: externalAuthoringPlugin.manifest.id, version: externalAuthoringPlugin.manifest.version },
      // The host supplies launch input; the actual author entry and filter owners remain real.
      surface: context => externalAuthoringSemanticSurface({ ...context,
        launchInput: { releaseStage: 'ready', releaseFieldCurrent: fieldCurrent } }),
      surfaceContext: createSurfaceContextFixture(),
      subPath: '',
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => null },
    });
    try {
      expect(document.querySelector('[data-testid="external-review-choose:release"]')).toBeNull();
      fieldCurrent = true;
      await fixture.updateSurface(createSurfaceContextFixture({ locale: 'en-GB' }));
      await expect(fixture.getByRole('radio', { name: 'Choose Release review' })).resolves.toBeDefined();
      fieldCurrent = false;
      await fixture.updateSurface(createSurfaceContextFixture({ locale: 'en-US' }));
      expect(document.querySelector('[data-testid="external-review-choose:release"]')).toBeNull();
    } finally { await fixture.dispose(); }
  });

  it('requires the semantic surface to be declared by the loaded author contribution', () => {
    const ui = externalAuthoringPlugin.manifest.contributes.ui;
    expect(() => selectExternalAuthoringSemanticRendererArtifact({
      ...ui,
      views: ui.views?.filter(view => view.id !== EXTERNAL_SEMANTIC_VIEW_ID),
    })).toThrow('Expected the loaded external authoring semantic view');
  });

  it('resizes and resets an externally authored own-split layout through the installed surface path', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-resize', mountNonce: 'fixture-resize' },
      authorPlugin: { id: externalAuthoringPlugin.manifest.id, version: externalAuthoringPlugin.manifest.version },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => null },
    });
    try {
      const layout = document.querySelector('[data-testid="external-resizable-collection"]');
      expect(layout).not.toBeNull();
      const measure = Reflect.get(layout!, '__reactLayoutHandler') as (event: unknown) => void;
      act(() => measure({ nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 600 } } }));
      const handle = document.querySelector('[data-testid="external-resizable-collection-resize-handle"]') as HTMLElement;
      const detail = document.querySelector('[data-testid="external-resizable-detail"]');
      expect(handle.getAttribute('aria-valuenow')).toBe('300');
      act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300 })));
      act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })));
      act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 400 })));
      expect(handle.getAttribute('aria-valuenow')).toBe('400');
      expect(document.querySelector('[data-testid="external-resizable-detail"]')).toBe(detail);
      act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      expect(handle.getAttribute('aria-valuenow')).toBe('300');
    } finally { await fixture.dispose(); }
  });

  it('renders a Source-free Project widget and companion from the actual Project area input admission', async () => {
    const ui = externalAuthoringPlugin.manifest.contributes.ui;
    const widget = ui.views?.find(view => view.id === 'external-project-checkout');
    const sourceWidget = ui.views?.find(view => view.id === 'external-project-source');
    const companion = ui.views?.find(view => view.id === 'external-project-companion');
    expect(widget?.container).toBe('widget');
    expect(sourceWidget?.container).toBe('widget');
    expect(companion?.container).toBe('rightSidebarTab');
    expect(widget?.target).toEqual({ kind: 'app' });
    expect(sourceWidget?.target).toEqual({ kind: 'app' });
    if (!widget || !sourceWidget || !companion) throw new Error('Missing public Project contributions');

    const checkout = { id: 'checkout-review', serverId: 'home-review', machineId: 'machine-review',
      rootPath: '/work/review-assistant', createdAtMs: 0, projectKey: 'private-project-review' };
    const surface: WidgetSurfaceRefV1 = { serverId: checkout.serverId, accountId: 'reviewer',
      owner: { kind: 'project', projectId: checkout.projectKey } };
    const boundary = createWorkBoardArtifactBoundary();
    const transport = boundary.forAccount(surface.accountId);
    const area = createWidgetAreaActionPortV1(captured => createWidgetSurfaceArtifactPortV1(transport, {
      surface: captured, isCurrent: () => true,
    }));
    let source: Readonly<{ sourceId: string; revision: number }> | null = null;
    const deps = {
      widgetAccountScope: () => ({ accountId: surface.accountId, serverId: surface.serverId }),
      widgetSurfaceActions: { project: area },
      widgetInputs: createWidgetActionInputResolverV1({
        readDescriptor: async request => {
          const definition = request.instance.definition;
          return definition.kind === 'installed'
            ? ui.views?.find(view => view.id === definition.surface.localId) ?? null : null;
        },
        // This is the host's admitted context boundary, not a substitute binder or Source policy.
        readContext: async () => ({ checkout: [checkout], ...(source ? { project: [source] } : {}) }),
        readViewerValues: async () => ({ values: {} }),
        validateValue: async (field, value) => field.inputType && 'hostType' in field.inputType
          && field.inputType.hostType === 'workspace'
          ? validateWidgetWorkspaceInputV1({ value, serverId: surface.serverId, workspaceRefs: [checkout] })
          : { status: 'valid' },
        resolveOptions: async () => [],
      }),
    } satisfies Pick<ActionExecutorDeps, 'widgetAccountScope' | 'widgetSurfaceActions' | 'widgetInputs'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const execute = (actionId: WidgetInstanceActionIdV1, input: unknown) => executor.execute(actionId, input, {
      serverId: surface.serverId, surface: 'ui', bypassApprovals: true,
    });
    const instance = (localId: string): WidgetInstanceV1 => ({ v: 1, id: localId,
      definition: { kind: 'installed', surface: { pluginId: externalAuthoringPlugin.manifest.id, localId } },
      bindings: { checkout: { kind: 'context', slot: 'checkout' },
        ...(localId === sourceWidget.id ? { source: { kind: 'context' as const, slot: 'project' } } : {}) },
    });
    const checkoutInstance = instance(widget.id);
    const checkoutAdded = await execute('widgets.item.add', { surface, area: 'main', instance: checkoutInstance });
    expect(checkoutAdded, JSON.stringify(checkoutAdded)).toMatchObject({ ok: true });
    const admitted = await execute('widgets.item.inputs.validate', {
      ref: { surface, instanceId: checkoutInstance.id }, bindings: checkoutInstance.bindings,
    });
    expect(admitted).toEqual({ ok: true, result: { status: 'ready', input: { checkout } } });
    if (!admitted.ok || !('input' in admitted.result)) throw new Error('Checkout input was not admitted');
    for (const mount of [
      { kind: 'embedded', role: 'widget', presentation: 'content' },
      { kind: 'destination', container: 'rightSidebarTab',
        destination: { pluginId: externalAuthoringPlugin.manifest.id, localId: companion.id } },
    ] as const) {
      const fixture = await createPluginUiTestkit({
        identity: { instanceId: `project-${mount.kind}`, mountNonce: `project-${mount.kind}-mount` },
        authorPlugin: { id: externalAuthoringPlugin.manifest.id, version: externalAuthoringPlugin.manifest.version },
        surface: await loadExternalAuthoringSemanticSurface(mount.kind === 'embedded' ? widget.id : companion.id),
        surfaceContext: createSurfaceContextFixture({ mount, target: mount.kind === 'embedded'
          ? { kind: 'app' } : { kind: 'project', projectId: checkout.projectKey } }),
        launchInput: admitted.result.input,
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      });
      try {
        await expect(fixture.getByText(`Project ${checkout.projectKey}`)).resolves.toBeDefined();
        await expect(fixture.getByText(`${checkout.serverId} · ${checkout.machineId} · ${checkout.rootPath}`)).resolves.toBeDefined();
      } finally { await fixture.dispose(); }
    }
    const sourceInstance = instance(sourceWidget.id);
    const refuse = () => execute('widgets.item.inputs.validate', {
      ref: { surface, instanceId: sourceInstance.id }, bindings: sourceInstance.bindings,
    });
    const beforeRefusal = [...boundary.rows.values()];
    expect(await execute('widgets.item.add', { surface, area: 'aside', instance: sourceInstance })).toMatchObject({
      ok: false, errorCode: 'widget_inputs_invalid', details: { status: 'selection_required', fields: [
        { path: 'source', status: 'selection_required', reasonCode: 'widget_context_missing' },
      ] },
    });
    expect([...boundary.rows.values()]).toEqual(beforeRefusal);
    source = { sourceId: 'saved-review-source', revision: 1 };
    expect(await execute('widgets.item.add', { surface, area: 'aside', instance: sourceInstance })).toMatchObject({ ok: true });
    const sourceInput = await refuse();
    expect(sourceInput).toEqual({ ok: true, result: { status: 'ready', input: { checkout, source } } });
    if (!sourceInput.ok || !('input' in sourceInput.result)) throw new Error('Source input was not admitted');
    const sourceMount = await createPluginUiTestkit({
      identity: { instanceId: 'project-source', mountNonce: 'project-source-mount' },
      authorPlugin: { id: externalAuthoringPlugin.manifest.id, version: externalAuthoringPlugin.manifest.version },
      surface: await loadExternalAuthoringSemanticSurface(sourceWidget.id),
      surfaceContext: createSurfaceContextFixture({ target: { kind: 'app' },
        mount: { kind: 'embedded', role: 'widget', presentation: 'content' } }),
      launchInput: sourceInput.result.input,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    try { await expect(sourceMount.getByText(`Source ${source.sourceId}`)).resolves.toBeDefined(); }
    finally { await sourceMount.dispose(); }
    source = null;
    expect(await refuse()).toMatchObject({ ok: true, result: { status: 'selection_required' } });
    expect(await execute('widgets.item.inputs.validate', {
      ref: { surface, instanceId: checkoutInstance.id }, bindings: checkoutInstance.bindings,
    })).toEqual(admitted);
    const reloaded = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    expect(await reloaded.readState()).toMatchObject({ kind: 'present', layout: { surface } });
    expect(boundary.rows.size).toBe(1);
  });

  it('opens authoring through the public host Action boundary with a typed draft acknowledgement', async () => {
    const calls: Array<Readonly<{ action: unknown; input: unknown }>> = [];
    const acknowledgement = { kind: 'opened', draftId: 'external-authoring-draft', destination: 'newSession' } as const satisfies PluginUiActionResultFor<'session.authoring.open'>;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'external-authoring-action', mountNonce: 'external-authoring-action-mount' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => {
          calls.push({ action, input });
          return acknowledgement;
        },
      },
    });
    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Open an editable authoring draft' }));
      expect(calls).toEqual([{ action: 'session.authoring.open', input: {
        seed: { prompt: 'Help me update this review integration.' },
      } }]);
      await expect(fixture.findByRole('status', { name: 'Draft opened; review and Send in Happier' })).resolves.toBeDefined();
    } finally { await fixture.dispose(); }
  });

  it('mounts an external target child from strict cold admission and retires it across replacement, uninstall, and reinstall', async () => {
    const targetPluginId = 'fixture.physical-copy-target';
    const contributorPluginId = 'fixture.physical-copy-contributor';
    const contributionId = 'physical-copy-source';
    const point = {
      pointId: 'sources',
      protocol: { id: 'physical-copy-sources', version: 1 },
    } as const;
    const mounts = { current: [] as unknown[] };
    const occurrence = (pluginId: string, generation: string) => ({
      pluginId,
      occurrenceId: `${pluginId}:${generation}`,
      sourceCustody: { kind: 'managed', immutableGenerationId: generation, installSource: 'npm' },
    } as const);
    const contributorFor = (generation: string) => ({
      ...occurrence(contributorPluginId, generation), contributionId,
    });
    const detailInputSchema = defineProtocolObject({
      entryId: defineProtocolString({ minLength: 1 }),
    }, { policy: 'closed' });
    const contextFor = (targetGeneration: string, contributorGeneration?: string) => {
      const surface = contributorGeneration === undefined ? undefined : {
        point,
        contributor: contributorFor(contributorGeneration),
        role: 'detail',
        presentation: 'content',
      } as const;
      return createSurfaceContextFixture({
        targetedContributions: {
          target: occurrence(targetPluginId, targetGeneration),
          points: surface === undefined ? [] : [{
            pointId: point.pointId,
            protocols: [{
              protocol: point.protocol,
              contributions: [{
                contributor: surface.contributor,
                protocol: point.protocol,
                descriptor: { kind: 'issue', label: 'Physical package source' },
                operations: [],
                surfaces: [surface],
              }],
            }],
          }],
        },
      });
    };
    const admittedMount = (targetGeneration: string, contributorGeneration: string) => ({
      kind: 'targetedSurface',
      target: occurrence(targetPluginId, targetGeneration),
      point,
      contributor: contributorFor(contributorGeneration),
      role: 'detail',
      presentation: 'content',
      inputSchema: detailInputSchema.jsonSchema,
      rendererChain: [{ pluginId: contributorPluginId, localId: 'physical-copy-detail-renderer' }],
      selectedRenderer: {
        identity: { pluginId: contributorPluginId, localId: 'physical-copy-detail-renderer' },
        renderer: {
          kind: 'declarative',
          contributionId: 'physical-copy-detail-renderer',
          model: {
            identity: {
              pluginId: contributorPluginId,
              localId: 'physical-copy-detail-renderer',
              qualifiedId: `${contributorPluginId}/physical-copy-detail-renderer`,
              occurrenceId: occurrence(contributorPluginId, contributorGeneration).occurrenceId,
            },
            visible: true,
            requiredHostMethods: [],
            declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
            root: { kind: 'text', path: 'root', order: 0, text: 'External source detail' },
          },
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
      },
      executionOrigin: {
        serverIdentityId: 'srv_external',
        materializationRef: {
          machineId: 'machine-external',
          materializationId: `materialization-${contributorGeneration}`,
          pluginId: contributorPluginId,
        },
      },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: {
        target: occurrence(contributorPluginId, contributorGeneration),
        points: [],
      },
    });

    mounts.current = [admittedMount('target-generation-a', 'contributor-generation-a')];
    const initialContext = contextFor('target-generation-a', 'contributor-generation-a');
    const initialSurface = initialContext.targetedContributions.points[0]!
      .protocols[0]!.contributions[0]!.surfaces[0]!;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-36', mountNonce: 'fixture-mount-36' },
      authorPlugin: { id: targetPluginId, version: '1.0.0' },
      surface: renderPhysicalCopyTargetSurface,
      surfaceContext: initialContext,
      adapter: createPluginUiRnwSemanticSurfaceAdapter({
        targetedSurfaces: {
          readCurrentMounts: () => mounts.current,
          readContributorManifest: () => externalContributorManifest,
        },
      }),
    });

    try {
      await expect(fixture.getByText('External source detail')).resolves.toBeDefined();
      const contributorUi = externalContributorManifest.contributes.ui;
      const manifestWithRenderers = (renderers: typeof contributorUi.renderers) => ({
        ...externalContributorManifest,
        contributes: {
          ...externalContributorManifest.contributes,
          ui: { ...contributorUi, renderers },
        },
      });
      const renamedRenderers = contributorUi.renderers.map((renderer) => (
        renderer.id === 'physical-copy-detail-renderer'
          ? { ...renderer, id: 'renamed-physical-copy-detail-renderer' }
          : renderer
      ));
      const deletedRenderers = contributorUi.renderers.filter((renderer) => (
        renderer.id !== 'physical-copy-detail-renderer'
      ));
      for (const contributorManifest of [
        manifestWithRenderers(renamedRenderers),
        manifestWithRenderers(deletedRenderers),
      ]) {
        expect(readPluginUiTestkitTargetedSurfaceAdmission({
          mounts: mounts.current,
          target: initialContext.targetedContributions.target,
          surface: initialSurface,
          launchInput: { entryId: 'external-42' },
          instanceKey: 'external-42',
          contributorManifest,
        })).toBeNull();
      }

      mounts.current = [admittedMount('target-generation-a', 'contributor-generation-b')];
      await act(async () => {
        await fixture.updateSurface(contextFor('target-generation-a', 'contributor-generation-b'));
      });
      await expect(fixture.getByText('External source detail')).resolves.toBeDefined();

      mounts.current = [];
      await act(async () => {
        await fixture.updateSurface(contextFor('target-generation-a'));
      });
      await expect(fixture.getByText('External source detail unavailable')).resolves.toBeDefined();

      mounts.current = [admittedMount('target-generation-b', 'contributor-generation-c')];
      await act(async () => {
        await fixture.updateSurface(contextFor('target-generation-b', 'contributor-generation-c'));
      });
      await expect(fixture.getByText('External source detail')).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('mounts a real public external surface and proves its rendered role and handler', async () => {
    const initialSurface = createSurfaceContextFixture({
      locale: 'en-GB',
      translations: { 'external.review.save': 'Save external review' },
    });
    const actionCalls: Array<Readonly<{ action: string; input: unknown }>> = [];
    let resolveSave!: () => void;
    let signalSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { signalSaveStarted = resolve; });
    const pendingSave = new Promise<void>((resolve) => { resolveSave = resolve; });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-37', mountNonce: 'fixture-mount-37' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: initialSurface,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => {
          actionCalls.push({
            action: typeof action === 'string' ? action : action.localId,
            input,
          });
          signalSaveStarted();
          await pendingSave;
          return null;
        },
      },
    });

    try {
      const initialSave = await fixture.getByRole('button', {
        name: 'Save external review (en-GB)',
      });

      const firstPress = fixture.press(initialSave);
      await saveStarted;
      const saveSettled = new Promise<void>((resolve) => {
        setTimeout(() => {
          void act(async () => {
            resolveSave();
            await Promise.resolve();
            await Promise.resolve();
          }).then(resolve);
        }, 20);
      });
      await expect(fixture.findByRole('status', {
        name: 'Saved external review (en-GB)',
      })).resolves.toEqual({
        role: 'status',
        name: 'Saved external review (en-GB)',
      });
      await saveSettled;
      await firstPress;
      expect(actionCalls).toEqual([{
        action: 'save-external-review',
        input: { locale: 'en-GB' },
      }]);

      await act(async () => {
        await fixture.updateSurface({
          ...initialSurface,
          locale: 'fr-FR',
          translations: { 'external.review.save': 'Enregistrer la revue externe' },
        });
      });
      await expect(fixture.press(initialSave)).rejects.toMatchObject({ code: 'stale_surface' });

      const updatedSave = await fixture.getByRole('button', {
        name: 'Enregistrer la revue externe (fr-FR)',
      });
      await fixture.press(updatedSave);
      await expect(fixture.findByRole('status', {
        name: 'Saved external review (fr-FR)',
      })).resolves.toEqual({
        role: 'status',
        name: 'Saved external review (fr-FR)',
      });
      expect(actionCalls).toEqual([
        { action: 'save-external-review', input: { locale: 'en-GB' } },
        { action: 'save-external-review', input: { locale: 'fr-FR' } },
      ]);

      await act(async () => {
        await fixture.updateSurface({ ...initialSurface, locale: 'de-CH', translations: {} });
      });
      await expect(fixture.getByRole('button', {
        name: 'Save external review (de-CH)',
      })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('lets an external author inspect List choices and control selected option state through the public Testkit', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-38', mountNonce: 'fixture-mount-38' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => null },
    });

    try {
      const initialReviews = await fixture.getAllByRole('option');
      expect(initialReviews).toEqual([
        { role: 'option', name: 'Current review', state: { selected: true } },
        { role: 'option', name: 'Terminal review', state: { selected: false } },
        { role: 'option', name: 'Release review', state: { selected: false } },
      ]);
      await expect(fixture.getByRole('option', {
        name: 'Current review',
        state: { selected: true },
      })).resolves.toBeDefined();

      const terminal = await fixture.getByRole('option', {
        name: 'Terminal review',
        state: { selected: false },
      });
      await fixture.press(terminal);
      await expect(fixture.findByRole('option', {
        name: 'Terminal review',
        state: { selected: true },
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('option', {
        name: 'Current review',
        state: { selected: false },
      })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('preserves an external controlled Collection choice across viewer-local widget collapse', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-m2', mountNonce: 'fixture-mount-m2' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => null },
    });
    try {
      await fixture.press(await fixture.getByRole('radio', { name: 'Choose Terminal review' }));
      await expect(fixture.getByRole('radio', {
        name: 'Choose Terminal review', state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Collapse review choices' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Expand review choices' }));
      await expect(fixture.getByRole('radio', {
        name: 'Choose Terminal review', state: { checked: true },
      })).resolves.toBeDefined();
      await expect(fixture.getByText('Neutral owners review-root 480,360')).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('exposes the public structural semantics an external author composes into the same mounted surface', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-39', mountNonce: 'fixture-mount-39' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { executeAction: async () => null },
    });

    try {
      await expect(fixture.getByRole('form')).resolves.toMatchObject({ role: 'form' });
      await fixture.press(await fixture.getByRole('button', { name: 'Submit external review form' }));
      await expect(fixture.getByRole('status', {
        name: 'External review form submitted: {"enabled":false,"note":"","name":"Release review","count":0}',
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', { name: 'External review filter: Current review' })).resolves.toEqual({
        role: 'button',
        name: 'External review filter: Current review',
        state: { expanded: false },
      });
      await fixture.press(await fixture.getByRole('button', { name: 'External review filter: Current review' }));
      await expect(fixture.getByRole('menuitemradio', { name: 'Current review', state: { checked: true } }))
        .resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('menuitemradio', { name: 'All reviews' }));
      await expect(fixture.getByRole('button', { name: 'External review filter: All reviews' })).resolves.toBeDefined();
      await expect(fixture.getByRole('tabpanel', { name: 'Summary' })).resolves.toEqual({
        role: 'tabpanel',
        name: 'Summary',
      });
      await expect(fixture.getByRole('separator', { name: 'External review sections' })).resolves.toEqual({
        role: 'separator',
        name: 'External review sections',
      });

      await fixture.press(await fixture.getByRole('tab', { name: 'History' }));
      await expect(fixture.getByRole('tabpanel', { name: 'History' })).resolves.toEqual({
        role: 'tabpanel',
        name: 'History',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the public Composer facade for an exact attachment mutation', async () => {
    const snapshot = {
      revision: 12,
      ref: exactComposerRef,
      text: '',
      references: [],
      attachments: [],
      layout: 'wrap' as const,
      capabilities: { text: true, references: true, attachments: true, submit: true },
      state: {
        focused: false,
        editable: true,
        submittable: true,
        submitting: false,
        running: false,
      },
    };
    const composerTransactions: Array<Readonly<{
      ref: unknown;
      transaction: unknown;
    }>> = [];
    const composerObservations: unknown[] = [];
    const composerWatchSignals: AbortSignal[] = [];
    const composerReleases: number[] = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-40', mountNonce: 'fixture-mount-40' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readComposer: async ({ ref }) => {
          expect(ref).toEqual(exactComposerRef);
          return { status: 'ready' as const, snapshot };
        },
        watchComposer: async ({ ref, signal }) => {
          composerObservations.push(ref);
          composerWatchSignals.push(signal);
          const observationIndex = composerWatchSignals.length;
          return {
            dispose: () => {
              composerReleases.push(observationIndex);
            },
          };
        },
        applyComposer: async ({ ref, transaction }) => {
          composerTransactions.push({
            ref,
            transaction,
          });
          return {
            status: 'applied' as const,
            revision: 13,
            attachmentInstanceIds: ['external-composer-attachment'],
          };
        },
      },
    });

    try {
      await expect(fixture.findByRole('status', {
        name: 'External composer view revision 12',
      })).resolves.toEqual({
        role: 'status',
        name: 'External composer view revision 12',
      });
      fixture.emitComposerSnapshot(exactComposerRef, {
        ...snapshot,
        revision: 13,
        text: 'Observed external draft',
      });
      await expect(fixture.findByRole('status', {
        name: 'External composer view revision 13',
      })).resolves.toEqual({
        role: 'status',
        name: 'External composer view revision 13',
      });
      const manuallyObservedRevisions: number[] = [];
      const manualObservation = await fixture.context.hostApi.watchComposer(
        exactComposerRef,
        (next) => manuallyObservedRevisions.push(next.revision),
      );
      manualObservation.dispose();
      expect(composerWatchSignals[1]?.aborted).toBe(true);
      expect(composerReleases).toContain(2);
      fixture.emitComposerSnapshot(exactComposerRef, {
        ...snapshot,
        revision: 14,
        text: 'Late manual observation',
      });
      expect(manuallyObservedRevisions).toEqual([]);
      await expect(fixture.findByRole('status', {
        name: 'External composer view revision 14',
      })).resolves.toEqual({
        role: 'status',
        name: 'External composer view revision 14',
      });
      const addAttachment = await fixture.getByRole('button', {
        name: 'Add external composer attachment',
      });
      await fixture.press(addAttachment);
      await expect(fixture.findByRole('status', {
        name: 'Added external composer attachment',
      })).resolves.toEqual({
        role: 'status',
        name: 'Added external composer attachment',
      });
      expect(composerTransactions).toEqual([{
        ref: exactComposerRef,
        transaction: {
          expectedRevision: 12,
          operations: [{
            kind: 'attachment.add',
            attachmentLocalId: 'external-issue',
            value: {
              key: 'external-review',
              value: { reviewId: 'external-review' },
              presentation: { label: 'External review' },
            },
          }],
        },
      }]);
      expect(composerObservations).toEqual([exactComposerRef, exactComposerRef]);
      await fixture.retire('external-composer-observation-replaced');
      expect(composerWatchSignals[0]?.aborted).toBe(true);
      expect(composerReleases).toContain(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('cancels an external author Composer watch before a late host admission can leak its release', async () => {
    let signalWatchStarted!: () => void;
    const watchStarted = new Promise<void>((resolve) => { signalWatchStarted = resolve; });
    let signalRelease!: () => void;
    const releaseObserved = new Promise<void>((resolve) => { signalRelease = resolve; });
    let watchSignal: AbortSignal | undefined;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-41', mountNonce: 'fixture-mount-41' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readComposer: async () => ({ status: 'unavailable' as const, reason: 'notFound' as const }),
        watchComposer: ({ signal }) => {
          watchSignal = signal;
          signalWatchStarted();
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              resolve({ dispose: signalRelease });
            }, { once: true });
          });
        },
      },
    });

    try {
      await watchStarted;
      await fixture.retire('external-composer-cancelled');
      await releaseObserved;
      expect(watchSignal?.aborted).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('clears Composer decorations through an external author handle', async () => {
    const decorationCalls: Array<Readonly<{
      ref: unknown;
      key: string;
      decorations: unknown;
    }>> = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-42', mountNonce: 'fixture-mount-42' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        setComposerDecorations: async ({ ref, key, decorations }) => {
          decorationCalls.push({ ref, key, decorations });
          return { status: 'set' as const };
        },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', {
        name: 'Clear external composer decorations',
      }));
      await expect(fixture.findByRole('status', {
        name: 'Cleared external composer decorations',
      })).resolves.toEqual({
        role: 'status',
        name: 'Cleared external composer decorations',
      });
      expect(decorationCalls).toEqual([{
        ref: exactComposerRef,
        key: 'external-review',
        decorations: null,
      }]);
    } finally {
      await fixture.dispose();
    }
  });

  it('reports a host-provided hosted-web mount refusal without mounting the author surface', async () => {
    const bodyChildCount = document.body.children.length;
    const result = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-43', mountNonce: 'fixture-mount-43' },
      authorPlugin: {
        id: externalAuthoringPlugin.manifest.id,
        version: externalAuthoringPlugin.manifest.version,
      },
      surface: externalAuthoringSemanticSurface,
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      mount: {
        availability: {
          state: 'fallback',
          reason: 'hosted_web_frame_adapter_unavailable',
          diagnostics: ['hosted_web_frame_adapter_unavailable'],
        },
      },
    });

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('The hosted-web refusal must not mount the external surface.');
    expect(result.availability).toEqual({
      state: 'fallback',
      reason: 'hosted_web_frame_adapter_unavailable',
      diagnostics: ['hosted_web_frame_adapter_unavailable'],
    });
    expect(document.body.children).toHaveLength(bodyChildCount);
  });
});
