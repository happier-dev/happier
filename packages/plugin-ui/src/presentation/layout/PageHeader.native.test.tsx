import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

// Native layout delivery is the platform boundary; the responsive header and control stay real.
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'ios' } }));

import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierPageHeader } from './PageHeader.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';

function deliverLayout(node: ReactTestInstance, width: number, height: number) {
  const event: HappierLayoutChangeEvent = { nativeEvent: { layout: { x: 0, y: 0, width, height } } };
  act(() => node.props.onLayout(event));
}

function measuringAncestor(node: ReactTestInstance): ReactTestInstance {
  const parent = node.parent;
  if (!parent) throw new Error('Expected a native layout owner above the control.');
  return typeof parent.props.onLayout === 'function' ? parent : measuringAncestor(parent);
}

describe('page header action continuity', () => {
  it.each(['plain', 'leading identity', 'compact centered'] as const)('keeps an open control mounted while a %s header narrows and widens', presentation => {
    let mounts = 0;
    let unmounts = 0;
    function StatefulControl() {
      const [open, setOpen] = useState(false);
      useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
      return <Pressable testID="control" onPress={() => setOpen(current => !current)}>
        <Text>{open ? 'Open' : 'Closed'}</Text>
      </Pressable>;
    }

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<HappierPageHeader testID="header"
        title={<Text testID="title">Prepare the release</Text>}
        description="Review before publishing."
        leading={presentation === 'plain' ? undefined : <View testID="mark" />}
        compactPresentation={presentation === 'compact centered' ? 'centered' : undefined}
        meta={[{ key: 'machine', text: 'Development machine' }]}
        actions={<StatefulControl />} />);
    });
    try {
      const root = () => renderer.root;
      const host = () => root().findAllByType('View').find(node => node.props.testID === 'header')!;
      const split = () => root().findAllByType('View').find(node => node.props.onLayout && node.props.style?.flexBasis === HAPPIER_PAGE_METRICS.sectionTextMinWidthPx);
      deliverLayout(host(), 800, 100);
      deliverLayout(measuringAncestor(root().findByProps({ testID: 'title' })), 300, 30);
      deliverLayout(measuringAncestor(root().findByProps({ testID: 'control' })), 300, 34);
      deliverLayout(split()!, 800, 60);
      act(() => root().findByProps({ testID: 'control' }).props.onPress());
      expect(root().findByProps({ testID: 'control' }).findByType('Text').props.children).toBe('Open');

      for (const width of [400, 800]) {
        deliverLayout(host(), width, 100);
        const identity = split();
        if (identity) deliverLayout(identity, width, 60);
        expect(root().findByProps({ testID: 'control' }).findByType('Text').props.children).toBe('Open');
        expect({ mounts, unmounts }).toEqual({ mounts: 1, unmounts: 0 });
      }
    } finally {
      act(() => renderer.unmount());
    }
    expect(unmounts).toBe(1);
  });
});

describe('page header wrapped actions room', () => {
  it('stops reserving the wrapped actions row once the header no longer has actions', () => {
    const header = (actions: boolean) => <HappierPageHeader testID="header"
      title={<Text testID="title">Cafe opening plan</Text>}
      actions={actions ? <Pressable testID="control"><Text>Save</Text></Pressable> : undefined} />;
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(header(true)); });
    try {
      const root = () => renderer.root;
      const reserve = () => root().findAll(node => node.props.testID === 'header-actions-reserve');
      const split = () => root().findAllByType('View').find(node => node.props.onLayout && node.props.style?.flexBasis === HAPPIER_PAGE_METRICS.sectionTextMinWidthPx)!;
      deliverLayout(root().findAllByType('View').find(node => node.props.testID === 'header')!, 1440, 100);
      deliverLayout(measuringAncestor(root().findByProps({ testID: 'title' })), 186, 28);
      deliverLayout(measuringAncestor(root().findByProps({ testID: 'control' })), 150, 32);
      deliverLayout(split(), 860, 32);
      expect(reserve()).toHaveLength(0);
      // A narrow window: the actions wrap beneath the identity and their row keeps its room.
      deliverLayout(split(), 300, 32);
      expect(reserve()).toHaveLength(1);
      // The phone's navigation chrome takes Save and Cancel: nothing is left to reserve room for.
      act(() => renderer.update(header(false)));
      expect(reserve()).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  });
});

describe('page header entrance parts', () => {
  it('lets an entrance hold the mark and the title apart from the lines and actions that support them', () => {
    const parts: string[] = [];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<HappierPageHeader testID="header" title="leeroy-mbp" description="Calm. 2 sessions working."
        leading={<View testID="mark" />} meta={[{ key: 'presence', text: 'Online' }]} actionsLayout="inline"
        actions={<Pressable testID="start"><Text>Start session</Text></Pressable>}
        wrapPart={(part, node) => { parts.push(part); return <View testID={`part-${part}`}>{node}</View>; }} />);
    });
    onTestFinished(() => { act(() => renderer.unmount()); });
    const part = (name: string) => renderer.root.findAll(node => node.props.testID === `part-${name}`);
    const inside = (name: string, testID: string) => part(name).some(wrapper => wrapper.findAll(node => node.props.testID === testID).length > 0);
    expect(inside('mark', 'mark')).toBe(true);
    expect(part('title').some(wrapper => wrapper.findAllByType('Text').some(text => text.props.children === 'leeroy-mbp'))).toBe(true);
    // The identity never carries its facts or its actions: they fade, they do not travel.
    expect(part('title').some(wrapper => wrapper.findAllByType('Text').some(text => text.props.children === 'Online'))).toBe(false);
    expect(part('supporting').some(wrapper => wrapper.findAllByType('Text').some(text => text.props.children === 'Online'))).toBe(true);
    expect(inside('supporting', 'start')).toBe(true);
    expect(inside('mark', 'start') || inside('title', 'start')).toBe(false);
    expect(new Set(parts)).toEqual(new Set(['mark', 'title', 'supporting']));
  });
});
