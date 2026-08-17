import { act, useState, type ReactNode, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb, mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import {
  createHostApiStub,
  createSurfaceContext,
  SURFACE_THEME_FIXTURE,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Button } from './Button.js';
import { Text } from './Text.js';
import { ScrollArea } from './Layout.js';
import { ContextMenu, Dropdown, Menu, Popover, type MenuItem } from './Overlay.js';

// @ts-expect-error Checkbox menu rows must always publish a boolean checked state.
const invalidUncheckedCheckbox: MenuItem = { id: 'unchecked', label: 'Unchecked', kind: 'checkbox' };
void invalidUncheckedCheckbox;

type RenderPopover = (input: Readonly<{
  open: boolean;
  anchorRef: RefObject<unknown>;
  followScrollRef?: RefObject<unknown>;
  focusReturnRef?: RefObject<unknown>;
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  autoFocusOnOpen?: boolean;
  onRequestClose(): void;
  content: ReactNode;
}>) => ReactNode;

function createPresentationHost(renderPopover: RenderPopover, maxHeight = 240): PluginUiPresentationHost {
  return {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: (input) => renderPopover({
      open: input.open,
      anchorRef: input.anchorRef,
      followScrollRef: input.followScrollRef,
      focusReturnRef: input.focusReturnRef,
      placement: input.placement,
      autoFocusOnOpen: input.autoFocusOnOpen,
      onRequestClose: input.onRequestClose,
      content: input.content({ requestClose: () => input.onRequestClose(), maxHeight }),
    }),
    renderIcon: () => null,
  };
}

function mountWithPresentationHost(children: ReactNode, renderPopover: RenderPopover, maxHeight?: number) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PluginUiPresentationHostProviderInternal
        host={createPresentationHost(renderPopover, maxHeight)}
      >
        {children}
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>,
  );
}

function findBoundedScrollableAncestor(target: HTMLElement | undefined, maxHeight: number): HTMLElement | null {
  const expectedMaxHeight = `${maxHeight}px`;
  for (let current = target?.parentElement ?? null; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.maxHeight === expectedMaxHeight && style.overflowY !== 'visible') return current;
  }
  return null;
}

function resolveRenderedColor(
  property: 'backgroundColor' | 'borderTopColor',
  value: string,
): string {
  const probe = document.createElement('div');
  probe.style[property] = value;
  document.body.appendChild(probe);
  const rendered = getComputedStyle(probe)[property];
  probe.remove();
  return rendered;
}

function hasProjectedSurfaceChrome(element: HTMLElement | null): boolean {
  const expectedBackground = resolveRenderedColor('backgroundColor', SURFACE_THEME_FIXTURE.colors.surface);
  const expectedBorder = resolveRenderedColor('borderTopColor', SURFACE_THEME_FIXTURE.colors.border);
  const candidates = new Set<HTMLElement>();
  for (let current = element; current; current = current.parentElement) {
    candidates.add(current);
  }
  element?.querySelectorAll<HTMLElement>('*').forEach((candidate) => candidates.add(candidate));
  for (const candidate of candidates) {
    const style = getComputedStyle(candidate);
    if (
      style.backgroundColor === expectedBackground
      && style.borderTopWidth === '1px'
      && style.borderTopColor === expectedBorder
    ) {
      return true;
    }
  }
  return false;
}

