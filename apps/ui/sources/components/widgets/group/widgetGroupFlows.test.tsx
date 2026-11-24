import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetLayoutFragmentSummaryV1 } from '@happier-dev/protocol/widgets';
import { widgetCandidateDefinitionV1, readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { WidgetSetupDraft } from '@/components/widgets/add/widgetSetupModel';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { WidgetSetupStep } from '../add/WidgetSetupStep';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { buildWidgetGroupFragmentEntry } = await import('./widgetGroupFragmentSetup');

afterEach(() => standardCleanup());

const account = { serverId: 's', accountId: 'a' };

describe('Add to… for a group', () => {
  it('offers the captured Public profile area when enabled, and excludes it when already there', async () => {
    const { resolveWidgetGroupCopyDestinations } = await import('./widgetGroupCopy');
    const destinations = resolveWidgetGroupCopyDestinations({ current: { ...account, owner: { kind: 'home' } }, projects: [], publicProfileEnabled: true });
    expect(destinations).toContainEqual({ key: 'public-profile', label: expect.any(String), surface: { ...account,
      owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } } });
    expect(resolveWidgetGroupCopyDestinations({ current: { ...account, owner: { kind: 'home' } }, projects: [] })).toEqual([]);
    expect(resolveWidgetGroupCopyDestinations({ current: destinations[0]!.surface, projects: [], publicProfileEnabled: true })
      .some(destination => destination.key === 'public-profile')).toBe(false);
  });
  it('offers Home and each Project, never the surface the group is already on', async () => {
    const { resolveWidgetGroupCopyDestinations } =
      await import('./widgetGroupCopy');
    const fromHome = resolveWidgetGroupCopyDestinations({
      current: { ...account, owner: { kind: 'home' } },
      projects: [
        { projectId: 'p1', label: 'happier' },
        { projectId: 'p2', label: 'website' },
      ],
    });
    expect(fromHome.map((destination) => destination.label)).toEqual([
      'happier',
      'website',
    ]);
    expect(fromHome[0]).toMatchObject({
      surface: { ...account, owner: { kind: 'project', projectId: 'p1' } },
      area: 'main',
    });
    const fromProject = resolveWidgetGroupCopyDestinations({
      current: { ...account, owner: { kind: 'project', projectId: 'p1' } },
      projects: [
        { projectId: 'p1', label: 'happier' },
        { projectId: 'p2', label: 'website' },
      ],
    });
    expect(fromProject.map((destination) => destination.key)).toEqual([
      'home',
      'project:p2',
    ]);
  });
});

describe('Save group', () => {
  it("asks for a name inline, starting from the group's title, and saves under the name given", async () => {
    const { SaveWidgetGroupPanel } = await import('./SaveWidgetGroupPanel');
    const onSave = vi.fn(async () => ({ ok: true as const }));
    const onDone = vi.fn();
    const screen = await renderScreen(
      <SaveWidgetGroupPanel
        defaultName="happier"
        childCount={3}
        onSave={onSave}
        onCancel={() => {}}
        onDone={onDone}
        testID="save"
      />,
    );
    expect(screen.findByTestId('save.nameInput')!.props.value).toBe('happier');
    await (
      await import('react-test-renderer')
    ).act(async () => {
      screen
        .findByTestId('save.nameInput')!
        .props.onChangeText('  Release room ');
    });
    await (
      await import('react-test-renderer')
    ).act(async () => {
      screen.pressByTestId('save.submit');
    });
    await flushHookEffects({ cycles: 2 });
    expect(onSave).toHaveBeenCalledWith('Release room');
    expect(onDone).toHaveBeenCalled();
  });
});

