import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderScreen, renderSettingsView } from '@/dev/testkit';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { lightTheme } from '@/theme';

// The web code field reads the page's editor global; a bare window stands in for the browser host.
(globalThis as unknown as { window: Window & typeof globalThis }).window ??= {
  innerWidth: 1440,
} as Window & typeof globalThis;

vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

vi.mock('reanimated-color-picker', async () =>
  (await import('@/dev/testkit/mocks/reanimatedColorPicker')).createReanimatedColorPickerMock(),
);

const { ThemeLibrarySpecimen } =
  await import('@/components/dev/themes/ThemeLibrarySpecimen');

type MenuAction = Readonly<{
  id: string;
  destructive?: boolean;
  onSelect: () => unknown;
}>;
const menuActions = (
  screen: Pick<Awaited<ReturnType<typeof renderScreen>>, 'findAllByProps'>,
  testID: string,
): readonly MenuAction[] =>
  screen
    .findAllByProps({ testID })
    .flatMap(
      (node: { props: { actions?: readonly MenuAction[] } }) =>
        node.props.actions ?? [],
    );

describe('theme library and editor views', () => {
  it('resolves a changed editor draft once for every rendered colour and contrast result', async () => {
    const { ThemeProfileEditorView } = await import('./ThemeProfileEditorView');
    const { ThemeColorRow, ThemeColorTokenRow } = await import('./ThemeColorTokenRow');
    const { buildThemeProfileTokenGroups, resolveThemeProfileEditorDraft } = await import('./themeProfileEditorModel');
    const specimen = await renderScreen(<ThemeLibrarySpecimen scene="D1" />);
    const basis = specimen.findByType<typeof ThemeProfileEditorView>(ThemeProfileEditorView).props;
    await specimen.unmount();
    let resolutions = 0;
    // The real resolver serializes style once per invocation, including a palette cache hit.
    const style = { radius: 'soft' as const, toJSON: () => {
      resolutions += 1;
      return { radius: 'soft' };
    } };
    const draft: import('@/theme/profiles/themeProfileTypes').ThemeProfileV1 = {
      schemaVersion: 1, id: 'cost', name: 'Cost', createdAt: '', updatedAt: '',
      base: { light: 'light', dark: 'dark' }, style,
      overrides: { light: {}, dark: { 'text.primary': '#eeeeee', 'background.canvas': '#ffffff' } },
    };
    const groups = buildThemeProfileTokenGroups().map(group => ({ ...group, id: group.group, title: group.group }));
    const resolvedDraft = resolveThemeProfileEditorDraft(draft, 'dark');
    const screen = await renderSettingsView(<ThemeProfileEditorView {...basis} colors={{ ...basis.colors, resolvedDraft, groups }} />);
    const foreground = screen.findAllByType(ThemeColorRow).find(row => row.props.rowId === 'dark-text.primary');
    expect(foreground?.props.value).toBe('#eeeeee');
    expect(foreground?.props.warning).toBeTruthy();
    expect(resolutions).toBe(1);
    await screen.unmount();
    const picked = await renderSettingsView(<ThemeProfileEditorView {...basis} colors={{
      ...basis.colors, resolvedDraft, groups,
      pickedTokenIds: ['background.canvas', 'text.primary'], highlightedTokenId: 'text.primary',
    }} />);
    const pickedRows = picked.findAllByType(ThemeColorTokenRow);
    expect(pickedRows.map(row => row.props.token.id)).toEqual(['background.canvas', 'text.primary']);
    expect(pickedRows.filter(row => row.props.highlighted).map(row => row.props.token.id)).toEqual(['text.primary']);
    expect(resolutions).toBe(1);
    await picked.unmount();
  });

  it('uses the surface registry names for picked targets and the CSS reference', async () => {
    const picking = await renderScreen(<ThemeLibrarySpecimen scene="D2" />);
    const pickText = picking.tree.findAll(node => typeof node.type === 'string').flatMap(node => node.children).join(' ');
    expect(pickText).toContain(t('settingsAppearance.themeProfiles.pickTarget', {
      surface: t('themeSurfaceLabels.composer'), role: 'Base surface',
    }));
    await picking.unmount();
    // renderScreen releases its browser globals on unmount; the CSS scene opens the real editor again.
    vi.stubGlobal('window', { innerWidth: 1440 });
    const reference = await renderScreen(<ThemeLibrarySpecimen scene="D4" />);
    const row = reference.findByTestId('settings-theme-surface-session-row');
    expect(row).not.toBeNull();
    const rowText = row!.findAll(node => typeof node.type === 'string').flatMap(node => node.children).join(' ');
    expect(rowText).toContain(t('themeSurfaceLabels.sessionRow'));
    const { ThemeProfileEditorView } = await import('./ThemeProfileEditorView');
    const basis = reference.findByType<typeof ThemeProfileEditorView>(ThemeProfileEditorView).props;
    await reference.unmount();
    vi.stubGlobal('window', { innerWidth: 1440 });
    const onInsertSelector = vi.fn();
    const onReady = vi.fn();
    const interactive = await renderSettingsView(<ThemeProfileEditorView {...basis} css={{ ...basis.css, onInsertSelector, onReady }} />);
    const interactiveRow = interactive.findHostByTestId('settings-theme-surface-session-row');
    expect(interactiveRow?.props.role).toBe('button');
    await act(async () => { interactiveRow!.props.onPress(); });
    expect(onInsertSelector).toHaveBeenCalledExactlyOnceWith('session-row');
    expect(onReady).toHaveBeenCalledOnce();
    await interactive.unmount();
    vi.stubGlobal('window', { innerWidth: 1440 });
    const readonly = await renderSettingsView(<ThemeProfileEditorView {...basis} readonly css={{ ...basis.css, onInsertSelector }} />);
    const readonlyRow = readonly.findHostByTestId('settings-theme-surface-session-row');
    expect(readonlyRow?.props.role).not.toBe('button');
    expect(readonlyRow?.props.onPress).toBeUndefined();
    expect(onInsertSelector).toHaveBeenCalledOnce();
    await readonly.unmount();
    vi.unstubAllGlobals();
  });

  it('windows the editor start-from library through the visual picker in its page', async () => {
    const { ThemeProfileEditorView } = await import('./ThemeProfileEditorView');
    const specimen = await renderScreen(<ThemeLibrarySpecimen scene="D1" />);
    const basis = specimen.findByType<typeof ThemeProfileEditorView>(ThemeProfileEditorView).props;
    await specimen.unmount();
    const onChoose = vi.fn();
    const option = basis.startFrom!.options[0]!;
    const screen = await renderSettingsView(<ThemeProfileEditorView {...basis} startFrom={{
      options: Array.from({ length: 200 }, (_, index) => ({ ...option, key: `theme-${index}`, name: `Theme ${index}` })),
      selectedKey: 'theme-0', onChoose,
    }} />);
    await act(async () => {
      for (const node of screen.tree.findAll(node => typeof node.type === 'string'
        && (node.props.testID === 'settings-theme-profile-editor' || node.props.role === 'radiogroup')
        && typeof node.props.onLayout === 'function')) {
        node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 600 } } });
      }
    });
    await measureMountedCollections(screen, { width: 960, height: 600 });
    const tiles = screen.tree.findAll(node => typeof node.type === 'string'
      && typeof node.props.testID === 'string' && /^settings-theme-profile-start:theme-\d+$/.test(node.props.testID));
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(200);
    console.info('[theme-window-cost] editor', { source: 200, mounted: tiles.length });
    await screen.pressByTestIdAsync('settings-theme-profile-start:theme-1');
    expect(onChoose).toHaveBeenCalledWith('theme-1');
    expect(onChoose).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("offers Share as plugin and, last and destructive, Delete on your own theme's menu", async () => {
    const screen = await renderSettingsView(<ThemeLibrarySpecimen scene="A1" />);
    // The grid windows through the shared Collection: give the page and the grid a measured size first.
    await act(async () => {
      for (const node of screen.tree.root.findAll((candidate) => typeof candidate.type === 'string'
        && typeof candidate.props.onLayout === 'function'
        && ['settings-theme-profiles-screen', 'settings-theme-light-library', 'settings-theme-light-library:stage'].includes(candidate.props.testID))) {
        node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 900 } } });
      }
    });
    await measureMountedCollections(screen, { width: 960, height: 900 });
    const ids = menuActions(screen, 'settings-theme-tile-menu-notebook').map(
      (action) => action.id,
    );
    expect(ids).toEqual([
      'edit',
      'duplicate',
      'export',
      'share-plugin',
      'delete',
    ]);
    expect(
      menuActions(screen, 'settings-theme-tile-menu-notebook').at(-1)
        ?.destructive,
    ).toBe(true);
  });

  it('says a partly shown theme once under both slots in warning text ink, with its repair', async () => {
    const screen = await renderScreen(<ThemeLibrarySpecimen scene="E3" />);
    expect(
      screen.findAllByProps({ testID: 'settings-theme-notice' }),
    ).toHaveLength(1);
    const notice = screen.findByTestId('settings-theme-notice')!;
    expect(notice.findAllByType(Text)[0]!.props.style.color).toBe(lightTheme.colors.state.warning.textForeground);
  });

  it('puts Share as plugin right after Export file in the editor menu', async () => {
    const screen = await renderScreen(<ThemeLibrarySpecimen scene="D3" />);
    const ids = menuActions(screen, 'settings-theme-profile-menu').map(
      (action) => action.id,
    );
    expect(ids.indexOf('share-plugin')).toBe(ids.indexOf('export') + 1);
  });

  it('lists the web-only rules only after Which is pressed', async () => {
    // The web code field reads the page's editor global; a bare window stands in for the browser host.
    (globalThis as unknown as { window?: object }).window ??= { innerWidth: 1440 };
    const screen = await renderScreen(<ThemeLibrarySpecimen scene="D4" />);
    expect(
      screen.findByTestId('settings-theme-profile-css-web-only'),
    ).toBeNull();
    await screen.pressByTestIdAsync('settings-theme-profile-css-which');
    expect(
      screen.findByTestId('settings-theme-profile-css-web-only'),
    ).not.toBeNull();
  });
});