describe('controlled overlay presentation', () => {
  it('rejects interactive trigger children across every public overlay entry point', async () => {
    const context = createSurfaceContext();
    const interactiveTrigger = (
      <Button title="Open options" onPress={() => undefined} />
    ) as unknown as string;
    const render = (overlay: ReactNode) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        {overlay}
      </PluginUiProvider>
    );

    for (const overlay of [
      (
        <Popover
          key="popover"
          open={false}
          onOpenChange={() => undefined}
          trigger={interactiveTrigger}
          triggerAccessibilityLabel="Open options"
        />
      ),
      (
        <Menu
          key="menu"
          open={false}
          onOpenChange={() => undefined}
          trigger={interactiveTrigger}
          triggerAccessibilityLabel="Open menu"
          items={[{ id: 'open', label: 'Open' }]}
          onSelect={() => undefined}
        />
      ),
      (
        <Dropdown
          key="dropdown"
          open={false}
          onOpenChange={() => undefined}
          trigger={interactiveTrigger}
          triggerAccessibilityLabel="Open dropdown"
          items={[{ id: 'open', label: 'Open' }]}
          onSelect={() => undefined}
        />
      ),
      (
        <ContextMenu
          key="context-menu"
          open={false}
          onOpenChange={() => undefined}
          trigger={interactiveTrigger}
          triggerAccessibilityLabel="Open context menu"
          items={[{ id: 'open', label: 'Open' }]}
          onSelect={() => undefined}
        />
      ),
    ]) {
      await expect(mountThroughReactNativeWebAsync(render(overlay))).rejects.toThrow(
        /plain text trigger/u,
      );
    }
  });

  it('keeps state author-controlled and renders no competing portal without a host adapter', async () => {
    const onOpenChange = vi.fn();
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Popover
          open={false}
          onOpenChange={onOpenChange}
          trigger="Options"
          triggerAccessibilityLabel="Open options"
        >
          <Text value="Menu content" />
        </Popover>
      </PluginUiProvider>,
    );

    expect(mount.container.textContent).toBe('Options');
    expect(mount.container.querySelectorAll('[role="button"]')).toHaveLength(1);
    await act(async () => {
      mount.container.querySelector<HTMLElement>('[role="button"]')?.click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(mount.container.textContent).not.toContain('Menu content');
    mount.unmount();
  });

  it('requests the host-owned popover lifecycle and projects an expanded trigger', async () => {
    const onOpenChange = vi.fn();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Popover
        open
        onOpenChange={onOpenChange}
        trigger="Options"
        triggerAccessibilityLabel="Open options"
        contentAccessibilityLabel="Options dialog"
        placement="bottom"
      >
        <Text value="Menu content" />
      </Popover>,
      renderPopover,
    );

    const trigger = mount.container.querySelector<HTMLElement>('[role="button"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(mount.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Options dialog');
    expect(mount.container.textContent).toContain('Menu content');

    const input = renderPopover.mock.calls[0]?.[0];
    expect(input).toMatchObject({ open: true, placement: 'bottom' });
    expect(input?.autoFocusOnOpen).toBe(true);
    expect(input?.anchorRef.current).toBe(trigger?.parentElement);
    expect(input?.focusReturnRef?.current).toBe(trigger);
    await act(async () => {
      input?.onRequestClose();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    mount.unmount();
  });

  it('renders a direct Popover inside the projected surface chrome', () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Popover
        open
        onOpenChange={() => undefined}
        trigger="Options"
        triggerAccessibilityLabel="Open options"
      >
        <Text value="Menu content" />
      </Popover>,
      renderPopover,
    );

    const dialog = mount.container.querySelector<HTMLElement>('[role="dialog"]');
    expect(hasProjectedSurfaceChrome(dialog)).toBe(true);
    mount.unmount();
  });

  it('uses a named controlled radio group to keep menuitemradio checks exclusive', async () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    function RadioMenuHarness() {
      const [selectedId, setSelectedId] = useState<'project' | 'workspace'>('project');
      return (
        <Menu
          open
          onOpenChange={() => undefined}
          trigger="Scope"
          triggerAccessibilityLabel="Choose scope"
          radioGroups={[{ id: 'scope', accessibilityLabel: 'Scope', selectedId }]}
          items={[
            { id: 'project', label: 'Project', kind: 'radio', radioGroupId: 'scope' },
            { id: 'workspace', label: 'Workspace', kind: 'radio', radioGroupId: 'scope' },
          ]}
          onSelect={(id) => {
            if (id === 'project' || id === 'workspace') setSelectedId(id);
          }}
        />
      );
    }

    const mount = mountWithPresentationHost(<RadioMenuHarness />, renderPopover);
    const group = mount.container.querySelector<HTMLElement>('[role="group"]');
    const radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    expect(group?.getAttribute('aria-label')).toBe('Scope');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);

    await act(async () => {
      radios[1]?.click();
    });
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    mount.unmount();
  });

  it('keeps named action and checkbox groups semantic while keyboard movement spans their flattened rows', async () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Menu
        open
        onOpenChange={() => undefined}
        trigger="Actions"
        triggerAccessibilityLabel="Open actions"
        items={[]}
        groups={[
          {
            id: 'view',
            accessibilityLabel: 'View options',
            items: [
              { id: 'refresh', label: 'Refresh' },
              { id: 'pin', label: 'Pin', kind: 'checkbox', checked: true },
            ],
          },
          {
            id: 'more',
            accessibilityLabel: 'More actions',
            items: [{ id: 'archive', label: 'Archive' }],
          },
        ]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    const groups = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="group"]'));
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['View options', 'More actions']);
    expect(groups[0]?.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('true');

    const rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'));
    await act(async () => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[1]);
    await act(async () => {
      rows[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[2]);
    mount.unmount();
  });

  it('uses the host popover for a keyboard-focusable semantic menu', async () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Menu
        open
        onOpenChange={onOpenChange}
        trigger="Actions"
        triggerAccessibilityLabel="Open actions"
        items={[
          { id: 'disabled', label: 'Disabled', disabled: true },
          { id: 'pin', label: 'Pin', kind: 'checkbox', checked: true },
          { id: 'scope', label: 'Scope', kind: 'radio', radioGroupId: 'scope' },
        ]}
        radioGroups={[{ id: 'scope', accessibilityLabel: 'Scope', selectedId: null }]}
        onSelect={onSelect}
      />,
      renderPopover,
    );

    const input = renderPopover.mock.calls[0]?.[0];
    expect(input?.autoFocusOnOpen).toBe(true);
    expect(mount.container.querySelector('[role="menu"]')).not.toBeNull();
    expect(mount.container.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('true');
    expect(mount.container.querySelector('[role="menuitemradio"]')?.getAttribute('aria-checked')).toBe('false');

    const rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitemradio"]'));
    const disabled = mount.container.querySelector<HTMLElement>('[role="menuitem"]');
    const pin = rows[0];
    const scope = rows[1];
    expect(pin).toBeTruthy();
    expect(scope).toBeTruthy();
    await act(async () => {
      disabled?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => {
      pin?.focus();
      pin?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(scope);
    await act(async () => {
      scope?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      scope?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('scope');
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    mount.unmount();
  });

  it('draws projected focus chrome around the roving menu item', async () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Menu
        open
        onOpenChange={() => undefined}
        trigger="Actions"
        triggerAccessibilityLabel="Open actions"
        items={[{ id: 'inspect', label: 'Inspect' }]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    const row = mount.container.querySelector<HTMLElement>('[role="menuitem"]');
    await act(async () => {
      row?.focus();
    });

    expect(hasProjectedSurfaceChrome(row)).toBe(true);
    const style = row ? getComputedStyle(row) : null;
    expect(style?.borderTopWidth).toBe('2px');
    expect(style?.borderTopColor).toBe(resolveRenderedColor('borderTopColor', SURFACE_THEME_FIXTURE.colors.focus));
    mount.unmount();
  });

  it('routes Home, End, typeahead, and Escape through semantic menu rows', async () => {
    const onOpenChange = vi.fn();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Menu
        open
        onOpenChange={onOpenChange}
        trigger="Actions"
        triggerAccessibilityLabel="Open actions"
        items={[
          { id: 'alpha', label: 'Alpha' },
          { id: 'disabled', label: 'Archive', disabled: true },
          { id: 'beta', label: 'Beta' },
          { id: 'gamma', label: 'Gamma' },
        ]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    const rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    await act(async () => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[3]);
    await act(async () => {
      rows[3]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[0]);
    await act(async () => {
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[3]);
    await act(async () => {
      rows[3]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    mount.unmount();
  });

  it('keeps ArrowDown at the final enabled row, matching the shared dropdown contract', async () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Menu
        open
        onOpenChange={() => undefined}
        trigger="Actions"
        triggerAccessibilityLabel="Open actions"
        items={[
          { id: 'alpha', label: 'Alpha' },
          { id: 'beta', label: 'Beta' },
        ]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    const rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    await act(async () => {
      rows[1]?.focus();
      rows[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[1]);
    mount.unmount();
  });

  it('keeps a long Menu within the host viewport while its final enabled row stays reachable', async () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    const hostMaxHeight = 96;
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Menu
        open
        onOpenChange={onOpenChange}
        trigger="Actions"
        triggerAccessibilityLabel="Open actions"
        items={[
          { id: 'action-1', label: 'Action 1' },
          { id: 'action-2', label: 'Action 2' },
          { id: 'action-3', label: 'Action 3' },
          { id: 'action-4', label: 'Action 4' },
          { id: 'action-5', label: 'Action 5' },
          { id: 'disabled', label: 'Disabled action', disabled: true },
          { id: 'final', label: 'Final action' },
        ]}
        onSelect={onSelect}
      />,
      renderPopover,
      hostMaxHeight,
    );

    const rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const finalRow = rows.at(-1);
    expect(findBoundedScrollableAncestor(finalRow, hostMaxHeight)).not.toBeNull();

    await act(async () => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(finalRow);

    await act(async () => {
      finalRow?.click();
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('final');
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    mount.unmount();
  });

  it('reconciles a removed highlighted item to the remaining enabled row', async () => {
    const context = createSurfaceContext();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const renderMenu = (items: readonly { id: string; label: string }[]) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal
          host={createPresentationHost(renderPopover)}
        >
          <Menu
            open
            onOpenChange={() => undefined}
            trigger="Actions"
            triggerAccessibilityLabel="Open actions"
            items={items}
            onSelect={() => undefined}
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(renderMenu([
      { id: 'alpha', label: 'Alpha' },
      { id: 'beta', label: 'Beta' },
      { id: 'gamma', label: 'Gamma' },
    ]));

    let rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    await act(async () => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[2]);

    await mount.render(renderMenu([{ id: 'alpha', label: 'Alpha' }]));
    rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('tabindex')).toBe('0');
    mount.unmount();
  });

  it('keeps Dropdown as a below-trigger menu presentation rather than a Menu alias', () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <Dropdown
        open
        onOpenChange={() => undefined}
        trigger="Sort"
        triggerAccessibilityLabel="Sort results"
        items={[{ id: 'recent', label: 'Most recent' }]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    expect(renderPopover.mock.calls[0]?.[0]).toMatchObject({ placement: 'bottom', autoFocusOnOpen: true });
    expect(mount.container.querySelector('[role="button"]')?.getAttribute('aria-haspopup')).toBe('menu');
    mount.unmount();
  });

  it('opens a focused Dropdown trigger with Enter and publishes its expanded state', async () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const onOpenChange = vi.fn();
    function ControlledDropdownHarness() {
      const [open, setOpen] = useState(false);
      return (
        <Dropdown
          testID="dropdown-more"
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          trigger="More"
          triggerAccessibilityLabel="More actions"
          items={[{ id: 'inspect', label: 'Inspect' }]}
          onSelect={() => undefined}
        />
      );
    }

    const mount = mountWithPresentationHost(<ControlledDropdownHarness />, renderPopover);
    const trigger = mount.container.querySelector<HTMLElement>('[data-testid="dropdown-more"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      trigger?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      // See Button's exact-cycle test: jsdom needs the browser's native
      // button default action represented explicitly.
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(renderPopover).toHaveBeenCalledTimes(1);
    expect(mount.container.querySelector('[role="menu"]')).not.toBeNull();
    mount.unmount();
  });

  it('forwards the owning ScrollArea as the canonical host scroll source for a portaled menu', () => {
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <ScrollArea testID="plugin-overlay-scroll-source">
        <Menu
          open
          onOpenChange={() => undefined}
          trigger="Actions"
          triggerAccessibilityLabel="Open actions"
          items={[{ id: 'refresh', label: 'Refresh' }]}
          onSelect={() => undefined}
        />
      </ScrollArea>,
      renderPopover,
    );

    const input = renderPopover.mock.calls[0]?.[0];
    const followScrollRef = input
      ? Reflect.get(input, 'followScrollRef') as { current?: unknown } | undefined
      : undefined;
    const scrollArea = mount.container.querySelector('[data-testid="plugin-overlay-scroll-source"]');

    expect(scrollArea).not.toBeNull();
    expect(followScrollRef?.current).toBe(scrollArea);
    mount.unmount();
  });

  it('does not carry stale typeahead across a controlled menu close and reopen', async () => {
    const context = createSurfaceContext();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const renderMenu = (open: boolean) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal
          host={createPresentationHost(renderPopover)}
        >
          <Menu
            open={open}
            onOpenChange={() => undefined}
            trigger="Actions"
            triggerAccessibilityLabel="Open actions"
            items={[
              { id: 'alpha', label: 'Alpha' },
              { id: 'gamma', label: 'Gamma' },
            ]}
            onSelect={() => undefined}
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(renderMenu(true));

    let rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    await act(async () => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[1]);

    await mount.render(renderMenu(false));
    await mount.render(renderMenu(true));
    rows = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    await act(async () => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[0]);
    mount.unmount();
  });

  it('opens ContextMenu from a real web context-menu gesture without a second portal owner', async () => {
    const onOpenChange = vi.fn();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <ContextMenu
        open={false}
        onOpenChange={onOpenChange}
        trigger="Repository"
        triggerAccessibilityLabel="Repository actions"
        items={[{ id: 'inspect', label: 'Inspect' }]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    const trigger = mount.container.querySelector<HTMLElement>('[role="button"]');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      trigger?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(renderPopover).not.toHaveBeenCalled();
    mount.unmount();
  });

  it('keeps a disabled ContextMenu inert for a cancelable web context-menu gesture', async () => {
    const onOpenChange = vi.fn();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <ContextMenu
        disabled
        open={false}
        onOpenChange={onOpenChange}
        trigger="Repository"
        triggerAccessibilityLabel="Repository actions"
        items={[{ id: 'inspect', label: 'Inspect' }]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    const trigger = mount.container.querySelector<HTMLElement>('[role="button"]');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      trigger?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(renderPopover).not.toHaveBeenCalled();
    mount.unmount();
  });

  it('opens ContextMenu through the RNW touch long-press responder', async () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn();
    const renderPopover = vi.fn((input: Parameters<RenderPopover>[0]) => input.content);
    const mount = mountWithPresentationHost(
      <ContextMenu
        open={false}
        onOpenChange={onOpenChange}
        trigger="Repository"
        triggerAccessibilityLabel="Repository actions"
        items={[{ id: 'inspect', label: 'Inspect' }]}
        onSelect={() => undefined}
      />,
      renderPopover,
    );

    try {
      const trigger = mount.container.querySelector<HTMLElement>('[role="button"]');
      const touch = { identifier: 1, pageX: 8, pageY: 8, clientX: 8, clientY: 8 };
      const event = new Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: [touch] },
        changedTouches: { value: [touch] },
      });
      await act(async () => {
        trigger?.dispatchEvent(event);
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(onOpenChange).toHaveBeenCalledWith(true);
    } finally {
      mount.unmount();
      vi.useRealTimers();
    }
  });
});