describe('a saved group in Add', () => {
  it.each(['follow', 'own', 'own first', 'own last'] as const)('names Location in the Gallery footer only for a follower (%s)', async order => {
    const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
    const field = { path: 'location', title: 'Location', widget: 'text' } as const;
    const project = { path: 'project', title: 'Project', widget: 'text', required: true } as const;
    const inputs = { fields: [field, project] };
    const candidate: WidgetCandidate = { key: 'location', title: 'Location viewer', pluginName: 'Usage',
      sharedPluginName: false, icon: 'squares-four', homeDefault: 'available', target: 'app', definition, inputs };
    const path = '/private/saved-group-location';
    const follower = { kind: 'widget', instance: { v: 1, definition, bindings: {
      location: { kind: 'context', slot: 'location' }, project: { kind: 'context', slot: 'project' },
    } } } as const;
    const own = { ...follower, instance: { ...follower.instance, bindings: { ...follower.instance.bindings,
      location: { kind: 'value', value: '/private/child-location' } as const } } };
    const children = order === 'follow' ? [follower] : order === 'own' ? [own] : order === 'own first' ? [own, follower] : [follower, own];
    const fragment: WidgetLayoutFragmentSummaryV1 = { artifactId: 'location', name: 'Saved group', childCount: children.length,
      inputs, inputSchema: { type: 'object' },
      group: { width: 'full', frameStyle: 'card', dividers: 'hairline', context: { location: { kind: 'value', value: path } }, children } };
    const setup = buildWidgetGroupFragmentEntry({ fragment, candidates: [candidate], scope: { ...account, owner: { kind: 'home' } },
      context: { slots: { project: { label: 'Page project', value: { value: 'project-id', label: 'Project name' } } } },
      submitLabel: 'Add', add: async () => ({ ok: true }), renderGroupPreview: () => null }).setup!();
    const screen = await renderScreen(<WidgetSetupStep setup={setup} phone={false} presentation="pane" testID="gallery" onDone={() => {}} />);
    expect(screen.findByTestId('gallery.field.location.input')?.props.value).toBe(path);
    expect(screen.getTextContent()).toContain(order === 'own' ? 'value=null' : 'value=Location');
    expect(screen.getTextContent()).not.toContain(path);
    const named = setup.describeOutcome?.({ bindings: { location: { kind: 'value', value: 'Release notes' } } });
    expect(named).toContain(order === 'own' ? 'value=null' : 'value=Release notes');
    const several = setup.describeOutcome?.({ bindings: { ...setup.initial.bindings, project: { kind: 'context', slot: 'project' } } });
    expect(several).toContain('value=null');
  });

  it('places a saved Usage group with sparse overrides when the destination already supplies its child scope', async () => {
    const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_daily' })!;
    const candidate: WidgetCandidate = { ...descriptor, pluginName: 'Happier', sharedPluginName: false };
    const { buildWidgetGroupInputsCandidate } = await import('./widgetGroupInputs');
    const { readUsageWidgetPageContext, readUsageWidgetPageScope, usageWidgetSurfaceContext } =
      await import('@/components/settings/usage/usageWidgetPageContext');
    const { normalizeUsageQuery } = await import('@happier-dev/protocol/inputs');
    const groupInputs = buildWidgetGroupInputsCandidate({ title: 'Saved Usage', candidates: [candidate] })!;
    const follower = Object.fromEntries(groupInputs.inputs!.fields.map(field => [field.path,
      { kind: 'context' as const, slot: field.path }]));
    const period = { kind: 'value' as const, value: { relative: 'today' } };
    const fragment: WidgetLayoutFragmentSummaryV1 = {
      artifactId: 'saved-usage', name: 'Saved Usage', childCount: 1,
      inputs: groupInputs.inputs!, inputSchema: groupInputs.inputSchema!,
      group: { width: 'full', frameStyle: 'card', dividers: 'hairline', context: { period },
        children: [{ kind: 'widget', instance: { v: 1, definition: descriptor.definition, bindings: follower } }] },
    };
    const query = normalizeUsageQuery({ period: { relative: '7days' } });
    const context = usageWidgetSurfaceContext(readUsageWidgetPageContext(readUsageWidgetPageScope(query)), '7days');
    const add = vi.fn(async () => ({ ok: true as const }));
    const setup = buildWidgetGroupFragmentEntry({ fragment, candidates: [candidate], context,
      scope: { ...account, owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } },
      submitLabel: 'Add', add, renderGroupPreview: () => null }).setup!();

    expect(setup.resolve(setup.initial)).toMatchObject({
      status: 'ready', input: { period: { relative: 'today' }, costBasis: 'auto', session: null },
    });
    await setup.submit(setup.initial);
    expect(add).toHaveBeenCalledWith(fragment, { bindings: { period }, width: 'full' });

    const home = buildWidgetGroupFragmentEntry({ fragment, candidates: [candidate], context: {},
      scope: { ...account, owner: { kind: 'home' } }, submitLabel: 'Add', add, renderGroupPreview: () => null }).setup!();
    expect(home.resolve(home.initial)).toMatchObject({ status: 'selection_required',
      fields: expect.arrayContaining([{ path: 'costBasis', status: 'selection_required', reasonCode: 'widget_input_missing' }]) });
  });
  it('does not ask for or retain private group pins when copying to Public profile', () => {
    const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_parallel' })!;
    const candidate: WidgetCandidate = { ...descriptor, pluginName: 'Happier', sharedPluginName: false };
    const fragment: WidgetLayoutFragmentSummaryV1 = { artifactId: 'private-usage', name: 'Usage', childCount: 1,
      inputs: { fields: [{ path: 'agents', title: 'Agents', widget: 'select', required: true, optionsSourceId: 'agents' }] },
      inputSchema: { type: 'object', required: ['agents'] },
      group: { width: 'full', frameStyle: 'card', dividers: 'hairline',
        context: { agents: { kind: 'value', value: ['private-agent'] } },
        children: [{ kind: 'widget', instance: { v: 1, definition: descriptor.definition,
          bindings: { agents: { kind: 'context', slot: 'agents' }, style: { kind: 'value', value: 'lanes' } } } }] } };
    const preview = vi.fn((_fragment: WidgetLayoutFragmentSummaryV1, _draft: WidgetSetupDraft) => null);
    const setup = buildWidgetGroupFragmentEntry({ fragment, candidates: [candidate],
      scope: { ...account, owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } },
      context: {}, submitLabel: 'Add', add: async () => ({ ok: true }), renderGroupPreview: preview }).setup!();
    expect(setup.fields).toEqual([]);
    expect(setup.initial.bindings).toEqual({});
    expect(setup.resolve(setup.initial)).toMatchObject({ status: 'ready', input: {} });
    setup.renderPreview?.({ draft: setup.initial, input: {} });
    expect(preview.mock.calls[0]?.[0].group).toMatchObject({ children: [{ instance: { bindings: { style: { kind: 'value', value: 'peak' } } } }] });
    expect(JSON.stringify(preview.mock.calls)).not.toMatch(/private-agent|lanes/);
  });
  it('discovers a later child field through that child when adding a saved group', () => {
    const field = { path: 'result', title: 'Result', widget: 'select' as const, optionsSourceId: 'sessions' };
    const candidates: WidgetCandidate[] = ['first', 'second'].map((id, index) => ({
      key: id, title: id, pluginName: 'Options', sharedPluginName: false, icon: 'squares-four', homeDefault: 'available', target: 'app',
      sizeDeclaration: { sizes: ['small'], defaultSize: 'small' },
      surface: { pluginId: 'acme.options', localId: id },
      inputs: { fields: index === 0 ? [{ ...field, contextMode: 'own' }] : [field] },
    }));
    const fragment: WidgetLayoutFragmentSummaryV1 = { artifactId: 'options-fragment', name: 'Options', childCount: 2,
      inputs: { fields: [field] }, inputSchema: { type: 'object' },
      group: { width: 'full', frameStyle: 'card', dividers: 'hairline',
        children: candidates.map(candidate => ({ kind: 'widget', instance: { v: 1, definition: widgetCandidateDefinitionV1(candidate), bindings: {} } })) } };
    const setup = buildWidgetGroupFragmentEntry({ fragment, candidates, scope: { ...account, owner: { kind: 'home' } },
      context: {}, submitLabel: 'Add', add: async () => ({ ok: true }), renderGroupPreview: () => null }).setup!();
    expect(setup.optionsContext?.({ bindings: {} }, field)?.consumer).toMatchObject({ definition: fragment.group.children[1]!.instance.definition });
    const unavailable = buildWidgetGroupFragmentEntry({ fragment, candidates: [], scope: { ...account, owner: { kind: 'home' } },
      context: {}, submitLabel: 'Add', add: async () => ({ ok: true }), renderGroupPreview: () => null }).setup!();
    expect(unavailable.optionsContext?.({ bindings: {} }, field)?.consumer).toMatchObject({ definition: fragment.group.children[0]!.instance.definition });
  });
  it("previews the group live at the draft's inputs and width", async () => {
    const fragment: WidgetLayoutFragmentSummaryV1 = {
      artifactId: 'frag',
      name: 'happier',
      childCount: 1,
      inputs: { fields: [] },
      inputSchema: { type: 'object' },
      group: {
        width: 'full',
        frameStyle: 'card',
        dividers: 'hairline',
        children: [
          {
            kind: 'widget',
            size: 'small',
            instance: {
              v: 1,
              definition: {
                kind: 'installed',
                surface: { pluginId: 'acme.ci', localId: 'checks' },
              },
              bindings: {},
            },
          },
        ],
      },
    };
    const renderGroupPreview = vi.fn(() => 'live group');
    const entry = buildWidgetGroupFragmentEntry({
      fragment,
      candidates: [],
      scope: null,
      context: {},
      submitLabel: 'Add',
      add: async () => ({ ok: true }),
      renderGroupPreview,
    });
    const setup = entry.setup!();
    expect(
      setup.renderPreview?.({
        input: {},
        draft: { bindings: {}, width: 'half' },
      }),
    ).toBe('live group');
    expect(renderGroupPreview).toHaveBeenCalledWith(fragment, {
      bindings: {},
      width: 'half',
    });
  });
  it('explains the group-wide ask once, on the first input it is still needed for, never on every row', () => {
    const fields = [
      { path: 'agents', title: 'Agents', widget: 'select' as const, optionsSourceId: 'agents' },
      { path: 'project', title: 'Project', widget: 'select' as const, optionsSourceId: 'projects', required: true },
      { path: 'period', title: 'Period', widget: 'select' as const, optionsSourceId: 'periods', required: true },
    ];
    const fragment: WidgetLayoutFragmentSummaryV1 = { artifactId: 'release', name: 'Release check', childCount: 2,
      inputs: { fields }, inputSchema: { type: 'object' }, origin: { kind: 'home' }, createdAt: Date.UTC(2026, 9, 8, 12),
      group: { width: 'half', frameStyle: 'card', dividers: 'hairline', children: ['a', 'b'].map(localId => ({ kind: 'widget' as const,
        instance: { v: 1 as const, definition: { kind: 'installed' as const, surface: { pluginId: 'acme.ci', localId } }, bindings: {} } })) } };
    const setup = buildWidgetGroupFragmentEntry({ fragment, candidates: [], scope: { ...account, owner: { kind: 'home' } },
      context: {}, submitLabel: 'Add', add: async () => ({ ok: true }), renderGroupPreview: () => 'group frame' }).setup!();
    expect(setup.fields.map(entry => entry.neededHint !== undefined)).toEqual([false, true, false]);
  });
  it('says where the group came from, asks once and keeps its own frame while waiting', () => {
    const field = { path: 'project', title: 'Project', widget: 'select' as const, optionsSourceId: 'projects', required: true };
    const fragment: WidgetLayoutFragmentSummaryV1 = { artifactId: 'release', name: 'Release check', childCount: 2,
      inputs: { fields: [field] }, inputSchema: { type: 'object' }, origin: { kind: 'home' }, createdAt: Date.UTC(2026, 9, 8, 12),
      group: { width: 'half', frameStyle: 'card', dividers: 'hairline', children: ['a', 'b'].map(localId => ({ kind: 'widget' as const,
        instance: { v: 1 as const, definition: { kind: 'installed' as const, surface: { pluginId: 'acme.ci', localId } }, bindings: {} } })) } };
    const renderGroupPreview = vi.fn(() => 'group frame');
    const setup = buildWidgetGroupFragmentEntry({ fragment, candidates: [], scope: { ...account, owner: { kind: 'home' } },
      context: {}, submitLabel: 'Add', add: async () => ({ ok: true }), renderGroupPreview }).setup!();
    // Provenance is the fragment's own origin and date, not "Your widget".
    expect(setup.provenance).toContain('widgetFrame.groupProvenance');
    expect(setup.provenance).toContain('common.home');
    expect(setup.provenance).not.toContain('widgetDefinition.yourWidget');
    // One question for the group: the row says who follows the answer while it is needed.
    expect(setup.fields).toHaveLength(1);
    expect(setup.fields[0]!.neededHint).toContain('widgetFrame.groupInputAskedOnce');
    // While the answer is missing the step still draws the group's own frame, each widget waiting.
    expect(setup.renderWaitingPreview?.({ draft: { bindings: {}, width: 'half' }, waiting: 'Choose the project' })).toBe('group frame');
    expect(renderGroupPreview).toHaveBeenLastCalledWith(fragment, { bindings: {}, width: 'half' }, 'Choose the project');
  });
});

describe('where a group is saved from', () => {
  it('records Home and the kind of any other surface, never an id as a name', async () => {
    const { describeWidgetGroupOrigin } = await import('./widgetGroupCopy');
    expect(describeWidgetGroupOrigin({ ...account, owner: { kind: 'home' } }, [])).toEqual({ kind: 'home' });
    expect(describeWidgetGroupOrigin({ ...account, owner: { kind: 'project', projectId: 'gone' } }, [])).toEqual({ kind: 'project' });
    expect(describeWidgetGroupOrigin({ ...account, owner: { kind: 'corePage', pageId: 'usage', area: 'main' } }, [])).toEqual({ kind: 'corePage' });
    expect(describeWidgetGroupOrigin({ ...account, owner: { kind: 'workBoard', boardId: 'b' } }, [])).toBeUndefined();
  });
});
