import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HappierFieldBoxTrigger } from '@happier-dev/plugin-ui/presentation';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const popovers = vi.hoisted(() => ({
  anchorRefs: [] as unknown[],
  matchAnchorWidth: [] as unknown[],
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Dimensions: {
      get: () => ({ width: 1280, height: 900, scale: 2, fontScale: 1 }),
      addEventListener: () => ({ remove: () => {} }),
    },
  });
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

// The portal and window measurement are the boundary; the menu, its rows and its trigger stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
    undefined,
    {
      onRender: (props) => {
        if (!props.open) return;
        popovers.anchorRefs.push(props.anchorRef);
        popovers.matchAnchorWidth.push(
          props.portal && typeof props.portal === 'object'
            ? props.portal.matchAnchorWidth
            : undefined,
        );
      },
    },
  ),
);

await import('./DropdownMenu');
await import('@/components/ui/lists/listPresentation');

afterEach(() => {
  standardCleanup();
  popovers.anchorRefs.length = 0;
  popovers.matchAnchorWidth.length = 0;
});

const MEMBERS = [
  { id: 'web', title: 'web', testID: 'member:web' },
  { id: 'worker', title: 'worker', testID: 'member:worker' },
  { id: 'mail', title: 'mail', testID: 'member:mail' },
];

async function renderOpenField() {
  const { DropdownMenu } = await import('./DropdownMenu');
  const { ListPresentationProvider } =
    await import('@/components/ui/lists/listPresentation');
  const onSelect = vi.fn();
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <DropdownMenu
        open
        onOpenChange={() => {}}
        items={MEMBERS}
        selectedId="worker"
        onSelect={onSelect}
        itemTrigger={{
          title: 'Where it runs',
          subtitle: 'The container the command runs in',
        }}
      />
    </ListPresentationProvider>,
  );
  return { screen, onSelect };
}

it('hangs a page field select from its drawn field box at the box width, not from the whole row', async () => {
  const { screen, onSelect } = await renderOpenField();
  await vi.waitFor(() =>
    expect(screen.findAllHostsByTestId('member:mail').length).toBeGreaterThan(
      0,
    ),
  );
  const box = screen.findByType(HappierFieldBoxTrigger);
  expect(box.props.boxRef).toBeDefined();
  expect(popovers.anchorRefs.at(-1)).toBe(box.props.boxRef);
  expect(popovers.matchAnchorWidth.at(-1)).toBe(true);
  // What an item opens hangs from the same field.
  await screen.pressByTestIdAsync('member:mail');
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalled());
  expect(onSelect.mock.calls[0]![1].anchor.ref).toBe(box.props.boxRef);
});

it('marks the current value of a select as its one checked choice', async () => {
  const { screen } = await renderOpenField();
  await vi.waitFor(() =>
    expect(screen.findAllHostsByTestId('member:worker').length).toBeGreaterThan(
      0,
    ),
  );
  const checked = (id: string) =>
    screen
      .findAllHostsByTestId(`member:${id}`)
      .map(
        (node) =>
          (node.props.accessibilityState as { checked?: boolean } | undefined)
            ?.checked ?? node.props['aria-checked'],
      )
      .find((value) => value !== undefined);
  expect(checked('worker')).toBe(true);
  expect(checked('web')).toBe(false);
  expect(checked('mail')).toBe(false);
});

it('checks a searchable select’s current value, including an explicit None choice', async () => {
  const { DropdownMenu } = await import('./DropdownMenu');
  const { ListPresentationProvider } =
    await import('@/components/ui/lists/listPresentation');
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <DropdownMenu
        open
        search
        onOpenChange={() => {}}
        items={[{ id: '', title: 'None', testID: 'member:none' }, ...MEMBERS]}
        selectedId=""
        onSelect={() => {}}
        itemTrigger={{ title: 'App', placeholder: 'None' }}
      />
    </ListPresentationProvider>,
  );
  await vi.waitFor(() =>
    expect(screen.findAllHostsByTestId('member:none').length).toBeGreaterThan(0),
  );
  const checked = (id: string) =>
    screen
      .findAllHostsByTestId(`member:${id}`)
      .map(
        (node) =>
          (node.props.accessibilityState as { checked?: boolean } | undefined)
            ?.checked ?? node.props['aria-checked'],
      )
      .find((value) => value !== undefined);
  expect(checked('none')).toBe(true);
  expect(checked('web')).toBe(false);
});

it('keeps an empty-id prompt on the trigger and an explicit None as a checkable option', async () => {
  const { DropdownMenu } = await import('./DropdownMenu');
  const { ListPresentationProvider } =
    await import('@/components/ui/lists/listPresentation');
  const render = (prompt: boolean) => renderScreen(
    <ListPresentationProvider value="page">
      <DropdownMenu
        open
        onOpenChange={() => {}}
        // A caller's own explicit check on its prompt row is overruled too.
        items={[{ id: '', title: prompt ? 'Choose an agent' : 'None', testID: 'member:empty', ...(prompt ? { prompt: true, checked: true } : {}) },
          ...MEMBERS]}
        selectedId=""
        onSelect={() => {}}
        itemTrigger={{ title: 'Agent' }}
      />
    </ListPresentationProvider>,
  );
  const checked = (screen: Awaited<ReturnType<typeof render>>, id: string) =>
    screen
      .findAllHostsByTestId(`member:${id}`)
      .map(
        (node) =>
          (node.props.accessibilityState as { checked?: boolean } | undefined)
            ?.checked ?? node.props['aria-checked'],
      )
      .find((value) => value !== undefined);
  const promptScreen = await render(true);
  await vi.waitFor(() =>
    expect(promptScreen.findAllHostsByTestId('member:worker').length).toBeGreaterThan(0),
  );
  expect(promptScreen.getTextContent()).toContain('Choose an agent');
  expect(promptScreen.findAllHostsByTestId('member:empty')).toHaveLength(0);
  await promptScreen.unmount();
  const noneScreen = await render(false);
  await vi.waitFor(() =>
    expect(noneScreen.findAllHostsByTestId('member:empty').length).toBeGreaterThan(0),
  );
  expect(checked(noneScreen, 'empty')).toBe(true);
});

it('shows Choose a branch only on the trigger and leaves real options unchecked', async () => {
  const { DropdownMenu } = await import('./DropdownMenu');
  const { ListPresentationProvider } =
    await import('@/components/ui/lists/listPresentation');
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <DropdownMenu
        open
        onOpenChange={() => {}}
        items={[{ id: 'ref:default', title: 'Choose a branch', testID: 'member:default', prompt: true },
          { id: 'ref:other', title: 'Other branch or revision…', testID: 'member:other' }]}
        selectedId="ref:default"
        onSelect={() => {}}
        itemTrigger={{ title: 'Branch' }}
      />
    </ListPresentationProvider>,
  );
  await vi.waitFor(() =>
    expect(screen.findAllHostsByTestId('member:other').length).toBeGreaterThan(0),
  );
  const states = (id: string) => screen.findAllHostsByTestId(`member:${id}`)
    .map((node) => [node.props.role ?? node.props.accessibilityRole, node.props['aria-checked'] ?? (node.props.accessibilityState as { checked?: boolean } | undefined)?.checked]);
  expect(states('other').some(([role]) => role === 'checkbox' || role === 'radio')).toBe(false);
  expect(screen.getTextContent()).toContain('Choose a branch');
  expect(screen.findAllHostsByTestId('member:default')).toHaveLength(0);
});
