import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Tabs } from './Tabs.js';

type TabSpec = Readonly<{ value: string; title: string }>;

const triggerNamed = (mount: Readonly<{ container: HTMLElement }>, title: string) => (
  Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'))
    .find((trigger) => trigger.textContent?.includes(title))
);

async function focusTrigger(trigger: HTMLElement | undefined): Promise<void> {
  await act(async () => { trigger?.focus(); });
}

describe('Tabs focus recovery when a conditional tab disappears', () => {
  function mountConditionalTabs(input: Readonly<{
    tabs: readonly TabSpec[];
    value: string;
    onValueChange: (value: string) => void;
  }>) {
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    const tree = (current: Readonly<{ tabs: readonly TabSpec[]; value: string }>) => (
      <PluginUiProvider hostApi={hostApi} context={context}>
        <Tabs value={current.value} onValueChange={input.onValueChange} ariaLabel="Issue detail" testID="detail-tabs">
          {current.tabs.map((tab) => (
            <Tabs.Item key={tab.value} value={tab.value} title={tab.title}>
              <React.Fragment>{`${tab.title} content`}</React.Fragment>
            </Tabs.Item>
          ))}
        </Tabs>
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(tree({ tabs: input.tabs, value: input.value }));
    return { mount, tree };
  }

  const allTabs: readonly TabSpec[] = [
    { value: 'occurrences', title: 'Occurrences' },
    { value: 'replays', title: 'Replays' },
    { value: 'activity', title: 'Activity' },
  ];

  it('hands focus to the reachable trigger when the focused non-selected tab is removed', async () => {
    const changes: string[] = [];
    const { mount, tree } = mountConditionalTabs({
      tabs: allTabs,
      value: 'occurrences',
      onValueChange: (value) => changes.push(value),
    });

    // A reader has arrowed onto Replays but has not activated it.
    await focusTrigger(triggerNamed(mount, 'Replays'));
    expect(document.activeElement).toBe(triggerNamed(mount, 'Replays'));

    // The source withdraws Replays — replay availability is a live provider fact.
    await mount.render(tree({ tabs: allTabs.filter((tab) => tab.value !== 'replays'), value: 'occurrences' }));

    expect(triggerNamed(mount, 'Replays')).toBeUndefined();
    // Focus must not fall out of the tablist onto the document body.
    expect(document.activeElement).toBe(triggerNamed(mount, 'Occurrences'));
    // Selection was never the reader's, so removing a tab they only visited
    // must not commit one.
    expect(changes).toEqual([]);
    mount.unmount();
  });

  it('hands focus to the fallback trigger when the focused selected tab is removed', async () => {
    const changes: string[] = [];
    const { mount, tree } = mountConditionalTabs({
      tabs: allTabs,
      value: 'replays',
      onValueChange: (value) => changes.push(value),
    });

    await focusTrigger(triggerNamed(mount, 'Replays'));
    await mount.render(tree({ tabs: allTabs.filter((tab) => tab.value !== 'replays'), value: 'replays' }));

    // The incumbent reconciliation reports the fallback selection exactly once.
    expect(changes).toEqual(['occurrences']);
    expect(document.activeElement).toBe(triggerNamed(mount, 'Occurrences'));
    mount.unmount();
  });

  it('leaves focus where it is when a tab other than the focused one is removed', async () => {
    const { mount, tree } = mountConditionalTabs({
      tabs: allTabs,
      value: 'occurrences',
      onValueChange: () => {},
    });

    // Focus sits on a trigger that is NOT the selected one, so an owner that
    // recovered focus on every tab-set change would visibly yank it back to
    // the selected trigger instead of leaving the reader where they are.
    await focusTrigger(triggerNamed(mount, 'Replays'));
    await mount.render(tree({ tabs: allTabs.filter((tab) => tab.value !== 'activity'), value: 'occurrences' }));

    expect(triggerNamed(mount, 'Replays')).toBeDefined();
    expect(document.activeElement).toBe(triggerNamed(mount, 'Replays'));
    mount.unmount();
  });

  it('does not pull focus back into the tablist when the reader has moved outside it', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const { mount, tree } = mountConditionalTabs({
      tabs: allTabs,
      value: 'occurrences',
      onValueChange: () => {},
    });

    await focusTrigger(triggerNamed(mount, 'Replays'));
    await act(async () => { outside.focus(); });
    expect(document.activeElement).toBe(outside);

    await mount.render(tree({ tabs: allTabs.filter((tab) => tab.value !== 'replays'), value: 'occurrences' }));

    // Stealing focus back would interrupt whatever the reader moved on to.
    expect(document.activeElement).toBe(outside);
    mount.unmount();
    outside.remove();
  });
});
