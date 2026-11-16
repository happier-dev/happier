import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

// The native host is the boundary; owner layout and text remain real.
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'ios' }, I18nManager: { isRTL: false } }));

import { HAPPIER_MENU_ROW_SHAPE } from '../interaction/Menu.js';
import { HappierNoticeLine } from '../interaction/ApprovalPendingNotice.js';
import { HappierPageHeader } from './PageHeader.js';
import { SURFACE_THEME_FIXTURE } from '../../surfaceFixture.testSupport.js';

function mount(node: ReactNode, check: (renderer: ReactTestRenderer) => void) {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(node); });
  try { check(renderer); } finally { act(() => renderer.unmount()); }
}

describe('ruled primitive anatomy', () => {
  it('keeps menu highlights edge to edge and square (owner 2026-11-08)', () => {
    expect(HAPPIER_MENU_ROW_SHAPE.marginHorizontal).toBe(0);
    expect(HAPPIER_MENU_ROW_SHAPE.borderRadius).toBe(0);
  });

  it('keeps the purpose against the title and permits a second line instead of truncating it', () => {
    mount(<HappierPageHeader title="Models" description="Choose the models available to your sessions on this Home." />, renderer => {
      const description = renderer.root.findAllByType('Text').find(node => node.props.children === 'Choose the models available to your sessions on this Home.')!;
      expect(description).toBeDefined();
      // A two-line sentence must remain readable; no one-line clamp, fixed height or extra inter-line gap.
      expect(description.props.numberOfLines === undefined || description.props.numberOfLines >= 2).toBe(true);
      let wrapper = description.parent;
      while (wrapper && wrapper.type !== 'View') wrapper = wrapper.parent;
      expect(wrapper?.props.style?.marginTop).toBe(0);
      expect(wrapper?.props.style?.height).toBeUndefined();
    });
  });

  it.each([undefined, 'DeepSeek V4 Pro'])('keeps a notice quiet with subject %s, a polite announcement and one next step', subject => {
    mount(<HappierNoticeLine testID="notice" theme={SURFACE_THEME_FIXTURE} icon={<Text>!</Text>}
      subject={subject} title="Waiting for approval" action={<Text testID="next">Open approval</Text>} />, renderer => {
      const line = renderer.root.findAllByType('View').find(node => node.props.testID === 'notice')!;
      expect(line.props.accessibilityLiveRegion).toBe('polite');
      expect(line.props.style.backgroundColor).toBeUndefined();
      expect(line.props.style.borderWidth).toBeUndefined();
      const words = line.findAllByType('Text').map(node => node.props.children);
      expect(words).toEqual(subject ? ['!', subject, '·', 'Waiting for approval', 'Open approval'] : ['!', 'Waiting for approval', 'Open approval']);
      expect(line.findAllByType('Text').filter(node => node.props.testID === 'next')).toHaveLength(1);
    });
  });
});
