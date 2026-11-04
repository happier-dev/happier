import type { ReactNode } from 'react';
import { Text, TextInput, View, Pressable } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiPlatform } from '@happier-dev/plugin-sdk/ui';

import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { HappierUiPlatformProvider } from '../environment/context.js';
import { HappierListItem } from './collection/List.js';
import { resolveHappierCollectionRowHeight } from './collection/CollectionRowContent.js';
import { HappierCollectionConditionEditor, type HappierCollectionConditionEditorHost } from './collection/CollectionConditionEditor.js';
import { conditionModelFromFilter } from './collection/conditionModel.js';
import { normalizeSessionListFilterV1, sessionWorkFilterFields } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { HappierFieldStepper } from './form/FieldStepper.js';
import { resolveHappierFieldTextInputMetrics, HAPPIER_FIELD_BOX_METRICS } from './form/FieldBox.js';
import { HappierSelect } from './form/Fields.js';
import { resolveHappierPageRowMetrics } from './layout/pageRowMetrics.js';
import { HAPPIER_TREE_ROW_METRICS } from './navigation/TreeRow.js';

/**
 * A touch target is the hit area, never the drawn control (DESIGN.md → Accessibility). Rows, forms and
 * data marks keep their designed size under a finger; their hit areas reach past the drawn box only into
 * the real gap beside them, so neighbours never overlap.
 */
const theme = SURFACE_CONTEXT_THEME_FIXTURE;

function mountIn(platform: PluginUiPlatform, children: ReactNode) {
  return mountThroughReactNativeWeb(
    <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>{children}</HappierUiPlatformProvider>,
  );
}

