import * as React from 'react';

import { ThemeLibraryView } from '@/components/settings/appearance/themeProfiles/ThemeLibraryView';
import type {
  ThemeLibraryTile,
  ThemeLibraryViewProps,
} from '@/components/settings/appearance/themeProfiles/themeLibraryViewTypes';
import { ThemeProfileEditorView } from '@/components/settings/appearance/themeProfiles/ThemeProfileEditorView';
import type {
  ThemeEditorView,
  ThemeProfileEditorViewProps,
} from '@/components/settings/appearance/themeProfiles/themeProfileEditorViewTypes';
import { buildThemeProfileTokenGroups } from '@/components/settings/appearance/themeProfiles/themeProfileEditorModel';
import type {
  ThemeMiniatureData,
  ThemeProfileMode,
  ThemeProfileV1,
} from '@/theme/profiles/themeProfileTypes';

/**
 * Dev-only: Appearance → Themes and the theme editor at fixture props, for the states today's data cannot
 * reach yet (Store and plugin themes, Use on other devices…, E1/E3/E4 lines, CSS coverage, the surface
 * reference, picking). `?scene=A1|E1|E3|E4|D1|D2|D3|D4`. Neutral lab names; nothing here is a production path.
 */
export function ThemeLibrarySpecimen(props: Readonly<{ scene: string }>) {
  return props.scene.startsWith('D') ? (
    <EditorScene scene={props.scene} />
  ) : (
    <LibraryScene scene={props.scene} />
  );
}

const NOOP = () => {};
const mini = (
  mode: ThemeProfileMode,
  canvas: string,
  raised: string,
  text: string,
  accent: string,
  radius: ThemeMiniatureData['radius'] = 'soft',
): ThemeLibraryTile['preview'] => ({
  kind: 'miniature',
  miniature: {
    mode,
    canvas,
    raised,
    text,
    mutedText: text,
    accent,
    border: mode === 'dark' ? '#3A3632' : '#DDD6CC',
    radius,
  },
});
const MENU = [
  { id: 'edit', title: 'Edit', onSelect: NOOP },
  { id: 'duplicate', title: 'Duplicate theme', onSelect: NOOP },
  { id: 'export', title: 'Export file', onSelect: NOOP },
];
const LIGHT: readonly ThemeLibraryTile[] = [
  {
    key: 'notebook',
    name: 'Notebook',
    sourceLabel: 'Made by you',
    preview: mini('light', '#EFE6D8', '#FBF7F0', '#3B332B', '#B4572E', 'round'),
    menu: MENU,
  },
  {
    key: 'linen',
    name: 'Linen',
    sourceLabel: 'Made by you',
    preview: mini('light', '#E9EAE4', '#F8F8F5', '#2F3530', '#4C8A62'),
    menu: MENU,
  },
  {
    key: 'kraft',
    name: 'Kraft',
    sourceLabel: 'Made by you',
    preview: mini('light', '#E2D4BC', '#F1E7D6', '#3E3426', '#9A5B2A'),
    menu: MENU,
  },
  {
    key: 'harbor',
    name: 'Harbor',
    sourceLabel: 'Store',
    preview: mini('light', '#E6ECF2', '#F7FAFC', '#24303B', '#3B6FB6'),
    menu: MENU.slice(1),
  },
  {
    key: 'atlas',
    name: 'Atlas Light',
    sourceLabel: 'Store',
    preview: mini('light', '#E9ECF5', '#FAFBFE', '#262B3A', '#4655C8'),
    menu: MENU.slice(1),
  },
  {
    key: 'studio',
    name: 'Studio Mono',
    sourceLabel: 'Studio themes',
    preview: mini('light', '#E8E8E8', '#FFFFFF', '#1D1D1D', '#111111', 'sharp'),
    menu: MENU.slice(1),
  },
  {
    key: 'light',
    name: 'Default theme',
    sourceLabel: 'Built-in',
    preview: mini('light', '#F2F2F0', '#FFFFFF', '#1C1C1C', '#1C1C1C'),
    menu: MENU.slice(1, 2),
  },
  {
    key: 'crisp',
    name: 'Crisp Light',
    sourceLabel: 'Built-in',
    preview: mini('light', '#F4F5F7', '#FFFFFF', '#15171A', '#2E5BD8'),
    menu: MENU.slice(1),
  },
  {
    key: 'paper',
    name: 'Paper Light',
    sourceLabel: 'Built-in',
    preview: mini('light', '#F1EEE7', '#FCFBF8', '#2B2925', '#3C64C8'),
    menu: MENU.slice(1),
  },
];
const DARK: readonly ThemeLibraryTile[] = [
  {
    key: 'notebook-night',
    name: 'Notebook Night',
    sourceLabel: 'Made by you',
    preview: mini('dark', '#1A1714', '#221E1A', '#EDE5D8', '#D08B5B', 'round'),
    menu: MENU,
  },
  {
    key: 'dark',
    name: 'Default theme',
    sourceLabel: 'Built-in',
    preview: mini('dark', '#161616', '#1E1E1E', '#EDEDED', '#EDEDED'),
    menu: MENU.slice(1, 2),
  },
  {
    key: 'sunset',
    name: 'Sunset Dark',
    sourceLabel: 'Built-in',
    preview: mini('dark', '#17131A', '#201B22', '#F0E6DA', '#E2B85A'),
    menu: MENU.slice(1),
  },
];

