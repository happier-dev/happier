import * as React from 'react';

import type { DropdownMenuItem, DropdownMenuSubmenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import {
    areSessionAppearanceColorsEqual,
    parseSessionAppearanceColor,
    resolveSessionAppearanceColor,
    sessionAppearanceColorKey,
    type SessionAppearanceColor,
} from '@/sync/domains/session/organization/appearanceColor';
import { ACCENT_COLOR_KEYS, type AccentColorKey } from '@/theme/accentColors';
import { t } from '@/text';

/** Seven abutting 44pt targets plus row padding; wraps instead of clipping when a narrow screen cannot fit them. */
const COLOR_SUBMENU_MAX_WIDTH = 324;
const CUSTOM_PICKER_SUFFIX = 'custom-picker';
const SWATCH_GRID_GROUP = 'colors';
const REMOVE_SUFFIX = 'remove';

const ACCENT_TITLE_KEYS = {
    blue: 'sessionsList.appearance.colors.blue',
    green: 'sessionsList.appearance.colors.green',
    orange: 'sessionsList.appearance.colors.orange',
    yellow: 'sessionsList.appearance.colors.yellow',
    red: 'sessionsList.appearance.colors.red',
    indigo: 'sessionsList.appearance.colors.indigo',
    purple: 'sessionsList.appearance.colors.purple',
} as const satisfies Record<AccentColorKey, string>;

export type SessionAppearanceColorMenuInput = Readonly<{
    /** The colour this target owns — inherited colours are not marked or removable here. */
    current: SessionAppearanceColor | null;
    /** A colour shown on the target without being its own (a session's project colour); marked quietly, not removable. */
    inherited?: SessionAppearanceColor | null;
    /** Custom colours currently in use (from `useCustomSessionAppearanceColors`). */
    customColors: readonly `#${string}`[];
    /** Paint comes only from `resolveSessionAppearanceColor` against this theme. */
    theme: SessionAppearanceTheme;
    /** The custom picker is loading after a selection: its item shows progress. */
    customPickerLoading?: boolean;
}>;

export type SessionAppearanceTheme = Parameters<typeof resolveSessionAppearanceColor>[1];

export type SessionAppearanceColorMenuSelection =
    | Readonly<{ kind: 'set'; color: SessionAppearanceColor }>
    | Readonly<{ kind: 'custom' }>
    | Readonly<{ kind: 'remove' }>;

function colorItemId(menuId: string, color: SessionAppearanceColor): string {
    return `${menuId}:${sessionAppearanceColorKey(color)}`;
}

/**
 * The one colour submenu for sessions and projects: theme presets, colours in use, a custom picker
 * entry, and removal when the target owns a colour.
 */
export function buildSessionAppearanceColorSubmenu(params: SessionAppearanceColorMenuInput & Readonly<{
    menuId: string;
    iconColor: string;
}>): DropdownMenuSubmenu {
    // Opening the submenu is the intent signal: start fetching the picker so Custom color… is usually instant.
    const onOpen = preloadSessionAppearanceCustomColorModal;
    const { current } = params;
    // An own colour wins; only an uncoloured target shows what it inherits.
    const inherited = current ? null : params.inherited ?? null;
    const inheritedHint = inherited ? t('sessionsList.appearance.inheritedFromProject') : undefined;
    const swatchItem = (color: SessionAppearanceColor, title: string, group: string): DropdownMenuItem => {
        const isInherited = inherited !== null && areSessionAppearanceColorsEqual(inherited, color);
        return {
            id: colorItemId(params.menuId, color),
            title,
            ...(isInherited ? { subtitle: inheritedHint } : {}),
            swatch: {
                color: resolveSessionAppearanceColor(color, params.theme) ?? '',
                checked: areSessionAppearanceColorsEqual(current, color),
                inherited: isInherited,
                group,
            },
        };
    };
    // One continuous wrapped grid: presets, colours in use, then Remove.
    const presets = ACCENT_COLOR_KEYS.map((key) => swatchItem({ kind: 'accent', key }, t(ACCENT_TITLE_KEYS[key]), SWATCH_GRID_GROUP));
    const customHexes = [...params.customColors];
    for (const shown of [current, inherited]) {
        if (shown?.kind === 'custom' && !customHexes.includes(shown.hex)) customHexes.push(shown.hex);
    }
    const customs = customHexes.map((hex) => swatchItem({ kind: 'custom', hex }, t('sessionsList.appearance.customColorLabel', { hex }), SWATCH_GRID_GROUP));
    const remove: DropdownMenuItem[] = current ? [{
        id: `${params.menuId}:${REMOVE_SUFFIX}`,
        title: t('sessionsList.appearance.removeColor'),
        swatch: { color: '', empty: true, checked: false, group: SWATCH_GRID_GROUP },
    }] : [];
    return {
        maxWidthCap: COLOR_SUBMENU_MAX_WIDTH,
        onOpen,
        items: [
            ...presets,
            ...customs,
            ...remove,
            {
                id: `${params.menuId}:${CUSTOM_PICKER_SUFFIX}`,
                title: t('sessionsList.appearance.customColor'),
                icon: <Icon name="plus" size={16} color={params.iconColor} />,
                // The picker loads first; the owner closes the menu once the dialog is ready.
                keepMenuOpen: true,
                ...(params.customPickerLoading ? { loading: true } : {}),
            },
        ],
    };
}

export function buildSessionAppearanceColorMenuItem(params: SessionAppearanceColorMenuInput & Readonly<{
    menuId: string;
    iconColor: string;
    base?: DropdownMenuItem | null;
}>): DropdownMenuItem {
    return {
        ...(params.base ?? {
            id: params.menuId,
            title: t('sessionsList.appearance.setColor'),
            icon: <Icon name="palette" size={16} color={params.iconColor} />,
        }),
        id: params.menuId,
        submenu: buildSessionAppearanceColorSubmenu(params),
    };
}

export function resolveSessionAppearanceColorMenuSelection(menuId: string, itemId: string): SessionAppearanceColorMenuSelection | null {
    const prefix = `${menuId}:`;
    if (!itemId.startsWith(prefix)) return null;
    const rest = itemId.slice(prefix.length);
    if (rest === CUSTOM_PICKER_SUFFIX) return { kind: 'custom' };
    if (rest === REMOVE_SUFFIX) return { kind: 'remove' };
    const separator = rest.indexOf(':');
    if (separator <= 0) return null;
    const kind = rest.slice(0, separator);
    const value = rest.slice(separator + 1);
    const color = parseSessionAppearanceColor(kind === 'accent' ? { kind, key: value } : { kind, hex: value });
    return color ? { kind: 'set', color } : null;
}

let customColorModalModule: Promise<typeof import('./SessionAppearanceCustomColorModal')> | null = null;

/** Idempotent; a failed load is forgotten so the next attempt retries. */
export function preloadSessionAppearanceCustomColorModal(): Promise<typeof import('./SessionAppearanceCustomColorModal')> {
    if (!customColorModalModule) {
        customColorModalModule = import('./SessionAppearanceCustomColorModal');
        customColorModalModule.catch(() => {
            customColorModalModule = null;
        });
    }
    return customColorModalModule;
}

/**
 * Loads the picker (the menu stays open meanwhile), calls `onReady` once it can open, then shows it.
 * Resolves with the picked colour, or null when dismissed; rejects when the picker cannot load.
 */
export async function openSessionAppearanceCustomColorPicker(params: Readonly<{
    initialColor: SessionAppearanceColor | null;
    serverId?: string | null;
    onReady?: () => void;
}>): Promise<SessionAppearanceColor | null> {
    const { SessionAppearanceCustomColorModal } = await preloadSessionAppearanceCustomColorModal();
    params.onReady?.();
    return await new Promise((resolve) => {
        Modal.show({
            component: SessionAppearanceCustomColorModal,
            props: { initialColor: params.initialColor, serverId: params.serverId ?? null, onResolve: resolve },
            onRequestClose: () => resolve(null),
            // The dialog owns its chrome (title, size, footer) through useModalCardChrome.
            chrome: { kind: 'card' },
            closeOnBackdrop: true,
        });
    });
}

/**
 * Turns a menu selection into the colour to write: `undefined` when nothing should change (not a
 * colour item, or the custom picker was dismissed), otherwise the colour or `null` to clear.
 * The custom path reports its progress (`onPickerLoading`) and closes the menu (`closeMenus`) once ready.
 */
export async function resolveSessionAppearanceColorMenuChoice(params: Readonly<{
    menuId: string;
    itemId: string;
    current: SessionAppearanceColor | null;
    /** Seeds the custom picker when the target has no colour of its own. */
    inherited?: SessionAppearanceColor | null;
    serverId?: string | null;
    onPickerLoading?: (loading: boolean) => void;
    closeMenus?: () => void;
}>): Promise<SessionAppearanceColor | null | undefined> {
    const selection = resolveSessionAppearanceColorMenuSelection(params.menuId, params.itemId);
    if (!selection) return undefined;
    if (selection.kind === 'remove') return null;
    if (selection.kind === 'set') return selection.color;
    params.onPickerLoading?.(true);
    try {
        const picked = await openSessionAppearanceCustomColorPicker({
            initialColor: params.current ?? params.inherited ?? null,
            serverId: params.serverId,
            onReady: () => {
                params.onPickerLoading?.(false);
                params.closeMenus?.();
            },
        });
        return picked ?? undefined;
    } finally {
        params.onPickerLoading?.(false);
    }
}
