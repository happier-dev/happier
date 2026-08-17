import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Tabs } from './Tabs.js';

const SOURCE_TABS = [
  'Occurrences', 'Stack trace', 'Breadcrumbs', 'Tags', 'Replays',
  'Attachments', 'Similar issues', 'Merged issues', 'User feedback', 'Activity',
] as const;

function mountTabStrip(): ReturnType<typeof mountThroughReactNativeWeb> {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <Tabs value="Occurrences" onValueChange={() => {}} ariaLabel="Issue detail" testID="detail-tabs">
        {SOURCE_TABS.map((title) => (
          <Tabs.Item key={title} value={title} title={title}>
            <React.Fragment>{`${title} content`}</React.Fragment>
          </Tabs.Item>
        ))}
      </Tabs>
    </PluginUiProvider>,
  );
}

function scrollableAncestorsOf(element: Element, root: Element): HTMLElement[] {
  const scrollers: HTMLElement[] = [];
  let current: Element | null = element.parentElement;
  while (current !== null && root.contains(current)) {
    if (/auto|scroll/u.test(getComputedStyle(current).overflowX)) scrollers.push(current as HTMLElement);
    current = current.parentElement;
  }
  return scrollers;
}

describe('Tabs horizontal overflow', () => {
  it('keeps the trigger strip on one line inside a single horizontal scroller', () => {
    const mount = mountTabStrip();
    const tablist = mount.container.querySelector<HTMLElement>('[role="tablist"]');
    expect(tablist).not.toBeNull();

    // A wrapped strip reflows the panel below it every time a source adds or
    // removes a tab, so the strip scrolls instead of wrapping.
    expect(getComputedStyle(tablist!).flexWrap).toBe('nowrap');

    const scrollers = scrollableAncestorsOf(tablist!, mount.container);
    expect(scrollers.length).toBe(1);
    expect(getComputedStyle(scrollers[0]!).overflowY).toBe('hidden');

    // Every trigger stays a direct child of the tablist, so the scroller does
    // not break the tab-to-tablist ownership assistive technology relies on.
    const triggers = Array.from(tablist!.children);
    expect(triggers.every((child) => child.getAttribute('role') === 'tab')).toBe(true);
    expect(triggers.length).toBe(SOURCE_TABS.length);

    // In a row that never wraps, a flexible trigger is compressed until its
    // label is unreadable; the scroller, not the trigger, absorbs the overflow.
    for (const trigger of triggers) expect(getComputedStyle(trigger).flexShrink).toBe('0');
    mount.unmount();
  });
});
