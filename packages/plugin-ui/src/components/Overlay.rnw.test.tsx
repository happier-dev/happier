import { act, useRef, useState, type ReactNode, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb, mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { happierMaterialBackgroundColor } from '../presentation/layout/material.js';
import { HAPPIER_SMALL_BUTTON_HEIGHT } from '../presentation/interaction/buttonChrome.js';
import {
  createHostApiStub,
  createSurfaceContext,
  SURFACE_THEME_FIXTURE,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Button } from './Button.js';
import { Text } from './Text.js';
import { ScrollArea } from './Layout.js';
import { ContextMenu, Dropdown, HostedAnchoredMenu, Menu, Popover, type MenuItem } from './Overlay.js';

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

/** The scroller that keeps a long menu inside the host's height cap (its own cap within the host's). */
function findBoundedScrollableAncestor(target: HTMLElement | undefined, maxHeight: number): HTMLElement | null {
  for (let current = target?.parentElement ?? null; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    const bound = Number.parseFloat(style.maxHeight);
    if (Number.isFinite(bound) && bound <= maxHeight && style.overflowY !== 'visible') return current;
  }
  return null;
}

/** The floating Surface draws the menu's whole edge: it holds the scroller rather than scrolling inside it. */
function findRimmedAncestor(target: HTMLElement | null): HTMLElement | null {
  for (let current = target?.parentElement ?? null; current; current = current.parentElement) {
    if (getComputedStyle(current).borderTopWidth === '1px') return current;
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
  const expectedBackground = resolveRenderedColor('backgroundColor', happierMaterialBackgroundColor(SURFACE_THEME_FIXTURE.colors.surface, 'floating', true));
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
  it('opens a composer status badge through the same overlay owner with one trigger and focus return', async () => {
    let returnTarget: unknown;
    function Status() {
      const [open, setOpen] = useState(false);
      return <Popover open={open} onOpenChange={setOpen} trigger="PR #42 · Stale"
        triggerAppearance="composerStatus" triggerComposerStatus={{ tone: 'paused', emphasis: 'prominent' }}
        triggerAccessibilityLabel="acme/widgets PR #42 · Stale" testID="pr-status"
        sheet={{ title: 'Pull request' }}><Text value="Retained pull request facts" /></Popover>;
    }
    const mount = mountWithPresentationHost(<Status />, input => {
      returnTarget = input.focusReturnRef?.current;
      return <><>{input.content}</><button onClick={input.onRequestClose}>Close status</button></>;
    });
    try {
      const trigger = mount.container.querySelector<HTMLElement>('[data-testid="pr-status"]')!;
      expect(trigger.querySelector('[data-testid="pr-status:badge:label"]')?.textContent).toBe('PR #42 · Stale');
      expect(mount.container.querySelectorAll('[role="button"]')).toHaveLength(1);
      expect(trigger.getAttribute('aria-label')).toBe('acme/widgets PR #42 · Stale');
      expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      await act(async () => { trigger.click(); });
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(mount.container.querySelector('[role="dialog"]')?.textContent).toContain('Retained pull request facts');
      expect(returnTarget).toBe(trigger);
      await act(async () => { mount.container.querySelector<HTMLButtonElement>('button')!.click(); });
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(mount.container.querySelector('[role="dialog"]')).toBeNull();
    } finally { mount.unmount(); }
  });
  it('keeps a composer status trigger disabled and lets the host compose its phone sheet', async () => {
    const onOpenChange = vi.fn();
    const context = createSurfaceContext();
    const sheet = { title: 'Pull request' };
    const host: PluginUiPresentationHost = {
      ...createPresentationHost(() => null),
      renderPopover: input => {
        expect(input.sheet).toBe(sheet);
        return input.content({ requestClose: input.onRequestClose, maxHeight: 240, presentation: 'sheet' });
      },
    };
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <Popover open={false} onOpenChange={onOpenChange} trigger="PR #42"
            triggerAppearance="composerStatus" triggerAccessibilityLabel="Pull request" disabled
            triggerTabIndex={-1} testID="disabled-status" />
          <Popover open onOpenChange={onOpenChange} trigger="PR #43"
            triggerAppearance="composerStatus" triggerAccessibilityLabel="Pull request" sheet={sheet}>
            <Text value="Phone pull request facts" />
          </Popover>
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    try {
      const trigger = mount.container.querySelector<HTMLElement>('[data-testid="disabled-status"]')!;
      expect(trigger.getAttribute('role')).toBe('button');
      expect(trigger.getAttribute('aria-disabled')).toBe('true');
      expect(trigger.getAttribute('tabindex')).toBe('-1');
      await act(async () => { trigger.click(); });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(mount.container.textContent).toContain('Phone pull request facts');
      expect(mount.container.querySelector('[role="dialog"]')).toBeNull();
    } finally { mount.unmount(); }
  });
  it('keeps hosted anchored choices in the canonical menu focus, chrome and dismissal owner', async () => {
    const methods = ['showModal', 'close'] as const;
    const previous = methods.map(key => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key));
    // jsdom does not provide native dialog top-layer methods; menu logic and DOM focus stay real.
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
    });
    const selected: string[] = [];
    function Choices() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return <><button ref={anchor} onClick={() => setOpen(true)}>Move</button>{open ? <HostedAnchoredMenu anchorRef={anchor} onOpenChange={setOpen} accessibilityLabel="Move to"
        items={[{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]}
        groups={[{ id: 'unavailable', accessibilityLabel: 'Unavailable', items: [{ id: 'locked', label: 'Locked', subtitle: 'Read only', disabled: true }] }]}
        onSelect={id => { selected.push(id); }} /> : null}</>;
    }
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}><Choices /></PluginUiProvider>);
    const key = async (value: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); });
    try {
      const anchor = mount.container.querySelector<HTMLButtonElement>('button')!;
      await act(async () => anchor.click());
      const rows = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      expect(document.activeElement).toBe(rows()[0]);
      expect(hasProjectedSurfaceChrome(mount.container.querySelector('[role="menu"]'))).toBe(true);
      expect(mount.container.querySelector('[role="group"][aria-label="Unavailable"]')?.textContent).toContain('Read only');
      expect(mount.container.querySelector('[role="group"][aria-label="Unavailable"]')?.textContent).toContain('Unavailable');
      expect(rows()[2]?.getAttribute('aria-disabled')).toBe('true');
      await key('ArrowDown'); expect(document.activeElement).toBe(rows()[1]);
      await key('ArrowDown'); expect(document.activeElement).toBe(rows()[1]);
      await key('ArrowUp'); expect(document.activeElement).toBe(rows()[0]);
      await key('Escape'); expect(mount.container.querySelector('dialog')).toBeNull(); expect(document.activeElement).toBe(anchor);
      expect(selected).toEqual([]);
      await act(async () => anchor.click()); await key('ArrowDown'); await key('Enter');
      expect(selected).toEqual(['second']); expect(mount.container.querySelector('dialog')).toBeNull(); expect(document.activeElement).toBe(anchor);
      await act(async () => anchor.click());
      await act(async () => mount.container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
      expect(mount.container.querySelector('dialog')).toBeNull(); expect(document.activeElement).toBe(anchor);
    } finally {
      mount.unmount();
      methods.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, key); });
    }
  });
  it('keeps an icon menu trigger visibly focused for keyboard users', async () => {
    const context = createSurfaceContext({ contrast: 'high' });
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Menu open={false} onOpenChange={() => undefined} trigger="Add"
          triggerIcon="add" triggerAccessibilityLabel="Add source"
          items={[{ id: 'source', label: 'Source' }]} onSelect={() => undefined} />
      </PluginUiProvider>,
    );
    const button = mount.container.querySelector<HTMLElement>('[role="button"]')!;
    await act(async () => { button.focus(); });
    // The environment projects high-contrast focus through the existing text token.
    const ring = resolveRenderedColor('borderTopColor', context.theme.colors.text);
    // The shared ring: an outline held off the drawn circle, never the circle's border recoloured.
    expect([button, ...button.querySelectorAll<HTMLElement>('*')].some((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle === 'solid' && style.outlineColor === ring && style.outlineOffset === '2px';
    })).toBe(true);
    mount.unmount();
  });

  it('draws a well icon trigger as a round resting fill, and a plain one without a fill', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Menu open={false} onOpenChange={() => undefined} trigger="More" triggerIcon="more"
          triggerAccessibilityLabel="More" testID="plain" items={[{ id: 'a', label: 'A' }]} onSelect={() => undefined} />
        <Menu open={false} onOpenChange={() => undefined} trigger="More" triggerIcon="more" triggerAppearance="well"
          triggerAccessibilityLabel="More" testID="well" items={[{ id: 'a', label: 'A' }]} onSelect={() => undefined} />
      </PluginUiProvider>,
    );
    const drawn = (testId: string) => {
      const trigger = mount.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
      return Array.from(trigger.querySelectorAll<HTMLElement>('*')).find((node) => getComputedStyle(node).borderTopLeftRadius !== '0px')!;
    };
    const plain = getComputedStyle(drawn('plain'));
    const well = getComputedStyle(drawn('well'));
    expect(plain.backgroundColor).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
    expect(well.backgroundColor).toBe(resolveRenderedColor('backgroundColor', context.theme.colors.control));
    // A well is a circle with no outline: the fill is its own edge.
    expect(parseFloat(well.borderTopLeftRadius)).toBe(parseFloat(well.width) / 2);
    expect(well.borderTopWidth).toBe('0px');
    mount.unmount();
  });

  it('draws a labelled primary trigger with its glyph leading the words, and a bare glyph only without a label', () => {
    const context = createSurfaceContext();
    const host: PluginUiPresentationHost = {
      ...createPresentationHost(() => null),
      renderIcon: (input) => <span data-icon={input.name} style={{ color: input.color }} />,
    };
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <Popover open={false} onOpenChange={() => undefined} trigger="Link a PR or issue"
            triggerAppearance="primary" triggerIcon="add" triggerAccessibilityLabel="Link a PR or issue" testID="link">
            <Text value="Search" />
          </Popover>
          <Popover open={false} onOpenChange={() => undefined} trigger="Add"
            triggerIcon="add" triggerAccessibilityLabel="Add source" testID="add" />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    const primary = mount.container.querySelector<HTMLElement>('[data-testid="link"]')!;
    // One control, one name: the glyph is decoration, the words are the name.
    expect(primary.getAttribute('aria-label')).toBe('Link a PR or issue');
    expect(primary.querySelectorAll('[role="button"], [aria-label]:not([data-testid="link"])')).toHaveLength(0);
    const glyph = primary.querySelector<HTMLElement>('[data-icon="add"]');
    expect(glyph).not.toBeNull();
    expect(primary.textContent).toBe('Link a PR or issue');
    const label = Array.from(primary.querySelectorAll<HTMLElement>('*')).find((node) => node.textContent === 'Link a PR or issue' && node.children.length === 0)!;
    expect(glyph!.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The filled primary: the accent fill, the glyph in the same ink as the words.
    expect(getComputedStyle(primary).backgroundColor).toBe(resolveRenderedColor('backgroundColor', context.theme.colors.accent));
    expect(glyph!.style.color).toBe(getComputedStyle(label).color);
    // Without a labelled appearance the glyph alone is the trigger.
    const iconOnly = mount.container.querySelector<HTMLElement>('[data-testid="add"]')!;
    expect(iconOnly.querySelector('[data-icon="add"]')).not.toBeNull();
    expect(iconOnly.textContent).toBe('');
    mount.unmount();
  });

  it('draws a task status trigger as the status glyph: alone as an icon button, or leading a labelled control', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Menu open={false} onOpenChange={() => undefined} trigger="In Review" triggerTaskStatus="started"
          triggerAccessibilityLabel="Change status, In Review" testID="row" items={[{ id: 'done', label: 'Done' }]} onSelect={() => undefined} />
        <Menu open={false} onOpenChange={() => undefined} trigger="In Review" triggerTaskStatus="started" triggerAppearance="control"
          triggerAccessibilityLabel="Change status, In Review" testID="detail" items={[{ id: 'done', label: 'Done' }]} onSelect={() => undefined} />
      </PluginUiProvider>,
    );
    const row = mount.container.querySelector<HTMLElement>('[data-testid="row"]')!;
    // The row's control is the glyph alone; its name says the operation and the current status.
    expect(row.getAttribute('aria-label')).toBe('Change status, In Review');
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.textContent).toBe('');
    const detail = mount.container.querySelector<HTMLElement>('[data-testid="detail"]')!;
    const glyph = detail.querySelector('svg')!;
    expect(glyph).not.toBeNull();
    expect(detail.textContent).toBe('In Review');
    const label = Array.from(detail.querySelectorAll<HTMLElement>('*')).find((node) => node.textContent === 'In Review' && node.children.length === 0)!;
    expect(glyph.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    mount.unmount();
  });

  it('draws a control trigger as the small secondary button on the desktop control row', () => {
    const context = createSurfaceContext();
    const host: PluginUiPresentationHost = {
      ...createPresentationHost(() => null),
      renderIcon: (input) => <span data-icon={input.name} style={{ color: input.color }} />,
    };
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
          <Dropdown open={false} onOpenChange={() => undefined} trigger="Order · Newest"
            triggerAppearance="control" triggerIcon="settings" triggerAccessibilityLabel="Order" testID="order"
            items={[{ id: 'newest', label: 'Newest' }]} onSelect={() => undefined} />
          <Button title="Peer" variant="secondary" size="small" onPress={() => undefined} testID="peer" />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    const trigger = mount.container.querySelector<HTMLElement>('[data-testid="order"]')!;
    const peer = mount.container.querySelector<HTMLElement>('[data-testid="peer"]')!;
    expect(getComputedStyle(trigger).minHeight).toBe(`${HAPPIER_SMALL_BUTTON_HEIGHT}px`);
    expect(getComputedStyle(trigger).backgroundColor).toBe(getComputedStyle(peer).backgroundColor);
    // The glyph leads the words; the control keeps one name.
    expect(trigger.querySelector('[data-icon="settings"]')).not.toBeNull();
    expect(trigger.textContent).toBe('Order · Newest');
    expect(trigger.getAttribute('aria-label')).toBe('Order');
    mount.unmount();
  });

  it('draws a plain-text trigger with a disclosure caret and no control chrome when asked', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Dropdown open={false} onOpenChange={() => undefined} trigger="Entry · Newest" triggerDisclosure
          triggerAccessibilityLabel="Order" testID="plain" items={[{ id: 'newest', label: 'Newest' }]} onSelect={() => undefined} />
        <Dropdown open={false} onOpenChange={() => undefined} trigger="Entry"
          triggerAccessibilityLabel="Order" testID="bare" items={[{ id: 'newest', label: 'Newest' }]} onSelect={() => undefined} />
      </PluginUiProvider>,
    );
    const plain = mount.container.querySelector<HTMLElement>('[data-testid="plain"]')!;
    const bare = mount.container.querySelector<HTMLElement>('[data-testid="bare"]')!;
    // The words stay the trigger's name; the caret is decoration beside them, not a second control.
    expect(plain.textContent).toBe('Entry · Newest');
    expect(plain.getAttribute('aria-label')).toBe('Order');
    expect(plain.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(bare.querySelectorAll('[aria-hidden="true"]').length);
    // No button face: the trigger sits in a header row at the row's own height.
    expect(getComputedStyle(plain).backgroundColor).toBe(getComputedStyle(bare).backgroundColor);
    expect(getComputedStyle(plain).minHeight).not.toBe(`${HAPPIER_SMALL_BUTTON_HEIGHT}px`);
    mount.unmount();
  });

  it('keeps menu identity and explanatory subtitle available to assistive technology', () => {
    const items = [{ id: 'bot', label: 'Review bot', subtitle: 'GitHub', icon: 'add' }] satisfies readonly MenuItem[];
    const mount = mountWithPresentationHost(
      <Menu open onOpenChange={() => undefined} trigger="Bots"
        triggerAccessibilityLabel="Choose bot" items={items} onSelect={() => undefined} />,
      (input) => input.content,
    );
    const row = mount.container.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(row.textContent).toContain('GitHub');
    expect(row.getAttribute('aria-label')).toContain('GitHub');
    mount.unmount();
  });

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

  it('asks the host material for a panel coat only when a Popover declares itself a panel, and never for a Menu', () => {
    const floatingRoles: Array<string | undefined> = [];
    const host: PluginUiPresentationHost = {
      ...createPresentationHost((input) => input.content),
      renderMaterialSurface: (input) => {
        if (input.role === 'floating') floatingRoles.push(input.floatingRole);
        return input.children;
      },
    };
    const context = createSurfaceContext();
    const mountOverlay = (overlay: ReactNode) => {
      const mount = mountThroughReactNativeWeb(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <PluginUiPresentationHostProviderInternal host={host}>{overlay}</PluginUiPresentationHostProviderInternal>
        </PluginUiProvider>,
      );
      mount.unmount();
    };
    mountOverlay(<Popover open onOpenChange={() => undefined} trigger="Options" triggerAccessibilityLabel="Open options" floatingRole="panel"><Text value="Panel" /></Popover>);
    mountOverlay(<Popover open onOpenChange={() => undefined} trigger="Options" triggerAccessibilityLabel="Open options"><Text value="Small popover" /></Popover>);
    mountOverlay(<Menu open onOpenChange={() => undefined} trigger="Options" triggerAccessibilityLabel="Open options" items={[{ id: 'one', label: 'One' }]} onSelect={() => undefined} />);
    expect(floatingRoles).toEqual(['panel', undefined, undefined]);
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
    // Inset: menu rows span the floating surface, which clips anything outside them.
    expect(style?.outlineStyle).toBe('solid');
    expect(style?.outlineWidth).toBe('2px');
    expect(style?.outlineOffset).toBe('-2px');
    expect(style?.outlineColor).toBe(resolveRenderedColor('borderTopColor', SURFACE_THEME_FIXTURE.colors.focus));
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
    const scroller = findBoundedScrollableAncestor(finalRow, hostMaxHeight);
    expect(scroller).not.toBeNull();
    // A long menu scrolls inside its rimmed Surface, so its first view ends on the Surface's own bottom
    // edge instead of a flat cut through the content (UI1, 2026-10-16).
    expect(findRimmedAncestor(scroller)).not.toBeNull();

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
