import { act, useState } from 'react';
import { Text as NativeText } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { HappierTabs, type HappierTabDescriptor } from '../presentation/navigation/Tabs.js';
import { Tabs, Text, useTabPanelActivity } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mountTabs(element: React.ReactElement, context = createSurfaceContext()) {
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {element}
    </PluginUiProvider>,
  );
}

describe('controlled Tabs', () => {
  it('renders a quiet state marker and includes its meaning in the tab name without changing the visible title', () => {
    const theme = createSurfaceContext().theme;
    function TabDescriptor(_props: HappierTabDescriptor) { return null; }
    const mount = mountThroughReactNativeWeb(<HappierTabs theme={theme} value="overview" onValueChange={() => {}} testID="views">
      <TabDescriptor value="overview" title="Overview" marker="Edited" />
      <TabDescriptor value="mine" title="Mine" />
    </HappierTabs>);
    try {
      const edited = mount.container.querySelector('[data-testid="views:overview"]');
      expect(edited?.getAttribute('aria-label')).toBe('Overview Edited');
      expect(edited?.textContent).toBe('Overview');
      expect(mount.container.querySelector('[data-testid="views:overview:marker"]')).not.toBeNull();
      expect(mount.container.querySelector('[data-testid="views:mine:marker"]')).toBeNull();
    } finally { mount.unmount(); }
  });
  it('draws a strip-only tablist with its trailing controls and no empty panel when the host shows the selection elsewhere', () => {
    const theme = createSurfaceContext().theme;
    function TabDescriptor(_props: HappierTabDescriptor) { return null; }
    const mount = mountThroughReactNativeWeb(<HappierTabs theme={theme} value="overview" onValueChange={() => {}} ariaLabel="Views" testID="views"
      sharedPanel={null} trailing={<NativeText testID="views-create">+</NativeText>}>
      <TabDescriptor value="overview" title="Overview" />
      <TabDescriptor value="costs" title="Costs" />
    </HappierTabs>);
    try {
      expect(mount.container.querySelector('[role="tablist"]')).not.toBeNull();
      expect(mount.container.querySelector('[role="tabpanel"]')).toBeNull();
      const trailing = mount.container.querySelector('[data-testid="views-create"]');
      expect(trailing).not.toBeNull();
      // Beside the strip, not inside the scrolling tablist.
      expect(mount.container.querySelector('[role="tablist"]')?.contains(trailing)).toBe(false);
    } finally { mount.unmount(); }
  });
  it('renders and switches core tabs with an explicit theme and no plugin environment', async () => {
    const theme = createSurfaceContext().theme;
    function TabDescriptor(_props: HappierTabDescriptor) { return null; }
    function CoreTabs() {
      const [value, setValue] = useState('activity');
      return <HappierTabs theme={theme} value={value} onValueChange={setValue} ariaLabel="Core views" testID="core-tabs">
        <TabDescriptor value="activity" title="Activity" />
        <TabDescriptor value="logs" title="Logs" badge="3" badgeTone="warning" />
      </HappierTabs>;
    }
    const mount = mountThroughReactNativeWeb(<CoreTabs />);
    try {
      const tabs = [...mount.container.querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs.map(tab => tab.getAttribute('aria-label'))).toEqual(['Activity', 'Logs']);
      expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
      expect(tabs[1]?.textContent).toContain('3');
      await act(async () => { tabs[1]?.click(); });
      expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    } finally { mount.unmount(); }
  });

  it('keeps selection caller-owned and exposes tab semantics', async () => {
    const onValueChange = vi.fn();
    const mount = mountTabs(
      <Tabs value="activity" onValueChange={onValueChange} ariaLabel="Inspector sections">
        <Tabs.Item value="activity" title="Activity"><Text value="Activity content" /></Tabs.Item>
        <Tabs.Item value="logs" title="Logs" badge="3"><Text value="Log content" /></Tabs.Item>
      </Tabs>,
    );

    expect(mount.container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Inspector sections');
    const tabs = [...mount.container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(mount.container.textContent).toContain('Activity content');
    expect(mount.container.textContent).not.toContain('Log content');

    await act(async () => { tabs[1]?.click(); });
    expect(onValueChange).toHaveBeenCalledWith('logs');
    mount.unmount();
  });

  it('reconciles a missing controlled value instead of silently rendering a fallback tab', async () => {
    const onValueChange = vi.fn();
    const mount = mountTabs(
      <Tabs value="removed" onValueChange={onValueChange} ariaLabel="Inspector sections">
        <Tabs.Item value="activity" title="Activity"><Text value="Activity content" /></Tabs.Item>
        <Tabs.Item value="logs" title="Logs"><Text value="Log content" /></Tabs.Item>
      </Tabs>,
    );

    await act(async () => { await Promise.resolve(); });

    expect(onValueChange).toHaveBeenCalledWith('activity');
    mount.unmount();
  });

  it('reports duplicate opaque values without crashing the page or rendering ambiguous tabs and panels', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onValueChange = vi.fn();
    const mount = mountTabs(
      <Tabs value="activity" onValueChange={() => {}} ariaLabel="Inspector sections">
        <Tabs.Item value="activity" title="Activity one"><Text value="Kept content" /></Tabs.Item>
        <Tabs.Item value="activity" title="Activity two"><Text value="Ambiguous content" /></Tabs.Item>
        <Tabs.Item value="logs" title="Logs"><Text value="Logs content" /></Tabs.Item>
      </Tabs>,
    );
    try {
      const tabs = [...mount.container.querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs.map(tab => tab.getAttribute('aria-label'))).toEqual(['Activity one', 'Logs']);
      expect(mount.container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
      expect(mount.container.textContent).toContain('Kept content');
      expect(mount.container.textContent).not.toContain('Ambiguous content');
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("duplicate tab value 'activity'"));
      await mount.render(
        <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
          <Tabs value="activity" onValueChange={onValueChange} ariaLabel="Inspector sections">
            <Tabs.Item value="activity" title="Activity one" />
            <Tabs.Item value="logs" title="Logs" />
          </Tabs>
        </PluginUiProvider>,
      );
      const recovered = [...mount.container.querySelectorAll<HTMLElement>('[role="tab"]')];
      await act(async () => { recovered[1]?.click(); });
      expect(onValueChange).toHaveBeenCalledWith('logs');
    } finally { mount.unmount(); diagnostic.mockRestore(); }
  });

  it('recovers focus by semantic value when an opaque value contains the former delimiter', async () => {
    function DelimitedValueHarness() {
      const [showFocused, setShowFocused] = useState(true);
      return (
        <>
          <button data-testid="remove-focused" onClick={() => setShowFocused(false)}>Remove</button>
          <Tabs value={showFocused ? 'review\u001factive' : 'overview'} onValueChange={() => {}} ariaLabel="Review sections">
            <Tabs.Item value="overview" title="Overview" />
            {showFocused ? <Tabs.Item value="review\u001factive" title="Review" /> : null}
            <Tabs.Item value="active" title="Active" />
          </Tabs>
        </>
      );
    }

    const mount = mountTabs(<DelimitedValueHarness />);
    const before = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'));
    await act(async () => { before[1]?.focus(); });
    expect(document.activeElement).toBe(before[1]);

    await act(async () => {
      mount.container.querySelector<HTMLButtonElement>('[data-testid="remove-focused"]')?.click();
    });

    const after = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(document.activeElement).toBe(after[0]);
    mount.unmount();
  });

  it('renders a caller-provided tab mark without changing the tab name exposed to assistive technology', () => {
    const mount = mountTabs(
      <Tabs value="activity" onValueChange={() => {}} ariaLabel="Provider filters">
        <Tabs.Item
          value="activity"
          title="Activity"
          icon={<span aria-hidden="true" data-testid="activity-provider-mark">A</span>}
        >
          <Text value="Activity content" />
        </Tabs.Item>
      </Tabs>,
    );

    const tab = mount.container.querySelector<HTMLElement>('[role="tab"]');
    expect(tab?.getAttribute('aria-label')).toBe('Activity');
    expect(tab?.querySelector('[data-testid="activity-provider-mark"]')).not.toBeNull();
    mount.unmount();
  });

  it('keeps one roving tab stop while arrow and Home keys move controlled selection and focus', async () => {
    function TabsHarness() {
      const [value, setValue] = useState('activity');
      return (
        <Tabs value={value} onValueChange={setValue} ariaLabel="Inspector sections">
          <Tabs.Item value="activity" title="Activity"><Text value="Activity content" /></Tabs.Item>
          <Tabs.Item value="files" title="Files" disabled><Text value="File content" /></Tabs.Item>
          <Tabs.Item value="logs" title="Logs"><Text value="Log content" /></Tabs.Item>
        </Tabs>
      );
    }

    const mount = mountTabs(<TabsHarness />);
    let tabs = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

    await act(async () => {
      tabs[0]?.focus();
      tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    tabs = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);

    await act(async () => {
      tabs[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });

    tabs = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    mount.unmount();
  });

  it('uses the projected RTL direction for horizontal arrow movement', async () => {
    function RtlTabsHarness() {
      const [value, setValue] = useState('middle');
      return (
        <Tabs value={value} onValueChange={setValue} ariaLabel="RTL sections">
          <Tabs.Item value="first" title="First" />
          <Tabs.Item value="middle" title="Middle" />
          <Tabs.Item value="last" title="Last" />
        </Tabs>
      );
    }

    const context = createSurfaceContext({ direction: 'rtl' });
    const mount = mountTabs(<RtlTabsHarness />, context);
    let tabs = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'));
    await act(async () => {
      tabs[1]?.focus();
      tabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    tabs = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    mount.unmount();
  });
});

describe('a tab strip owned by the host frame', () => {
  it('retains a visited host panel while withdrawing its active interval', async () => {
    const signals: AbortSignal[] = [];
    function Counter() {
      const [count, setCount] = useState(0);
      const activity = useTabPanelActivity();
      if (activity.active) signals.push(activity.activeSignal);
      return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
    }
    function Harness() {
      const [value, setValue] = useState('occurrences');
      return <>
        <button data-testid="switch-panel" onClick={() => setValue(value === 'occurrences' ? 'trace' : 'occurrences')}>Switch</button>
        <Tabs value={value} onValueChange={setValue} ariaLabel="Error detail" tabList="host">
          <Tabs.Item value="occurrences" title="Occurrences" retention="retain"><Counter /></Tabs.Item>
          <Tabs.Item value="trace" title="Trace"><Text value="Trace body" /></Tabs.Item>
        </Tabs>
      </>;
    }
    const mount = mountTabs(<Harness />);
    const firstInterval = signals.at(-1)!;
    await act(async () => { mount.container.querySelector<HTMLButtonElement>('button:not([data-testid])')?.click(); });
    await act(async () => { mount.container.querySelector<HTMLButtonElement>('[data-testid="switch-panel"]')?.click(); });
    expect(firstInterval.aborted).toBe(true);
    await act(async () => { mount.container.querySelector<HTMLButtonElement>('[data-testid="switch-panel"]')?.click(); });
    expect(mount.container.textContent).toContain('Count 1');
    expect(signals.at(-1)?.aborted).toBe(false);
    mount.unmount();
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it('renders only the selected panel, with its active interval, and no tablist', async () => {
    const seen: boolean[] = [];
    function Probe() {
      const activity = useTabPanelActivity();
      seen.push(activity.active && !activity.activeSignal.aborted);
      return <Text value="Files content" />;
    }
    const mount = mountTabs(
      <Tabs value="files" onValueChange={() => undefined} ariaLabel="Entry detail" tabList="host">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview content" /></Tabs.Item>
        <Tabs.Item value="files" title="Files"><Probe /></Tabs.Item>
      </Tabs>,
    );

    expect(mount.container.querySelector('[role="tablist"]')).toBeNull();
    expect(mount.container.querySelector('[role="tab"]')).toBeNull();
    // The strip that names this panel lives in another surface, so the panel
    // claims no tabpanel role it cannot label.
    expect(mount.container.querySelector('[role="tabpanel"]')).toBeNull();
    expect(mount.container.textContent).toContain('Files content');
    expect(mount.container.textContent).not.toContain('Overview content');
    expect(seen.at(-1)).toBe(true);
  });
});

describe('one shared renderer behind a tab strip', () => {
  it('keeps shared state across tab selection and labels the one current panel', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return <button data-testid="shared-count" onClick={() => setCount(count + 1)}>Selected occurrence {count}</button>;
    }
    function Harness() {
      const [value, setValue] = useState('occurrences');
      return <Tabs value={value} onValueChange={setValue} ariaLabel="Source detail" sharedPanel={<Counter />}>
        <Tabs.Item value="occurrences" title="Occurrences" />
        <Tabs.Item value="trace" title="Trace" />
      </Tabs>;
    }
    const mount = mountTabs(<Harness />);
    await act(async () => { mount.container.querySelector<HTMLButtonElement>('[data-testid="shared-count"]')?.click(); });
    await act(async () => { mount.container.querySelectorAll<HTMLElement>('[role="tab"]')[1]?.click(); });
    expect(mount.container.textContent).toContain('Selected occurrence 1');
    const panels = mount.container.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    expect(panels).toHaveLength(1);
    expect(panels[0]?.getAttribute('aria-labelledby')).toBe(mount.container.querySelectorAll<HTMLElement>('[role="tab"]')[1]?.id);
    mount.unmount();
  });
});

describe('a tabbed region that fills its parent', () => {
  // A panel that hosts a bounded view (a live Session, a self-scrolling source
  // panel) needs the tab root and the active panel to take the remaining
  // height; content-sized Tabs inside a scroll area must keep their height.
  function fillOf(element: HTMLElement | null | undefined): string | undefined {
    return element?.style.flexGrow;
  }

  it('gives the root and the active panel the remaining height only when asked to fill', () => {
    const filled = mountTabs(
      <Tabs testID="filled" value="session" onValueChange={() => undefined} ariaLabel="Entry detail" layout="fill">
        <Tabs.Item value="details" title="Details" retention="retain"><Text value="Details content" /></Tabs.Item>
        <Tabs.Item value="session" title="Session"><Text value="Session content" /></Tabs.Item>
      </Tabs>,
    );
    const filledRoot = filled.container.querySelector<HTMLElement>('[data-testid="filled"]');
    const filledPanel = filled.container.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(fillOf(filledRoot)).toBe('1');
    expect(fillOf(filledPanel)).toBe('1');
    filled.unmount();

    const content = mountTabs(
      <Tabs testID="content" value="session" onValueChange={() => undefined} ariaLabel="Entry detail">
        <Tabs.Item value="session" title="Session"><Text value="Session content" /></Tabs.Item>
      </Tabs>,
    );
    expect(fillOf(content.container.querySelector<HTMLElement>('[data-testid="content"]'))).not.toBe('1');
    expect(fillOf(content.container.querySelector<HTMLElement>('[role="tabpanel"]'))).not.toBe('1');
    content.unmount();
  });
});

describe('tab labels', () => {
  it('shows glyph-only tabs when labels are hidden and every tab has a glyph, keeping each accessible name', () => {
    const glyph = (name: string) => <NativeText testID={`glyph-${name}`}>{name[0]}</NativeText>;
    const mount = mountTabs(
      <Tabs testID="views" value="chat" onValueChange={() => undefined} ariaLabel="Views" labels="none">
        <Tabs.Item value="chat" title="Chat" icon={glyph('chat')} marker="Unread" />
        <Tabs.Item value="files" title="Files" icon={glyph('files')} />
      </Tabs>,
    );
    try {
      const chat = mount.container.querySelector('[data-testid="views:chat"]');
      const files = mount.container.querySelector('[data-testid="views:files"]');
      expect(chat?.getAttribute('aria-label')).toBe('Chat Unread');
      expect(files?.getAttribute('aria-label')).toBe('Files');
      expect(chat?.textContent).toBe('c');
      expect(files?.textContent).toBe('f');
    } finally { mount.unmount(); }
  });

  it('keeps every label when one tab lacks a glyph, so a half-iconic strip never reads as broken', () => {
    const mount = mountTabs(
      <Tabs testID="mixed" value="chat" onValueChange={() => undefined} ariaLabel="Views" labels="none">
        <Tabs.Item value="chat" title="Chat" icon={<NativeText>c</NativeText>} />
        <Tabs.Item value="files" title="Files" />
      </Tabs>,
    );
    try {
      expect(mount.container.querySelector('[data-testid="mixed:chat"]')?.textContent).toBe('cChat');
      expect(mount.container.querySelector('[data-testid="mixed:files"]')?.textContent).toBe('Files');
    } finally { mount.unmount(); }
  });
});
