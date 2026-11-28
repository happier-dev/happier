import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

// Native layout delivery is the platform boundary; the responsive header and control stay real.
vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'ios' }, I18nManager: { isRTL: false }, Dimensions: { get: () => ({ width: 0 }) },
  // A pending fact's bar pulses through the platform's animation driver; the test only needs it to mount.
  Animated: {
    Value: class { constructor(readonly value: number) {} },
    View: 'AnimatedView',
    loop: () => ({ start: () => {}, stop: () => {} }),
    sequence: (items: unknown[]) => items,
    timing: (_value: unknown, config: unknown) => config,
  },
}));

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

describe('page header hanging actions', () => {
  it('hangs a lone ⋯ from the title once wider actions leave it, instead of keeping their old width', () => {
    // #143 phone Environment page: Deploy moved to the phone's bar, leaving ⋯ alone, yet ⋯ kept a row of its own.
    const header = (wide: boolean) => <HappierPageHeader testID="header" actionsLayout="hang" leading={<View testID="mark" />}
      title={<Text testID="title">DEF-EDITOR-1110-stored-r121</Text>}
      actions={<View testID="controls">{wide ? <Pressable testID="deploy"><Text>Deploy</Text></Pressable> : null}
        <Pressable testID="more"><Text>…</Text></Pressable></View>} />;
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(header(true)); });
    try {
      const root = () => renderer.root;
      const below = () => root().findAll(node => node.props.testID === 'header-actions-below');
      const views = () => root().findAllByType('View');
      const split = () => views().find(node => node.props.onLayout && node.props.style?.flexBasis === HAPPIER_PAGE_METRICS.sectionTextMinWidthPx)!;
      const titleNatural = () => views().find(node => node.props.onLayout && node.props.style?.alignSelf === 'flex-start');
      const actions = () => measuringAncestor(root().findByProps({ testID: 'controls' }));
      deliverLayout(views().find(node => node.props.testID === 'header')!, 390, 100);
      deliverLayout(actions(), 130, 32);
      deliverLayout(split(), 304, 76);
      deliverLayout(titleNatural()!, 280, 38);
      deliverLayout(split(), 304, 76);
      // Deploy and ⋯ leave the name less than its column: they wait beneath the identity.
      expect(below()).toHaveLength(1);
      act(() => renderer.update(header(false)));
      deliverLayout(actions(), 28, 28);
      deliverLayout(split(), 304, 76);
      expect(below()).toHaveLength(0);
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

describe('page header facts line', () => {
  it('re-measures every fact when one changes, so the separator that now ends a line is hidden', () => {
    // Native layout reports a view when it mounts or its own size changes, never when it only moves to another
    // row. A fact whose text grows pushes the facts after it down without resizing them.
    const mounted = new Set<string>();
    function Glyph(props: Readonly<{ id: string }>) {
      useEffect(() => { mounted.add(props.id); }, [props.id]);
      return null;
    }
    const facts = (uptime: string) => ['presence', 'uptime', 'cores'].map(key => ({
      key, testID: `fact-${key}`, icon: <Glyph id={key} />, text: key === 'uptime' ? uptime : key,
    }));
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<HappierPageHeader testID="header" title="leeroy-mbp" meta={facts('Up 5 min')} />);
    });
    onTestFinished(() => { act(() => renderer.unmount()); });
    const fact = (key: string) => renderer.root.findAllByType('View').find(node => node.props.testID === `fact-${key}`)!;
    const separatorHidden = (key: string) => fact(key).findAll(node => node.props['aria-hidden'] === true)
      .some(node => node.props.style?.opacity === 0);
    const place = (key: string, row: number) => act(() => fact(key).props.onLayout(
      { nativeEvent: { layout: { x: 0, y: row * 18, width: 80, height: 18 } } } satisfies HappierLayoutChangeEvent));
    for (const key of ['presence', 'uptime', 'cores']) place(key, 0);
    expect(separatorHidden('presence')).toBe(false);
    expect(separatorHidden('uptime')).toBe(false);

    mounted.clear();
    act(() => renderer.update(<HappierPageHeader testID="header" title="leeroy-mbp" meta={facts('Up 5 hours 19 minutes')} />));
    // The grown fact reports its new size; a fact that remounted reports where it now stands.
    place('uptime', 0);
    if (mounted.has('presence')) place('presence', 0);
    if (mounted.has('cores')) place('cores', 1);

    expect(separatorHidden('presence')).toBe(false);
    expect(separatorHidden('uptime')).toBe(true);
  });

  it('holds a pending fact\'s place with its representative words hidden, before the facts that follow it', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<HappierPageHeader testID="header" title="Northwind"
        meta={[{ key: 'role', testID: 'role', text: 'Member', pending: true }, { key: 'home', testID: 'home', text: 'Studio' }]} />);
    });
    onTestFinished(() => { act(() => renderer.unmount()); });
    const role = renderer.root.find(node => node.props.testID === 'role' && typeof node.type === 'string');
    const home = renderer.root.find(node => node.props.testID === 'home' && typeof node.type === 'string');
    const line = role.parent!;
    // The pending fact is first on the line, so the Home after it stands where it will stand.
    expect(line.children.indexOf(role)).toBeLessThan(line.children.indexOf(home));
    // Its stand-in words keep their width but are neither drawn nor read.
    const hidden = role.findAll(node => node.props['aria-hidden'] === true && node.props.accessibilityElementsHidden === true);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden[0]!.findAll(node => node.props.style?.opacity === 0).length).toBeGreaterThan(0);
    // A fact that is known draws its words.
    expect(home.findAll(node => node.props['aria-hidden'] === true)).toHaveLength(0);
  });

  it('draws no meta line for an empty list of facts', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<HappierPageHeader testID="header" title="Northwind" description="Your Home." meta={[]} />);
    });
    onTestFinished(() => { act(() => renderer.unmount()); });
    expect(renderer.root.findAll(node => node.props.testID === 'header-meta')).toHaveLength(0);
  });

  it('draws nothing when an empty list of facts is all a hidden-title header has', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<HappierPageHeader testID="header" title="Northwind" showTitle={false} meta={[]} />);
    });
    onTestFinished(() => { act(() => renderer.unmount()); });
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('page header status without actions', () => {
  it('gives a lone status its own line under the summary at every title width, not a block beside the title', () => {
    // FIN-DESIGN-ACCEPT-4 A: on a phone the actions leave for the navigation bar; "Saved" floated beside a short
    // title and under a long one. It sits in one place, under the summary.
    for (const title of ['Plan', 'Prepare the 0.3 release and share the update']) {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(<HappierPageHeader testID="header" title={<Text testID="title">{title}</Text>}
          description="When you press Run now → run the selected Review steps"
          status={<Text testID="status">Saved</Text>} />);
      });
      try {
        const root = renderer.root;
        const views = () => root.findAllByType('View');
        deliverLayout(views().find(node => node.props.testID === 'header')!, 390, 120);
        deliverLayout(measuringAncestor(root.findByProps({ testID: 'title' })), 120, 32);
        const split = views().find(node => node.props.onLayout && node.props.style?.flexBasis === HAPPIER_PAGE_METRICS.sectionTextMinWidthPx)!;
        deliverLayout(split, 326, 80);
        // In the identity column, after the summary: the status's line comes after the description's.
        const lineIn = (node: ReactTestInstance): ReactTestInstance => node.parent === split ? node : lineIn(node.parent!);
        const lines = split.children as ReactTestInstance[];
        const descriptionLine = lineIn(root.findAll(node => node.props.children === 'When you press Run now → run the selected Review steps')[0]!);
        const statusLine = lineIn(root.findByProps({ testID: 'status' }));
        expect(lines.indexOf(statusLine)).toBeGreaterThan(lines.indexOf(descriptionLine));
        expect(root.findAll(node => node.props.testID === 'header-actions-below')).toHaveLength(0);
      } finally {
        act(() => renderer.unmount());
      }
    }
  });
});
