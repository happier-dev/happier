import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetLayoutFragmentSummaryV1 } from '@happier-dev/protocol/widgets';
import { widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildWidgetGroupFragmentEntry } from './widgetGroupFragmentSetup';

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

afterEach(() => standardCleanup());

const account = { serverId: 's', accountId: 'a' };

describe('Add to… for a group', () => {
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
  it('says where the group came from, asks once, keeps its own frame while waiting and names what Add does', () => {
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
    // The footer names the outcome with the value the group will follow.
    const outcome = setup.describeOutcome?.({ draft: { bindings: {}, width: 'half' }, values: ['happier'] });
    expect(outcome).toContain('widgetFrame.groupAddsFollowing');
    expect(outcome).toContain('happier');
    expect(outcome).toContain('Release check');
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
