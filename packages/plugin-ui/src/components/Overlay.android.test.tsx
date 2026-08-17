import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({
  OS: 'android',
  select: <T,>(options: Readonly<{ android?: T; native?: T; default?: T }>) => (
    options.android ?? options.native ?? options.default
  ),
}));

// React Native is the platform boundary; the shared overlay and pressable
// implementations below stay real so this exercises their native prop path.
vi.mock('react-native', () => ({
  Platform: nativePlatform,
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
}));

import { PluginUiPresentationHostProviderInternal, type PluginUiPresentationHost } from '../presentationHost/context.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { ContextMenu, Dropdown, Menu } from './Overlay.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function resolvePressableStyle(style: unknown): Record<string, unknown> {
  return flattenStyle(typeof style === 'function'
    ? style({
        pressed: false,
        hovered: false,
        focused: false,
        selected: false,
        busy: false,
        disabled: false,
      })
    : style);
}

let renderer: ReactTestRenderer | null = null;

function createPresentationHost(maxHeight = 240): PluginUiPresentationHost {
  return {
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: (input) => input.content({ requestClose: () => input.onRequestClose(), maxHeight }),
    renderIcon: () => null,
  };
}

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('shared overlay menu Android touch targets', () => {
  it('keeps Menu, Dropdown, and ContextMenu rows and plain-text triggers at physical 48dp targets without overlapping hit slop', async () => {
    const context = createSurfaceContext({ platform: 'android' });
    const presentationHost = createPresentationHost();

    await act(async () => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <PluginUiPresentationHostProviderInternal host={presentationHost}>
            <Menu
              open
              onOpenChange={() => undefined}
              trigger="Menu"
              triggerAccessibilityLabel="Open menu"
              items={[{ id: 'menu-action', label: 'Menu action' }]}
              onSelect={() => undefined}
            />
            <Dropdown
              open
              onOpenChange={() => undefined}
              trigger="Dropdown"
              triggerAccessibilityLabel="Open dropdown"
              items={[{ id: 'dropdown-action', label: 'Dropdown action' }]}
              onSelect={() => undefined}
            />
            <ContextMenu
              open
              onOpenChange={() => undefined}
              trigger="Context menu"
              triggerAccessibilityLabel="Open context menu"
              items={[{ id: 'context-action', label: 'Context action' }]}
              onSelect={() => undefined}
            />
          </PluginUiPresentationHostProviderInternal>
        </PluginUiProvider>,
      );
    });

    const rows = renderer!.root.findAll((node) => (
      node.type === 'Pressable' && node.props.accessibilityRole === 'menuitem'
    ));
    expect(rows).toHaveLength(3);

    for (const row of rows) {
      const frame = resolvePressableStyle(row.props.style);
      expect(frame.minHeight).toBeGreaterThanOrEqual(48);
      // A minimum lets enlarged text grow. A fixed height could clip it.
      expect(frame.height).toBeUndefined();
      // Adjacent menu rows need physical targets, not overlapping hit rectangles.
      expect(row.props.hitSlop).toBeUndefined();
    }

    const triggers = renderer!.root.findAll((node) => (
      node.type === 'Pressable' && node.props.accessibilityRole === 'button'
    ));
    expect(triggers).toHaveLength(3);

    for (const trigger of triggers) {
      expect(trigger.props.role).toBe('button');
      const frame = resolvePressableStyle(trigger.props.style);
      expect(frame.minHeight).toBeGreaterThanOrEqual(48);
      expect(frame.minWidth).toBeGreaterThanOrEqual(48);
      // A minimum lets enlarged text grow. Fixed dimensions could clip it.
      expect(frame.height).toBeUndefined();
      expect(frame.width).toBeUndefined();
      // The physical frame, not overlapping hit rectangles, owns the target.
      expect(trigger.props.hitSlop).toBeUndefined();
    }
  });

  it('keeps a long Menu in a bounded native scroll viewport without losing its final touch row', async () => {
    const context = createSurfaceContext({ platform: 'android' });
    const hostMaxHeight = 96;
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();

    await act(async () => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <PluginUiPresentationHostProviderInternal host={createPresentationHost(hostMaxHeight)}>
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
            />
          </PluginUiPresentationHostProviderInternal>
        </PluginUiProvider>,
      );
    });

    const scrollViewport = renderer!.root.findAll((node) => (
      node.type === 'ScrollView' && flattenStyle(node.props.style).maxHeight === hostMaxHeight
    ));
    expect(scrollViewport).toHaveLength(1);
    expect(scrollViewport[0]?.props.keyboardShouldPersistTaps).toBe('handled');

    const rows = renderer!.root.findAll((node) => (
      node.type === 'Pressable' && node.props.accessibilityRole === 'menuitem'
    ));
    const finalRow = rows.at(-1);
    expect(finalRow?.props.accessibilityLabel).toBe('Final action');
    await act(async () => {
      finalRow?.props.onPress();
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('final');
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('reopens a controlled second radio row as the roving target without publishing that transient highlight as semantic selection', async () => {
    const context = createSurfaceContext({ platform: 'android' });
    const presentationHost = createPresentationHost();
    const renderRadioMenu = (open: boolean) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost}>
          <Menu
            open={open}
            onOpenChange={() => undefined}
            trigger="Scope"
            triggerAccessibilityLabel="Choose scope"
            radioGroups={[{ id: 'scope', accessibilityLabel: 'Scope', selectedId: 'workspace' }]}
            items={[
              { id: 'project', label: 'Project', kind: 'radio', radioGroupId: 'scope' },
              { id: 'workspace', label: 'Workspace', kind: 'radio', radioGroupId: 'scope' },
            ]}
            onSelect={() => undefined}
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>
    );
    const radioRows = () => renderer!.root.findAll((node) => (
      node.type === 'Pressable' && node.props.role === 'menuitemradio'
    ));

    await act(async () => {
      renderer = create(renderRadioMenu(false));
      renderer!.update(renderRadioMenu(true));
    });

    expect(radioRows().map((row) => row.props.accessibilityState.checked)).toEqual([false, true]);
    expect(radioRows().map((row) => row.props.accessibilityState.selected)).toEqual([undefined, undefined]);
    expect(radioRows().map((row) => row.props.tabIndex)).toEqual([-1, 0]);

    await act(async () => {
      renderer!.update(renderRadioMenu(false));
      renderer!.update(renderRadioMenu(true));
    });

    expect(radioRows().map((row) => row.props.accessibilityState.checked)).toEqual([false, true]);
    expect(radioRows().map((row) => row.props.accessibilityState.selected)).toEqual([undefined, undefined]);
    expect(radioRows().map((row) => row.props.tabIndex)).toEqual([-1, 0]);
  });
});
