import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { isHappierTabSelected } from '../presentation/navigation/Tabs.js';
import { Tabs, Text } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mountTabs(element: React.ReactElement, context = createSurfaceContext()) {
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {element}
    </PluginUiProvider>,
  );
}

describe('controlled Tabs', () => {
  it('shares the controlled selection equality used by the core segmented-tab adapter', () => {
    expect(isHappierTabSelected('activity', 'activity')).toBe(true);
    expect(isHappierTabSelected('activity', 'logs')).toBe(false);
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

  it('rejects duplicate opaque values before rendering ambiguous tab and panel identities', () => {
    expect(() => mountTabs(
      <Tabs value="activity" onValueChange={() => {}} ariaLabel="Inspector sections">
        <Tabs.Item value="activity" title="Activity one" />
        <Tabs.Item value="activity" title="Activity two" />
      </Tabs>,
    )).toThrow(/duplicate tab value/u);
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
