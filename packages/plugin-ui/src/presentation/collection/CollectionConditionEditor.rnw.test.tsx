import { act } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { describe, expect, it } from 'vitest';
import { createWorkflowListFilterRegistryV1 } from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';
import { admitPluginListFilterFieldV1 } from '@happier-dev/protocol/collections/filter/pluginListFilterFieldV1';
import { normalizeSessionListFilterV1, sessionWorkFilterFields } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { listSessionPresentationStatesForWorkStatusFilterV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  applyCollectionConditionEdit,
  conditionModelFromFilter,
  type CollectionConditionEdit,
  type CollectionConditionValueCountRequest,
} from './conditionModel.js';
import {
  HappierCollectionConditionEditor,
  type HappierCollectionConditionEditorHost,
  type HappierCollectionConditionEditorLabels,
} from './CollectionConditionEditor.js';
import { HappierMaterialRoleProvider } from '../layout/Surface.js';

function renderedBackground(color: string): string {
  const probe = document.createElement('div');
  probe.style.backgroundColor = color;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

// The host primitives are the injected boundary; the editor's anatomy and edits under test are its own.
const host: HappierCollectionConditionEditorHost = {
  Text: (props) => <Text testID={props.testID}>{props.children}</Text>,
  Icon: (props) => <View testID={`icon-${props.name}`} />,
  SearchField: (props) => (
    <TextInput
      testID={props.testID ?? 'search'}
      value={props.value}
      placeholder={props.placeholder}
    />
  ),
  Button: (props) => (
    <Pressable testID={props.testID} onPress={props.onPress}>
      <Text>{props.label}</Text>
    </Pressable>
  ),
  useColors: () => ({
    fill: '#eee',
    fillHover: '#ddd',
    divider: '#ccc',
    focus: '#00f',
  }),
};

const labels: HappierCollectionConditionEditorLabels = {
  title: 'Filter',
  clear: 'Clear',
  add: 'Add filter',
  addSearch: 'Filter by…',
  or: 'or',
  operators: {
    is: 'is',
    is_not: "isn't",
    before: 'before',
    after: 'after',
    between: 'between',
    unavailable: 'unavailable',
  },
  remove: (field) => `Remove ${field}`,
  count: (count) => `${count} items`,
  countPartial: (count) => `${count} loaded`,
  saveAsSpace: 'Save as space…',
  done: 'Done',
  noFields: 'No fields',
  noValues: 'No values',
};

function stageField() {
  const admitted = admitPluginListFilterFieldV1({
    pluginId: 'test.release',
    factKeys: new Set(['stage']),
    field: {
      id: 'stage',
      title: 'Release stage',
      source: { factKey: 'stage' },
      value: {
        kind: 'set',
        options: [
          { value: 'ready', title: 'Ready' },
          { value: 'blocked', title: 'Blocked' },
        ],
      },
    },
  });
  if (admitted.kind !== 'admitted') throw new Error('Invalid fixture');
  return admitted.field;
}

const press = (container: HTMLElement, testID: string) =>
  act(() => {
    (
      container.querySelector(`[data-testid="${testID}"]`) as HTMLElement
    ).click();
  });

describe('HappierCollectionConditionEditor', () => {
  it('routes custom paged values through the selected set operator and preserves both rows', async () => {
    const included = { serverId: 'home', machineId: 'included' };
    const excluded = { serverId: 'home', machineId: 'excluded' };
    let filter = normalizeSessionListFilterV1({ machines: { include: [included], exclude: [] } });
    const view = () => <HappierCollectionConditionEditor host={host} labels={labels}
      model={conditionModelFromFilter(sessionWorkFilterFields, filter)}
      onChange={edit => { filter = applyCollectionConditionEdit(sessionWorkFilterFields, filter, edit); }}
      renderValuePicker={input => input.field.id === 'machines' ? <>
        <Text testID="custom-operator">{input.operator}</Text>
        <Text testID="custom-values">{JSON.stringify(input.values)}</Text>
        <Pressable testID="custom-pick" onPress={() => input.onChange([excluded])}><Text>Pick</Text></Pressable>
      </> : null} />;
    const mount = mountThroughReactNativeWeb(view());
    try {
      await press(mount.container, 'collection-filter-condition:machines:is:value');
      await press(mount.container, 'collection-filter-values:machines:operator:is_not');
      expect(mount.container.querySelector('[data-testid="collection-filter-values:machines:operator:is_not"]')?.getAttribute('aria-checked')).toBe('true');
      expect(mount.container.querySelector('[data-testid="custom-operator"]')?.textContent).toBe('is_not');
      expect(mount.container.querySelector('[data-testid="custom-values"]')?.textContent).toBe('[]');
      await press(mount.container, 'custom-pick');
      expect(filter.machines).toEqual({ include: [included], exclude: [excluded] });
      await mount.render(view());
      await press(mount.container, 'collection-filter-values:machines:operator:is');
      expect(mount.container.querySelector('[data-testid="custom-values"]')?.textContent).toBe(JSON.stringify([included]));
    } finally { mount.unmount(); }
  });
  it('emits the supplied Project surface on the real opened project choices without binding other fields', async () => {
    const project = { serverId: 'home', projectKey: 'project' };
    let filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
    const view = () => (
      <HappierCollectionConditionEditor host={host} labels={labels}
        model={conditionModelFromFilter(sessionWorkFilterFields, filter, { fields: {
          projects: { label: 'Project', valueOptions: [
            { value: project, label: 'Workspace' },
            { value: { serverId: 'home', projectKey: 'unavailable' }, label: 'Unavailable workspace', disabled: true },
          ] },
        } })}
        valueSurfaceByField={{ projects: {
          root: { surface: 'project-picker', part: 'root', state: 'default' },
          row: { surface: 'project-picker', part: 'row', state: 'default' },
        } }}
        onChange={edit => { filter = applyCollectionConditionEdit(sessionWorkFilterFields, filter, edit); }} />
    );
    const mount = mountThroughReactNativeWeb(view());
    try {
      await press(mount.container, 'collection-filter-field:projects');
      const choices = mount.container.querySelector('[data-testid="collection-filter-values:projects"]');
      expect(choices?.textContent).toContain('Workspace');
      expect(choices?.getAttribute('data-surface')).toBe('project-picker');
      expect(choices?.getAttribute('data-part')).toBe('root');
      expect(choices?.getAttribute('data-state')).toBe('default');
      expect(choices?.querySelector('[data-surface="project-picker"][data-part="row"][data-state="default"]')?.textContent).toContain('Workspace');
      expect(choices?.querySelector('[data-surface="project-picker"][data-part="row"][data-state="disabled"]')?.textContent).toContain('Unavailable workspace');
      await act(() => choices?.querySelector<HTMLElement>('[data-part="row"][data-state="default"]')?.click());
      await mount.render(view());
      expect(mount.container.querySelector('[data-surface="project-picker"][data-part="row"][data-state="selected"]')?.textContent).toContain('Workspace');
      expect(mount.container.querySelector('[data-surface="project-picker"][data-part="root"]')?.getAttribute('data-state')).toBe('default');
      await press(mount.container, 'collection-filter-field:statuses');
      expect(mount.container.querySelector('[data-testid="collection-filter-values:statuses"]')?.getAttribute('data-surface')).toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('demands value counts only for an open value list, keeps demand stable on count arrivals and releases it on collapse/unmount', async () => {
    const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
    const demands: (CollectionConditionValueCountRequest | null)[] = [];
    const onValuePickerChange = (request: CollectionConditionValueCountRequest | null) => demands.push(request);
    const view = (count?: number) => <HappierCollectionConditionEditor host={host} labels={labels}
      model={conditionModelFromFilter(sessionWorkFilterFields, filter, count === undefined ? {} : {
        valueCounts: { fieldId: 'statuses', options: [{ value: 'working', count }] },
      })} onChange={() => {}} onValuePickerChange={onValuePickerChange} />;
    const mount = mountThroughReactNativeWeb(view());
    expect(demands).toEqual([]);
    await press(mount.container, 'collection-filter-field:statuses');
    expect(demands).toHaveLength(1);
    expect(demands[0]).toMatchObject({ fieldId: 'statuses', options: expect.arrayContaining([{ value: 'working',
      values: listSessionPresentationStatesForWorkStatusFilterV1('working') }]) });
    await mount.render(view(7));
    await mount.render(view(8));
    expect(demands).toHaveLength(1);
    // Pressing the field again folds its values away.
    await press(mount.container, 'collection-filter-field:statuses');
    expect(demands.at(-1)).toBeNull();
    await press(mount.container, 'collection-filter-field:statuses');
    expect(demands).toHaveLength(3);
    mount.unmount();
    expect(demands).toHaveLength(4);
    expect(demands.at(-1)).toBeNull();
  });

  it('draws each value\'s held count beside it, and nothing where there is no local evidence (lab clfilter:add)', async () => {
    const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
    const mount = mountThroughReactNativeWeb(<HappierCollectionConditionEditor host={host} labels={labels}
      model={conditionModelFromFilter(sessionWorkFilterFields, filter, {
        valueCounts: { fieldId: 'statuses', options: [{ value: 'working', count: 9 }, { value: 'idle', count: 0 }] },
      })} onChange={() => {}} />);
    await press(mount.container, 'collection-filter-field:statuses');
    const countOf = (value: string) => mount.container
      .querySelector(`[data-testid="collection-filter-value-count:statuses:${value}"]`)?.textContent ?? null;
    expect(countOf('working')).toBe('9');
    expect(countOf('idle')).toBe('0');
    expect(countOf('failed')).toBeNull();
    mount.unmount();
  });

  it('fills a condition\'s value field with the containing material, so on glass it is a field-on-glass tint, not an opaque block (owner 11-11 #01)', () => {
    const glassField = 'rgba(235, 230, 225, 0.1)';
    const registry = createWorkflowListFilterRegistryV1([stageField()]);
    const mount = mountThroughReactNativeWeb(
      <HappierMaterialRoleProvider role="floating" resolveMaterialColor={() => glassField}>
        <HappierCollectionConditionEditor host={host} labels={labels}
          model={conditionModelFromFilter(registry, { view: 'triggered' as const }, {})} onChange={() => {}} />
      </HappierMaterialRoleProvider>,
    );
    const value = mount.container.querySelector<HTMLElement>('[data-testid="collection-filter-condition:view:is:value"]')!;
    expect(getComputedStyle(value).backgroundColor).toBe(renderedBackground(glassField));
    mount.unmount();
  });

  it('keeps the filter and every field it can add in one view: a field opens its values in place, and a pick becomes its condition there (owner 11-11 #01)', async () => {
    const stage = stageField();
    const registry = createWorkflowListFilterRegistryV1([stage]);
    let filter: Parameters<typeof applyCollectionConditionEdit>[1] = { view: 'triggered' as const };
    const view = () => (
      <HappierCollectionConditionEditor host={host} labels={labels}
        model={conditionModelFromFilter(registry, filter, {})}
        onChange={(edit) => { filter = applyCollectionConditionEdit(registry, filter, edit); }}
        result={{ matchedCount: 3, coverage: 'complete' }} onDone={() => {}} doneLabel="Show results" />
    );
    const mount = mountThroughReactNativeWeb(view());
    const query = (testID: string) => mount.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    // The existing condition and the field to add stand together, with no Add filter step to a second view.
    expect(query('collection-filter-condition:view:is')).not.toBeNull();
    const field = query(`collection-filter-field:${stage.id}`)!;
    expect(field).not.toBeNull();
    expect(field.getAttribute('aria-expanded')).toBe('false');
    await press(mount.container, `collection-filter-field:${stage.id}`);
    expect(query(`collection-filter-field:${stage.id}`)!.getAttribute('aria-expanded')).toBe('true');
    // Its values open in place: the title, Clear, the other condition and Show results all stay.
    expect(query(`collection-filter-values:${stage.id}`)).not.toBeNull();
    expect(query('collection-filter-picker')).toBeNull();
    expect(query('collection-filter-clear')).not.toBeNull();
    expect(query('collection-filter-condition:view:is')).not.toBeNull();
    expect(query('collection-filter-done')).not.toBeNull();
    await press(mount.container, `collection-filter-value:${stage.id}:ready`);
    await mount.render(view());
    // The pick is the field's condition, in the same place, its values still open for a second pick.
    expect(query(`collection-filter-condition:${stage.id}:is`)).not.toBeNull();
    expect(query(`collection-filter-values:${stage.id}`)).not.toBeNull();
    // Its value field folds and unfolds the same values in place.
    await press(mount.container, `collection-filter-condition:${stage.id}:is:value`);
    expect(query(`collection-filter-values:${stage.id}`)).toBeNull();
    await press(mount.container, `collection-filter-condition:${stage.id}:is:value`);
    expect(query(`collection-filter-values:${stage.id}`)).not.toBeNull();
    mount.unmount();
  });

  it('draws no empty footer band when it has no count and no action to show', () => {
    const registry = createWorkflowListFilterRegistryV1([stageField()]);
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={conditionModelFromFilter(registry, { view: 'all' as const }, { fields: {} })}
        onChange={() => {}}
      />,
    );
    expect(mount.container.querySelector('[data-testid="collection-filter-count"]')).toBeNull();
    mount.unmount();
  });

  it('adds, narrows, flips and removes a plugin-owned condition as edits its owner applies', async () => {
    const stage = stageField();
    const registry = createWorkflowListFilterRegistryV1([stage]);
    const bindings = {
      fields: {
        [stage.id]: {
          label: 'Release stage',
          valueOptions: [
            { value: 'ready', label: 'Ready' },
            { value: 'blocked', label: 'Blocked' },
          ],
        },
      },
    };
    let filter: Parameters<typeof applyCollectionConditionEdit>[1] = {
      view: 'all' as const,
    };
    const edits: CollectionConditionEdit[] = [];
    const view = () => (
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={conditionModelFromFilter(registry, filter, bindings)}
        onChange={(edit) => {
          edits.push(edit);
          filter = applyCollectionConditionEdit(registry, filter, edit);
        }}
        result={{ matchedCount: 3, coverage: 'complete' }}
      />
    );
    const mount = mountThroughReactNativeWeb(view());
    expect(
      mount.container.querySelector('[data-testid="collection-filter-count"]')
        ?.textContent,
    ).toBe('3 items');

    await press(mount.container, `collection-filter-field:${stage.id}`);
    await press(mount.container, `collection-filter-value:${stage.id}:ready`);
    expect(edits.at(-1)).toEqual({
      type: 'add',
      condition: { fieldId: stage.id, operator: 'is', values: ['ready'] },
    });
    await mount.render(view());
    // A set field stays open for more; a second value joins the same condition.
    await press(mount.container, `collection-filter-value:${stage.id}:blocked`);
    expect(edits.at(-1)).toMatchObject({
      type: 'change',
      condition: { values: ['ready', 'blocked'] },
    });
    await mount.render(view());
    await press(mount.container, `collection-filter-condition:${stage.id}:is:value`);
    expect(mount.container.textContent).toContain('Ready');
    expect(mount.container.textContent).toContain('Blocked');

    await press(
      mount.container,
      `collection-filter-condition:${stage.id}:is:operator`,
    );
    expect(edits.at(-1)).toMatchObject({
      type: 'change',
      condition: { operator: 'is_not' },
    });
    await mount.render(view());
    await press(
      mount.container,
      `collection-filter-condition:${stage.id}:is_not:remove`,
    );
    expect(edits.at(-1)).toMatchObject({ type: 'remove' });
    await mount.render(view());
    expect(
      mount.container.querySelector(
        `[data-testid^="collection-filter-condition:${stage.id}"]`,
      ),
    ).toBeNull();
    mount.unmount();
  });

  it('picks a grouped choice as its whole value vector, checks it, names it once and unpicks it whole (P6 grouped Status)', async () => {
    let filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
    const working = listSessionPresentationStatesForWorkStatusFilterV1('working');
    const needsYou = listSessionPresentationStatesForWorkStatusFilterV1('needs_you');
    const base = conditionModelFromFilter(sessionWorkFilterFields, filter).availableFields.find((field) => field.id === 'statuses')!;
    const bindings = {
      fields: {
        statuses: {
          label: 'Status',
          valueOptions: base.valueOptions.map((option) => ({ ...option, label: option.value === 'working' ? 'Working' : String(option.value) })),
        },
      },
    };
    const edits: CollectionConditionEdit[] = [];
    const view = () => (
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={conditionModelFromFilter(sessionWorkFilterFields, filter, bindings)}
        onChange={(edit) => {
          edits.push(edit);
          filter = applyCollectionConditionEdit(sessionWorkFilterFields, filter, edit);
        }}
      />
    );
    const mount = mountThroughReactNativeWeb(view());
    await press(mount.container, 'collection-filter-field:statuses');
    await press(mount.container, 'collection-filter-value:statuses:working');
    expect(edits.at(-1)).toEqual({ type: 'add', condition: { fieldId: 'statuses', operator: 'is', values: [...working] } });
    await mount.render(view());
    const workingOption = mount.container.querySelector('[data-testid="collection-filter-value:statuses:working"]');
    expect(workingOption?.getAttribute('aria-checked')).toBe('true');
    await press(mount.container, 'collection-filter-value:statuses:needs_you');
    expect(edits.at(-1)).toMatchObject({ type: 'change', condition: { values: [...working, ...needsYou] } });
    await mount.render(view());
    await press(mount.container, 'collection-filter-value:statuses:working');
    expect(edits.at(-1)).toMatchObject({ type: 'change', condition: { values: [...needsYou] } });
    await mount.render(view());
    await press(mount.container, 'collection-filter-value:statuses:working');
    await mount.render(view());
    await press(mount.container, 'collection-filter-condition:statuses:is:value');
    // The row names the group once, not each state it stands for.
    const row = mount.container.querySelector('[data-testid="collection-filter-condition:statuses:is"]');
    expect(row?.textContent).toContain('Working');
    for (const state of working) expect(row?.textContent).not.toContain(state);
    mount.unmount();
  });

  it('keeps a locked base row without its remove, hides base-equal rows, and edits a hidden row when its field is added', async () => {
    const registry = createWorkflowListFilterRegistryV1([]);
    const edits: CollectionConditionEdit[] = [];
    const model = conditionModelFromFilter(
      registry,
      { view: 'triggered' as const },
      {},
    );
    const viewRow = model.rows.find((row) => row.fieldId === 'view')!;
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={model}
        onChange={(edit) => edits.push(edit)}
        lockedFieldIds={new Set(['view'])}
      />,
    );
    expect(
      mount.container.querySelector(
        '[data-testid="collection-filter-condition:view:is"]',
      ),
    ).not.toBeNull();
    expect(
      mount.container.querySelector(
        '[data-testid="collection-filter-condition:view:is:remove"]',
      ),
    ).toBeNull();

    await mount.render(
      <HappierCollectionConditionEditor
        host={host}
        labels={labels}
        model={model}
        onChange={(edit) => edits.push(edit)}
        hiddenFieldIds={new Set(['view'])}
      />,
    );
    expect(
      mount.container.querySelector(
        '[data-testid="collection-filter-condition:view:is"]',
      ),
    ).toBeNull();
    await press(mount.container, 'collection-filter-field:view');
    await press(mount.container, 'collection-filter-value:view:running');
    expect(edits.at(-1)).toEqual({
      type: 'change',
      rowId: viewRow.id,
      condition: { fieldId: 'view', operator: 'is', values: ['running'] },
    });
    mount.unmount();
  });
});