function LibraryScene(props: Readonly<{ scene: string }>) {
  const [mode, setMode] = React.useState<ThemeProfileMode>('light');
  const [selected, setSelected] = React.useState<
    Record<ThemeProfileMode, string>
  >({ light: 'notebook', dark: 'sunset' });
  const empty = props.scene === 'E1';
  const tiles = (mode === 'light' ? LIGHT : DARK).filter(
    (tile) => !empty || tile.sourceLabel !== 'Made by you',
  );
  const slot = (slotMode: ThemeProfileMode) => {
    const tile = (slotMode === 'light' ? LIGHT : DARK).find(
      (candidate) => candidate.key === selected[slotMode],
    )!;
    return {
      mode: slotMode,
      name: tile.name,
      sourceLabel: tile.sourceLabel,
      preview: tile.preview,
      showing: slotMode === 'light',
      ...(slotMode === 'light' ? { onUseOtherDevices: NOOP } : {}),
    };
  };
  const props2: ThemeLibraryViewProps = {
    slots: { light: slot('light'), dark: slot('dark') },
    mode,
    selectedKey: selected[mode],
    tiles,
    hasOwnThemes: !empty,
    ...(props.scene === 'E3'
      ? {
          notice: {
            text: 'Notebook was made for a newer Happier, so its corners and part of its CSS aren’t shown here.',
            action: { title: 'Update Happier', onPress: NOOP },
          },
        }
      : {}),
    ...(props.scene === 'E4'
      ? {
          notice: {
            text: 'Notebook hides the sidebar on this device.',
            action: { title: 'Use a built-in theme', onPress: NOOP },
          },
        }
      : {}),
    addMenu: [
      {
        id: 'create',
        title: 'New theme',
        subtitle: 'Start from any theme and change its colors.',
        onSelect: NOOP,
      },
      {
        id: 'import',
        title: 'Import theme',
        subtitle: 'Paste JSON or choose a file.',
        onSelect: NOOP,
      },
    ],
    onNewTheme: NOOP,
    onChooseMode: setMode,
    onChooseTheme: (key) =>
      setSelected((current) => ({ ...current, [mode]: key })),
    onOpenStore: NOOP,
  };
  return <ThemeLibraryView {...props2} />;
}

