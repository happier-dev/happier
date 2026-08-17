import { act, StrictMode, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Tabs, Text, useTabPanelActivity, type TabPanelActivity } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

/**
 * `Tabs.Item` retention and the panel active-interval signal.
 *
 * The contract under test is the source-neutral half of a source detail view:
 * an expensively parsed panel may stay mounted across a tab switch, while a
 * panel holding revealed provider material must disappear on leave. Both
 * declarations are explicit — the omission keeps the incumbent unmount
 * behaviour, so no existing caller silently acquires retention.
 *
 * `activeSignal` is deliberately not "mounted": a retained panel keeps its
 * subtree and its parsed state while its active interval ends, which is exactly
 * how a source aborts live reads without discarding parse work.
 */
function mountTabs(element: React.ReactElement) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {element}
    </PluginUiProvider>,
  );
}

function readTabs(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
}

function readPanels(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
}

async function selectTab(container: HTMLElement, index: number): Promise<void> {
  await act(async () => {
    readTabs(container)[index]?.click();
  });
}

describe('Tabs panel retention and active interval', () => {
  it('unmounts a panel that declares no retention, so an incumbent caller keeps its cleanup', async () => {
    const cleanup = vi.fn();

    function IncumbentPanel() {
      useEffect(() => cleanup, []);
      return <Text value="Incumbent content" />;
    }

    function Harness() {
      const [value, setValue] = useState('incumbent');
      return (
        <Tabs value={value} onValueChange={setValue} ariaLabel="Sections">
          <Tabs.Item value="incumbent" title="Incumbent"><IncumbentPanel /></Tabs.Item>
          <Tabs.Item value="other" title="Other"><Text value="Other content" /></Tabs.Item>
        </Tabs>
      );
    }

    const mount = mountTabs(<Harness />);
    expect(mount.container.textContent).toContain('Incumbent content');

    await selectTab(mount.container, 1);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(readPanels(mount.container)).toHaveLength(1);
    expect(mount.container.textContent).not.toContain('Incumbent content');
    mount.unmount();
  });

  it('mounts only the selected panel on first visit', () => {
    const mount = mountTabs(
      <Tabs value="overview" onValueChange={() => {}} ariaLabel="Sections">
        <Tabs.Item value="overview" title="Overview" retention="retain"><Text value="Overview content" /></Tabs.Item>
        <Tabs.Item value="occurrences" title="Occurrences" retention="retain"><Text value="Occurrence content" /></Tabs.Item>
      </Tabs>,
    );

    expect(readPanels(mount.container)).toHaveLength(1);
    expect(mount.container.textContent).not.toContain('Occurrence content');
    mount.unmount();
  });

  it('keeps a retained panel mounted with its parsed state while ending its active interval', async () => {
    let parseRuns = 0;
    const intervals: AbortSignal[] = [];
    let latest: TabPanelActivity | undefined;

    function RetainedPanel() {
      const activity = useTabPanelActivity();
      const [parsed] = useState(() => {
        parseRuns += 1;
        return `parsed-${parseRuns}`;
      });
      latest = activity;
      if (intervals.at(-1) !== activity.activeSignal) intervals.push(activity.activeSignal);
      return <Text value={parsed} />;
    }

    function Harness() {
      const [value, setValue] = useState('occurrences');
      return (
        <Tabs value={value} onValueChange={setValue} ariaLabel="Sections">
          <Tabs.Item value="occurrences" title="Occurrences" retention="retain"><RetainedPanel /></Tabs.Item>
          <Tabs.Item value="activity" title="Activity"><Text value="Activity content" /></Tabs.Item>
        </Tabs>
      );
    }

    const mount = mountTabs(<Harness />);
    expect(parseRuns).toBe(1);
    expect(latest?.active).toBe(true);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.aborted).toBe(false);

    await selectTab(mount.container, 1);

    // Still mounted, still holding its parse work; the interval has ended.
    expect(parseRuns).toBe(1);
    expect(mount.container.textContent).toContain('parsed-1');
    expect(latest?.active).toBe(false);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.aborted).toBe(true);

    await selectTab(mount.container, 0);

    expect(parseRuns).toBe(1);
    expect(latest?.active).toBe(true);
    expect(intervals).toHaveLength(2);
    expect(intervals[1]?.aborted).toBe(false);
    mount.unmount();
  });

  it('removes a retained inactive panel from layout and the accessibility tree', async () => {
    function RetainedPanel() {
      useTabPanelActivity();
      return <Text value="Occurrence content" />;
    }

    function Harness() {
      const [value, setValue] = useState('occurrences');
      return (
        <Tabs value={value} onValueChange={setValue} ariaLabel="Sections">
          <Tabs.Item value="occurrences" title="Occurrences" retention="retain"><RetainedPanel /></Tabs.Item>
          <Tabs.Item value="activity" title="Activity"><Text value="Activity content" /></Tabs.Item>
        </Tabs>
      );
    }

    const mount = mountTabs(<Harness />);
    await selectTab(mount.container, 1);

    const panels = readPanels(mount.container);
    expect(panels).toHaveLength(2);
    const retained = panels.find((panel) => panel.textContent?.includes('Occurrence content'));
    const active = panels.find((panel) => panel.textContent?.includes('Activity content'));

    expect(retained?.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(retained!).display).toBe('none');
    expect(active?.getAttribute('aria-hidden')).toBeNull();
    expect(getComputedStyle(active!).display).not.toBe('none');
    mount.unmount();
  });

  it('aborts and unmounts a panel that explicitly discards, and remounts it fresh on return', async () => {
    let mountRuns = 0;
    const intervals: AbortSignal[] = [];

    function SensitivePanel() {
      const activity = useTabPanelActivity();
      const [reveal] = useState(() => {
        mountRuns += 1;
        return `reveal-${mountRuns}`;
      });
      if (intervals.at(-1) !== activity.activeSignal) intervals.push(activity.activeSignal);
      return <Text value={reveal} />;
    }

    function Harness() {
      const [value, setValue] = useState('stack');
      return (
        <Tabs value={value} onValueChange={setValue} ariaLabel="Sections">
          <Tabs.Item value="stack" title="Stack Trace" retention="discard"><SensitivePanel /></Tabs.Item>
          <Tabs.Item value="activity" title="Activity"><Text value="Activity content" /></Tabs.Item>
        </Tabs>
      );
    }

    const mount = mountTabs(<Harness />);
    expect(mount.container.textContent).toContain('reveal-1');

    await selectTab(mount.container, 1);

    expect(readPanels(mount.container)).toHaveLength(1);
    expect(mount.container.textContent).not.toContain('reveal-1');
    expect(intervals[0]?.aborted).toBe(true);

    await selectTab(mount.container, 0);

    expect(mountRuns).toBe(2);
    expect(mount.container.textContent).toContain('reveal-2');
    expect(intervals).toHaveLength(2);
    expect(intervals[1]?.aborted).toBe(false);
    mount.unmount();
  });

  it('aborts every live active interval when the Tabs owner itself unmounts', () => {
    const intervals: AbortSignal[] = [];

    function RetainedPanel() {
      const activity = useTabPanelActivity();
      if (intervals.at(-1) !== activity.activeSignal) intervals.push(activity.activeSignal);
      return <Text value="Overview content" />;
    }

    const mount = mountTabs(
      <Tabs value="overview" onValueChange={() => {}} ariaLabel="Sections">
        <Tabs.Item value="overview" title="Overview" retention="retain"><RetainedPanel /></Tabs.Item>
      </Tabs>,
    );

    expect(intervals[0]?.aborted).toBe(false);
    mount.unmount();
    expect(intervals[0]?.aborted).toBe(true);
  });

  it('reopens the interval a StrictMode effect replay just ended', () => {
    let latest: TabPanelActivity | undefined;

    function RetainedPanel() {
      latest = useTabPanelActivity();
      return <Text value="Overview content" />;
    }

    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <StrictMode>
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <Tabs value="overview" onValueChange={() => {}} ariaLabel="Sections">
            <Tabs.Item value="overview" title="Overview" retention="retain"><RetainedPanel /></Tabs.Item>
          </Tabs>
        </PluginUiProvider>
      </StrictMode>,
    );

    expect(latest?.active).toBe(true);
    expect(latest?.activeSignal.aborted).toBe(false);
    mount.unmount();
    expect(latest?.activeSignal.aborted).toBe(true);
  });

  it('refuses to fabricate an active interval outside a panel', () => {
    function Stray() {
      useTabPanelActivity();
      return null;
    }

    expect(() => mountTabs(<Stray />)).toThrow(/useTabPanelActivity/u);
  });

  it('keeps one reachable tab stop when the controlled value names a disabled tab', () => {
    const mount = mountTabs(
      <Tabs value="disabled-first" onValueChange={() => {}} ariaLabel="Sections">
        <Tabs.Item value="disabled-first" title="Disabled" disabled><Text value="Disabled content" /></Tabs.Item>
        <Tabs.Item value="logs" title="Logs"><Text value="Log content" /></Tabs.Item>
      </Tabs>,
    );

    expect(readTabs(mount.container).map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0']);
    mount.unmount();
  });
});