function emulateCoarsePointer() {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const px = (value: string) => Number.parseFloat(value) || 0;

function byTestId(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (node === null) throw new Error(`missing ${id}`);
  return node;
}

function hitFrame(control: HTMLElement) {
  const frame = control.querySelector<HTMLElement>(':scope > [data-happier-hit-area="true"]');
  if (frame === null) return null;
  const style = getComputedStyle(frame);
  return { top: 0 - px(style.top), bottom: 0 - px(style.bottom), left: 0 - px(style.left), right: 0 - px(style.right) };
}

describe('row geometry stays designed under a finger', () => {
  it('draws every page row density at its own height on touch', () => {
    for (const density of ['comfortable', 'cozy', 'compact', 'inspector'] as const) {
      for (const shape of ['standard', 'list'] as const) {
        expect(resolveHappierPageRowMetrics({ density, shape, touch: true }).minHeightPx)
          .toBe(resolveHappierPageRowMetrics({ density, shape, touch: false }).minHeightPx);
      }
    }
    expect(resolveHappierPageRowMetrics({ density: 'compact', shape: 'list', touch: true }).minHeightPx).toBeLessThan(44);
  });

  it('keeps a compact collection row at a readable design height, not the finger target', () => {
    expect(resolveHappierCollectionRowHeight('compact', true)).toBeLessThan(44);
    expect(resolveHappierCollectionRowHeight('compact', true)).toBeGreaterThanOrEqual(resolveHappierCollectionRowHeight('compact', false));
  });

  it('draws a phone-narrow tree at the touch density rather than a finger floor', () => {
    expect((HAPPIER_TREE_ROW_METRICS as Record<string, unknown>).compactMinHeightPx).toBeUndefined();
  });

  for (const [platform] of [['ios'], ['android']] as const) {
    it(`keeps a tight ${platform} list row at its density and never reaches over the next row`, () => {
      const mount = mountIn(platform, <View>
        <HappierListItem theme={theme} density="tight" title="First" onPress={() => {}} testID="first" />
        <HappierListItem theme={theme} density="tight" title="Second" onPress={() => {}} testID="second" />
      </View>);
      try {
        const row = byTestId(mount.container, 'first');
        expect(px(getComputedStyle(row).minHeight)).toBe(36);
        const frame = hitFrame(row);
        // Flush rows have no gap to reach into: the row is its own hit area.
        expect(frame === null || (frame.top === 0 && frame.bottom === 0)).toBe(true);
      } finally { mount.unmount(); }
    });
  }
});

describe('form controls stay designed under a finger', () => {
  it('fills the field box with a single-line input instead of growing it to the target', () => {
    const metrics = resolveHappierFieldTextInputMetrics({ nativeMinimumTargetSize: 48 });
    expect(metrics.minHeight).toBeLessThanOrEqual(HAPPIER_FIELD_BOX_METRICS.minHeightPx);
  });

  it('draws stepper buttons at the field height and reaches outward only', () => {
    const mount = mountIn('ios', <HappierFieldStepper
      colors={{ borderColor: 'gray', backgroundColor: 'white' }} focusColor="blue" decreaseLabel="Less" increaseLabel="More"
      canDecrement canIncrement onStep={() => {}} renderSymbol={(symbol) => <Text>{symbol}</Text>} testID="count">
      <Text>3</Text>
    </HappierFieldStepper>);
    try {
      const minus = byTestId(mount.container, 'count.decrement');
      const plus = byTestId(mount.container, 'count.increment');
      expect(px(getComputedStyle(minus).minHeight)).toBe(HAPPIER_FIELD_BOX_METRICS.minHeightPx);
      expect(px(getComputedStyle(minus).minWidth)).toBe(HAPPIER_FIELD_BOX_METRICS.minHeightPx);
      expect(hitFrame(minus)).toMatchObject({ top: 6, bottom: 6, left: 6, right: 0 });
      expect(hitFrame(plus)).toMatchObject({ top: 6, bottom: 6, left: 0, right: 6 });
    } finally { mount.unmount(); }
  });

  it('draws select options at their content size', () => {
    const mount = mountIn('android', <HappierSelect label="Plan" theme={theme} value="a" onChange={() => {}}
      options={[{ value: 'a', label: 'A', testID: 'opt-a' }, { value: 'b', label: 'B', testID: 'opt-b' }]} />);
    try {
      const option = byTestId(mount.container, 'opt-a');
      // Content-sized: its hit area is measured on layout and reaches half the gap between options.
      expect(px(getComputedStyle(option).minHeight)).toBeLessThan(48);
    } finally { mount.unmount(); }
  });
});

describe('collection filter rows stay designed under a finger', () => {
  const host: HappierCollectionConditionEditorHost = {
    Text: (props) => <Text testID={props.testID}>{props.children}</Text>,
    Icon: () => <View />,
    SearchField: (props) => <TextInput testID={props.testID ?? 'search'} value={props.value} />,
    Button: (props) => <Pressable testID={props.testID} onPress={props.onPress}><Text>{props.label}</Text></Pressable>,
    useColors: () => ({ fill: '#eee', fillHover: '#ddd', divider: '#ccc', focus: '#00f' }),
    touchTargetPx: 44,
  };
  const labels = {
    title: 'Filter', clear: 'Clear', add: 'Add filter', addSearch: 'Filter by…', back: 'Back', or: 'or',
    operators: { is: 'is', is_not: "isn't", before: 'before', after: 'after', between: 'between', unavailable: 'unavailable' },
    remove: (field: string) => `Remove ${field}`, count: (count: number) => `${count} items`, countPartial: (count: number) => `${count} loaded`,
    saveAsSpace: 'Save as space…', done: 'Done', noFields: 'No fields', noValues: 'No values',
  };
  it('keeps condition rows, remove and add at their design size and reaches only into the gaps', () => {
    emulateCoarsePointer();
    const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
    const mount = mountThroughReactNativeWeb(<HappierCollectionConditionEditor host={host} labels={labels}
      model={conditionModelFromFilter(sessionWorkFilterFields, filter, {})} onChange={() => {}} />);
    try {
      const add = byTestId(mount.container, 'collection-filter-add');
      expect(px(getComputedStyle(add).minHeight)).toBe(32);
      const remove = mount.container.querySelector<HTMLElement>('[data-testid$=":remove"]')!;
      expect(px(getComputedStyle(remove).width)).toBe(22);
      expect(px(getComputedStyle(remove).height)).toBe(22);
      const frame = hitFrame(remove)!;
      // Row 34 tall, controls 6 apart: the remove reaches the row's edges and half the gap to the value.
      expect(frame).toMatchObject({ top: 6, bottom: 6, left: 3 });
      const row = remove.closest<HTMLElement>('[data-testid^="collection-filter-condition:"]:not([data-testid$=":remove"])')!;
      expect(px(getComputedStyle(row).minHeight)).toBe(34);
    } finally { mount.unmount(); }
  });
});