const DRAFT: ThemeProfileV1 = {
  schemaVersion: 1,
  id: 'notebook-night',
  name: 'Notebook Night',
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
  base: { light: 'light', dark: 'dark' },
  assetAppearance: 'dark',
  overrides: {
    light: {},
    dark: {
      'background.canvas': '#1A1714',
      'surface.base': '#221E1A',
      'text.primary': '#EDE5D8',
      'control.button.primary.background': '#D08B5B',
      'message.user.background': '#2E2822',
    },
  },
  seeds: { canvas: '#1A1714', accent: '#D08B5B' },
  style: { radius: 'round' },
};
const CSS = `/* Notebook · compact list, floating composer */
[data-surface="session-row"] {
  min-height: 40px; padding: 4px 10px;
}
[data-surface="composer"] {
  margin: 0 48px 24px; border-radius: 22px;
}
[data-surface="composer"] { backdrop-filter: blur(12px); }
[data-surface="user-bubble"] { border-radius: 18px 18px 6px 18px; }
`;
const GROUPS = buildThemeProfileTokenGroups()
  .slice(0, 3)
  .map((group) => ({
    id: group.group,
    title: group.group,
    tokens: group.tokens.slice(0, 4),
  }));

function EditorScene(props: Readonly<{ scene: string }>) {
  const initial: ThemeEditorView =
    props.scene === 'D3' ? 'style' : props.scene === 'D4' ? 'css' : 'colors';
  const [view, setView] = React.useState<ThemeEditorView>(initial);
  const [radius, setRadius] = React.useState<'sharp' | 'soft' | 'round'>(
    'round',
  );
  const [picking, setPicking] = React.useState(props.scene === 'D2');
  const preview = mini(
    'dark',
    '#1A1714',
    '#221E1A',
    '#EDE5D8',
    '#D08B5B',
    radius,
  );
  const viewProps: ThemeProfileEditorViewProps = {
    header: {
      title: 'Notebook Night',
      description:
        'Changes show across the app as you edit, and stay when you save.',
      meta: [
        { key: 'mode', text: 'Dark' },
        { key: 'kind', text: 'Your theme' },
        { key: 'inUse', text: 'In use' },
      ],
      mark: preview,
      save: { disabled: false, onPress: NOOP },
      menu: [
        { id: 'duplicate', title: 'Duplicate theme', onSelect: NOOP },
        { id: 'export', title: 'Export file', onSelect: NOOP },
        { id: 'share', title: 'Share as plugin', onSelect: NOOP },
        {
          id: 'delete',
          title: 'Delete theme',
          destructive: true,
          onSelect: NOOP,
        },
      ],
    },
    readonly: false,
    view,
    onViewChange: setView,
    details: {
      name: 'Notebook Night',
      nameInvalid: false,
      autoFocus: false,
      onNameChange: NOOP,
      appearance: 'dark',
      onAppearanceChange: NOOP,
    },
    ...(props.scene === 'D1'
      ? {
          startFrom: {
            options: DARK.map((tile) => ({
              key: tile.key,
              name: tile.name,
              sourceLabel: tile.sourceLabel,
              preview: tile.preview,
            })),
            selectedKey: 'notebook-night',
            onChoose: NOOP,
          },
        }
      : {}),
    seeds: {
      canvas: '#1A1714',
      accent: '#D08B5B',
      canvasChanged: false,
      accentChanged: false,
      onChange: NOOP,
      onReset: NOOP,
    },
    colors: {
      draft: DRAFT,
      mode: 'dark',
      groups: GROUPS,
      invalidByToken: {},
      recentColors: [],
      query: '',
      onQueryChange: NOOP,
      highlightedTokenId: picking ? 'surface.base' : null,
      onChange: NOOP,
      onInvalidChange: NOOP,
      onReset: NOOP,
    },
    preview,
    picker: {
      active: picking,
      onToggle: () => setPicking((current) => !current),
    },
    style: {
      radius,
      onRadiusChange: setRadius,
      radiusPreview: (choice) =>
        mini('dark', '#1A1714', '#221E1A', '#EDE5D8', '#D08B5B', choice),
    },
    css: {
      value: CSS,
      resetKey: 'fixture',
      onChange: NOOP,
      coverage: {
        total: 4,
        native: 3,
        webOnly: 1,
      },
      onShowWebOnly: NOOP,
      surfaces: [
        { id: 'session-row', label: 'Session row', parts: ['root'] },
        { id: 'user-bubble', label: 'Your message', parts: ['root'] },
        { id: 'composer', label: 'Composer', parts: ['root', 'toolbar'] },
      ],
    },
  };
  return <ThemeProfileEditorView {...viewProps} />;
}
