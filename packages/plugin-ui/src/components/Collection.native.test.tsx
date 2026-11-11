import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';

// The native SDK is the boundary. Keep the real host barrel, Collection row,
// virtualizer adapter and the author's accessibility callback beneath it.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: <T,>(values: { ios?: T; native?: T; default?: T }) => values.ios ?? values.native ?? values.default },
  Easing: { bezier: () => (value: number) => value },
  PanResponder: { create: (handlers: Record<string, unknown>) => ({ panHandlers: handlers }) },
  StyleSheet: { hairlineWidth: 0.5, create: <T,>(styles: T) => styles },
  I18nManager: { isRTL: false },
  FlatList: function NativeFlatList(props: { data: readonly unknown[]; renderItem: (input: { item: unknown; index: number }) => React.ReactNode }) {
    return <>{props.data.map((item, index) => <React.Fragment key={index}>{props.renderItem({ item, index })}</React.Fragment>)}</>;
  },
  SectionList: 'SectionList',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

import { Collection, HostCollection, useHappierCollection } from '../index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Row } from './Layout.js';

let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

it.each([['public', Collection], ['host', HostCollection]] as const)(
  'mounts the %s Collection from the host barrel on native and announces its row',
  (_name, Component) => {
    const context = createSurfaceContext({ platform: 'ios' });
    function NativeList() {
      const model = useHappierCollection({ items: ['task'], keyOf: item => item, openKey: null, onOpenChange: () => {} });
      return <Component model={model} presentation="list" detail="none" accessibilityLabel="Tasks"
        anatomy={{ glyph: () => null, title: item => item, accessibilityLabel: item => item,
          accessibilityHint: item => `${item} is ready`, testID: item => item, columnTitles: { title: 'Task' } }} />;
    }
    act(() => {
      renderer = create(<PluginUiProvider context={context} hostApi={createHostApiStub(context)}><NativeList /></PluginUiProvider>);
    });
    expect(renderer!.root.find(node => node.type === 'Pressable' && node.props.testID === 'task').props.accessibilityHint).toBe('task is ready');
  },
);

it('keeps a native Collection row readable when its timestamp hint has no RelativeTimeFormat', () => {
  const intl = globalThis.Intl;
  vi.stubGlobal('Intl', { DateTimeFormat: intl.DateTimeFormat, NumberFormat: intl.NumberFormat });
  const context = createSurfaceContext({ platform: 'ios' });
  const now = Date.UTC(2026, 10, 11, 1);
  const at = now - 4 * 60_000;
  function TimestampList() {
    const model = useHappierCollection({ items: ['task'], keyOf: item => item, openKey: null, onOpenChange: () => {} });
    return <HostCollection model={model} presentation="list" detail="none" accessibilityLabel="Tasks"
      anatomy={{ glyph: () => null, title: item => item, accessibilityLabel: item => item,
        accessibilityHint: () => formatTriageTimestampV1('en', at, 'relative', now),
        testID: item => item, columnTitles: { title: 'Task' } }} />;
  }
  act(() => {
    renderer = create(<PluginUiProvider context={context} hostApi={createHostApiStub(context)}><TimestampList /></PluginUiProvider>);
  });
  expect(renderer!.root.find(node => node.type === 'Pressable' && node.props.testID === 'task').props.accessibilityHint)
    .toBe(new intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(at));
});

it('mounts the native task-detail layout through the current HappierStack owner', () => {
  const context = createSurfaceContext({ platform: 'ios' });
  act(() => {
    renderer = create(
      <PluginUiProvider context={context} hostApi={createHostApiStub(context)}>
        <Row testID="task-detail-layout"><View testID="task-detail-child" /></Row>
      </PluginUiProvider>,
    );
  });
  expect(renderer!.root.find(node => node.type === 'View' && node.props.testID === 'task-detail-layout').props.style).toEqual(
    expect.arrayContaining([expect.objectContaining({ flexDirection: 'row' })]),
  );
});
