import { act, useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Item, ItemGroup, List } from './List.js';
import { useListMultiSelectionController } from './ListMultiSelection.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Text } from './Text.js';

function mountList(children: ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(listTree(context, children));
}

function listTree(context: ReturnType<typeof createSurfaceContext>, children: ReactNode) {
  return (
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <List accessibilityLabel="Repositories">{children}</List>
    </PluginUiProvider>
  );
}

describe('plugin-ui List item presentation', () => {
  it('restores physical focus through the virtualized List owner on request', async () => {
    const repositories = [
      { id: 'happier', title: 'happier' },
      { id: 'protocol', title: 'protocol' },
    ] as const;
    const context = createSurfaceContext();
    const onFocusedKeyChange = vi.fn();
    const tree = (focusRequest?: Readonly<{ key: string }>) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List
          accessibilityLabel="Repositories"
          items={repositories}
          keyForItem={(item) => item.id}
          renderItem={(item) => <List.Item title={item.title} onPress={() => undefined} />}
          selection={{
            selectedKey: 'happier',
            onSelectedKeyChange: () => undefined,
            onFocusedKeyChange,
            focusRequest,
          }}
        />
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(tree());
    const options = () => Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'));
    await act(async () => { options()[0]?.focus(); });

    await mount.render(tree({ key: 'protocol' }));

    expect(document.activeElement).toBe(options()[1]);
    expect(options().map((option) => option.getAttribute('tabindex'))).toEqual(['-1', '0']);
    expect(onFocusedKeyChange).toHaveBeenLastCalledWith('protocol');
    mount.unmount();
  });

  it('resolves collection and group accessible names through the plugin catalog', () => {
    const context = createSurfaceContext({
      translations: {
        'acme.repositories': 'Dépôts',
        'acme.actions': 'Actions du dépôt',
      },
    });
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List accessibilityLabel="Repositories" accessibilityLabelKey="acme.repositories">
          <ItemGroup accessibilityLabel="Repository actions" accessibilityLabelKey="acme.actions">
            <List.Item title="happier" />
          </ItemGroup>
        </List>
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('[role="list"]')?.getAttribute('aria-label')).toBe('Dépôts');
    expect(mount.container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Actions du dépôt');
    mount.unmount();
  });

  it('renders a semantic actionable row through the shared pressable owner', async () => {
    const onPress = vi.fn();
    const mount = mountList(
      <List.Item
        title="happier"
        subtitle="Main repository"
        detail="42"
        accessibilityLabel="Open happier repository"
        onPress={onPress}
      />,
    );

    const row = mount.container.querySelector<HTMLElement>('[role="listitem"]');
    const control = row?.querySelector<HTMLElement>('[role="button"]');
    expect(control, 'the semantic list row must contain a real pressable').not.toBeNull();
    expect(control?.getAttribute('aria-label')).toBe('Open happier repository');
    expect(row?.textContent).toContain('happier');
    expect(row?.textContent).toContain('Main repository');
    expect(row?.textContent).toContain('42');

    await act(async () => { control?.click(); });
    expect(onPress).toHaveBeenCalledOnce();

    mount.unmount();
  });

  it('keeps a disabled row inert while exposing its disabled state', async () => {
    const onPress = vi.fn();
    const mount = mountList(
      <List.Item
        title="archived"
        disabled
        accessibilityLabel="Archived repository"
        onPress={onPress}
      />,
    );

    const control = mount.container.querySelector<HTMLElement>('[role="button"]');
    expect(control).not.toBeNull();
    expect(control?.getAttribute('aria-disabled')).toBe('true');

    await act(async () => { control?.click(); });
    expect(onPress).not.toHaveBeenCalled();

    mount.unmount();
  });

  it('retains the same focused action owner across a busy update', async () => {
    const context = createSurfaceContext();
    const row = (busy: boolean) => listTree(context, (
      <List.Item
        title="active"
        busy={busy}
        accessibilityLabel="Active repository"
        onPress={() => undefined}
      />
    ));
    const mount = mountThroughReactNativeWeb(row(false));
    const control = mount.container.querySelector<HTMLElement>('[role="button"]');
    expect(control).not.toBeNull();
    await act(async () => { control?.focus(); });

    await mount.render(row(true));

    const busyControl = mount.container.querySelector<HTMLElement>('[role="button"]');
    expect(busyControl).toBe(control);
    expect(busyControl?.getAttribute('aria-busy')).toBe('true');
    expect(busyControl?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(busyControl);
    mount.unmount();
  });

  it('renders custom children as the row body beneath its semantic label', async () => {
    const onPress = vi.fn();
    const mount = mountList(
      <List.Item title="happier" subtitle="Main repository" onPress={onPress}>
        <Text value="3 open pull requests" />
      </List.Item>,
    );

    const row = mount.container.querySelector<HTMLElement>('[role="listitem"]');
    const text = row?.textContent ?? '';
    expect(text).toContain('happier');
    expect(text).toContain('Main repository');
    expect(text, 'a row given both a title and children must render both').toContain('3 open pull requests');
    expect(text.indexOf('3 open pull requests')).toBeGreaterThan(text.indexOf('Main repository'));

    const control = row?.querySelector<HTMLElement>('[role="button"]');
    await act(async () => { control?.click(); });
    expect(onPress).toHaveBeenCalledOnce();

    mount.unmount();
  });

  it('sends a primitive row body through the canonical text owner beside a title', () => {
    const mount = mountList(<List.Item title="happier">plain body text</List.Item>);

    const row = mount.container.querySelector<HTMLElement>('[role="listitem"]');
    const wrapped = Array.from(row?.querySelectorAll<HTMLElement>('*') ?? []).some(
      (element) => element.children.length === 0 && element.textContent === 'plain body text',
    );
    expect(wrapped, 'a primitive body must not reach the row as a bare text node').toBe(true);

    mount.unmount();
  });

  it('preserves option selection instead of coercing a selectable row into a button', () => {
    const mount = mountList(
      <List.Item
        title="Staged"
        accessibilityRole="option"
        selected
        accessibilityLabel="Staged files"
        onPress={() => {}}
      />,
    );

    const option = mount.container.querySelector<HTMLElement>('[role="option"]');
    expect(option).not.toBeNull();
    expect(option?.getAttribute('aria-selected')).toBe('true');
    expect(mount.container.querySelector('[role="button"]')).toBeNull();

    mount.unmount();
  });

  it('renders standalone Item/ItemGroup and one shared trailing overflow trigger', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <ItemGroup accessibilityLabel="Repository actions">
          <Item
            title="happier"
            secondaryActions={[{ id: 'inspect', label: 'Inspect' }]}
            secondaryActionAccessibilityLabel="More repository actions"
            onSecondaryAction={() => undefined}
          />
        </ItemGroup>
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Repository actions');
    expect(mount.container.querySelector('[aria-label="More repository actions"]')).not.toBeNull();
    mount.unmount();
  });

  it('resolves the default overflow accessible name through the host translation owner', () => {
    const context = createSurfaceContext({
      translations: { 'happier.plugin-ui.list.moreActions': 'Weitere Repository-Aktionen' },
    });
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <List accessibilityLabel="Repositories">
          <List.Item
            title="happier"
            secondaryActions={[{ id: 'inspect', label: 'Inspect' }]}
            onSecondaryAction={() => undefined}
          />
        </List>
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('[aria-label="Weitere Repository-Aktionen"]')).not.toBeNull();
    mount.unmount();
  });

  it('keeps an author accessory alongside the shared secondary-actions trigger', () => {
    const mount = mountList(
      <List.Item
        title="happier"
        accessory={<Text value="Syncing" />}
        secondaryActions={[{ id: 'inspect', label: 'Inspect' }]}
        secondaryActionAccessibilityLabel="More repository actions"
        onSecondaryAction={() => undefined}
      />,
    );

    expect(mount.container.textContent).toContain('Syncing');
    expect(mount.container.querySelector('[aria-label="More repository actions"]')).not.toBeNull();
    mount.unmount();
  });

  it('keeps disabled and busy row secondary actions inert while enabled row actions operate', async () => {
    const onSecondaryAction = vi.fn();
    const context = createSurfaceContext();
    const presentationHost = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: (input) => input.content({
        requestClose: input.onRequestClose,
        maxHeight: 240,
      }),
      renderIcon: () => null,
    } satisfies PluginUiPresentationHost;
    const tree = (state: Readonly<{ disabled?: boolean; busy?: boolean }> = {}) => (
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost}>
          <List accessibilityLabel="Repositories">
            <List.Item
              title="happier"
              secondaryActions={[{ id: 'inspect', label: 'Inspect' }]}
              secondaryActionAccessibilityLabel="More repository actions"
              onSecondaryAction={onSecondaryAction}
              {...state}
            />
          </List>
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(tree());
    const trigger = () => mount.container.querySelector<HTMLElement>('[aria-label="More repository actions"]');

    await act(async () => { trigger()?.click(); });
    const enabledAction = mount.container.querySelector<HTMLElement>('[role="menuitem"]');
    expect(enabledAction).not.toBeNull();
    await act(async () => { enabledAction?.click(); });
    expect(onSecondaryAction).toHaveBeenCalledWith('inspect');

    for (const [stateName, state] of [
      ['disabled', { disabled: true }],
      ['busy', { busy: true }],
    ] as const) {
      await mount.render(tree());
      await act(async () => { trigger()?.click(); });
      expect(mount.container.querySelector('[role="menu"]')).not.toBeNull();

      await mount.render(tree(state));

      const inertTrigger = trigger();
      expect(inertTrigger?.getAttribute('aria-disabled'), `${stateName} row overflow`).toBe('true');
      expect(inertTrigger?.getAttribute('aria-expanded'), `${stateName} row overflow`).toBe('false');
      expect(mount.container.querySelector('[role="menu"]')).toBeNull();
      await act(async () => { inertTrigger?.click(); });
      expect(onSecondaryAction).toHaveBeenCalledOnce();
    }

    mount.unmount();
  });

  it('opens the focused row secondary actions from Shift+F10 and Context Menu and restores row focus', async () => {
    const context = createSurfaceContext();
    const selected: string[] = [];
    const secondary: string[] = [];
    const presentationHost = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: (input) => input.content({
        requestClose: () => {
          input.onRequestClose();
          const target = input.focusReturnRef?.current as Readonly<{ focus?: () => void }> | null;
          target?.focus?.();
        },
        maxHeight: 240,
      }),
      renderIcon: () => null,
    } satisfies PluginUiPresentationHost;
    const rows = [
      { id: 'first', title: 'First entry' },
      { id: 'second', title: 'Second entry' },
    ] as const;
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={presentationHost}>
          <List
            accessibilityLabel="Entries"
            items={rows}
            keyForItem={(item) => item.id}
            renderItem={(item) => (
              <List.Item
                title={item.title}
                secondaryActions={[{ id: 'pin', label: `Pin ${item.title}` }]}
                onSecondaryAction={(actionId) => { secondary.push(`${item.id}:${actionId}`); }}
              />
            )}
            selection={{
              selectedKey: 'first',
              onSelectedKeyChange: (key) => { selected.push(key); },
            }}
          />
        </PluginUiPresentationHostProviderInternal>
      </PluginUiProvider>,
    );
    const options = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="option"]'));
    const focusedRow = options[1];
    expect(focusedRow).toBeDefined();
    await act(async () => { focusedRow?.focus(); });

    for (const event of [
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }),
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    ]) {
      await act(async () => { focusedRow?.dispatchEvent(event); });
      const action = mount.container.querySelector<HTMLElement>('[role="menuitem"][aria-label="Pin Second entry"]');
      expect(action).not.toBeNull();
      await act(async () => { action?.click(); });
      expect(document.activeElement).toBe(focusedRow);
    }

    expect(secondary).toEqual(['second:pin', 'second:pin', 'second:pin']);
    expect(selected).toEqual([]);
    expect(Array.from(mount.container.querySelectorAll<HTMLElement>('[aria-label="More actions"]'))
      .map((trigger) => trigger.getAttribute('tabindex'))).toEqual(['-1', '-1']);
    mount.unmount();
  });

  it('projects an expandable row state through the shared pressable owner', () => {
    const mount = mountList(
      <List.Item
        title="Changed files"
        accessibilityLabel="Changed files"
        accessibilityExpanded
        onPress={() => {}}
      />,
    );

    const control = mount.container.querySelector<HTMLElement>('[role="button"]');
    expect(control?.getAttribute('aria-expanded')).toBe('true');

    mount.unmount();
  });

  it('gives an ItemGroup radiogroup one roving tab stop and transfers it with arrow selection', async () => {
    function RadioGroupHarness() {
      const [selected, setSelected] = useState<'files' | 'changes'>('files');
      return (
        <ItemGroup accessibilityRole="radiogroup" accessibilityLabel="Review scope">
          <List.Item
            title="Files"
            accessibilityRole="radio"
            accessibilityLabel="Files"
            selected={selected === 'files'}
            onPress={() => setSelected('files')}
          />
          <List.Item
            title="Changes"
            accessibilityRole="radio"
            accessibilityLabel="Changes"
            selected={selected === 'changes'}
            onPress={() => setSelected('changes')}
          />
        </ItemGroup>
      );
    }

    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <RadioGroupHarness />
      </PluginUiProvider>,
    );
    const radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1']);

    await act(async () => {
      radios[0]?.focus();
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    expect(document.activeElement).toBe(radios[1]);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['-1', '0']);
    mount.unmount();
  });

  it('activates the current public ItemGroup radio exactly once for one complete Space keydown and keyup', async () => {
    const onFilesPress = vi.fn();
    function RadioGroupHarness() {
      const [selected, setSelected] = useState<'files' | 'changes'>('files');
      return (
        <ItemGroup accessibilityRole="radiogroup" accessibilityLabel="Review scope">
          <List.Item
            title="Files"
            accessibilityRole="radio"
            accessibilityLabel="Files"
            selected={selected === 'files'}
            onPress={() => {
              onFilesPress();
              setSelected('files');
            }}
          />
          <List.Item
            title="Changes"
            accessibilityRole="radio"
            accessibilityLabel="Changes"
            selected={selected === 'changes'}
            onPress={() => setSelected('changes')}
          />
        </ItemGroup>
      );
    }

    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <RadioGroupHarness />
      </PluginUiProvider>,
    );
    const radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));

    await act(async () => {
      radios[0]?.focus();
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        bubbles: true,
        cancelable: true,
      }));
      radios[0]?.dispatchEvent(new KeyboardEvent('keyup', {
        key: ' ',
        code: 'Space',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onFilesPress).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(radios[0]);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    mount.unmount();
  });

  it('uses the projected RTL direction for ItemGroup horizontal arrow movement', async () => {
    function RtlRadioGroupHarness() {
      const [selected, setSelected] = useState<'first' | 'middle' | 'last'>('middle');
      return (
        <ItemGroup accessibilityRole="radiogroup" accessibilityLabel="RTL review scope">
          <List.Item
            title="First"
            accessibilityRole="radio"
            accessibilityLabel="First"
            selected={selected === 'first'}
            onPress={() => setSelected('first')}
          />
          <List.Item
            title="Middle"
            accessibilityRole="radio"
            accessibilityLabel="Middle"
            selected={selected === 'middle'}
            onPress={() => setSelected('middle')}
          />
          <List.Item
            title="Last"
            accessibilityRole="radio"
            accessibilityLabel="Last"
            selected={selected === 'last'}
            onPress={() => setSelected('last')}
          />
        </ItemGroup>
      );
    }

    const context = createSurfaceContext({ direction: 'rtl' });
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <RtlRadioGroupHarness />
      </PluginUiProvider>,
    );
    let radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));

    await act(async () => {
      radios[1]?.focus();
      radios[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(document.activeElement).toBe(radios[0]);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    mount.unmount();
  });

  it('announces a multi-selectable listbox only while the selection capability is mounted', () => {
    const repositories = [
      { id: 'happier', title: 'happier' },
      { id: 'protocol', title: 'protocol' },
    ] as const;
    type Repository = (typeof repositories)[number];

    function RepositoryList(props: Readonly<{ multiple: boolean }>) {
      const store = useListMultiSelectionController({ scopeKey: 'repositories', rows: 'collection' });
      return (
        <List
          accessibilityLabel="Repositories"
          items={repositories}
          keyForItem={(item: Repository) => item.id}
          renderItem={(item: Repository) => <List.Item title={item.title} onPress={() => undefined} />}
          selection={{
            onSelectedKeyChange: () => undefined,
            ...(props.multiple ? { multiple: { store } } : {}),
          }}
        />
      );
    }

    const context = createSurfaceContext();
    const multiple = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <RepositoryList multiple />
      </PluginUiProvider>,
    );
    // Several `aria-selected` options in a listbox that never declares itself
    // multi-selectable are contradictory: a screen reader announces the last
    // one as THE selection, so a bulk action acts on rows the reader was never
    // told it had chosen.
    expect(multiple.container.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable'))
      .toBe('true');
    multiple.unmount();

    const single = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <RepositoryList multiple={false} />
      </PluginUiProvider>,
    );
    // The single-selection listbox must NOT claim it, or every ordinary plugin
    // list would tell a reader it can choose several rows when it cannot.
    expect(single.container.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable'))
      .toBeNull();
    single.unmount();
  });
});
