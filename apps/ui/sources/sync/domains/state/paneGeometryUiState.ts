import { z } from 'zod/mini';
import { HAPPIER_SHELL_COLUMN_DEFAULT_WIDTH_PX } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX } from '@/components/settings/shell/settingsSidebarSizing';
import { DEFAULT_RIGHT_PREFERRED_PX, DEFAULT_SESSION_WIDTH_PX } from '@/components/ui/panels/paneBreakpoints';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

export const paneGeometryDefaults = {
    sidebarWidthPx: HAPPIER_SHELL_COLUMN_DEFAULT_WIDTH_PX,
    rightPaneWidthPx: DEFAULT_RIGHT_PREFERRED_PX,
    detailsPaneWidthPx: 600,
    bottomPaneHeightPx: 320,
    settingsNavSidebarWidthPx: SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX,
    sessionColumnWidthPx: DEFAULT_SESSION_WIDTH_PX,
} as const;

type PaneGeometryKey = keyof typeof paneGeometryDefaults;
const geometryKeys = Object.keys(paneGeometryDefaults) as PaneGeometryKey[];

// The predecessor stored proportionally scaled pixels with a viewport basis.
const scaledPaneDefaults = {
    sidebarWidthPx: { key: 'sidebarWidthBasisPx', pixels: [320], basis: 1200 },
    rightPaneWidthPx: { key: 'rightPaneWidthBasisPx', pixels: [360, 340], basis: 1200 },
    detailsPaneWidthPx: { key: 'detailsPaneWidthBasisPx', pixels: [520], basis: 1200 },
    bottomPaneHeightPx: { key: 'bottomPaneHeightBasisPx', pixels: [320], basis: 900 },
    settingsNavSidebarWidthPx: { key: 'settingsNavSidebarWidthBasisPx', pixels: [230, 280], basis: 1200 },
} satisfies Partial<Record<PaneGeometryKey, { key: string; pixels: readonly number[]; basis: number }>>;

export const retainedPaneGeometryKeys = [
    ...geometryKeys, ...Object.values(scaledPaneDefaults).map(entry => entry.key), 'collectionRailWidthsV1',
];

const width = z.number();
const railWidths = createPersistentUiState('collection-rail-width-v1', value => width.parse(value), { syncWebKeys: true });
const railWidthsSchema = z.record(z.string(), width);
const paneGeometry = createPersistentUiState('pane-geometry-v1', value => width.safeParse(value).data, { syncWebKeys: true });

export function readPaneGeometry(key: PaneGeometryKey): number {
    return paneGeometry.read(key) ?? paneGeometryDefaults[key];
}

export function usePaneGeometry(key: PaneGeometryKey): number {
    return usePersistentUiStateValue(paneGeometry, key) ?? paneGeometryDefaults[key];
}

export function writePaneGeometry(key: PaneGeometryKey, value: number): void {
    try { paneGeometry.set(key, width.parse(value)); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[ui-state] Pane geometry could not be persisted.');
    }
}

export function useCollectionRailGeometry(key: string): number | undefined {
    return usePersistentUiStateValue(railWidths, key);
}

export function readCollectionRailWidths(): Readonly<Record<string, number>> {
    return railWidths.readAll();
}

export function writeCollectionRailWidth(key: string, preferredWidth: number | null): void {
    if (preferredWidth === null) railWidths.remove(key);
    else railWidths.set(key, preferredWidth);
}

export function migratePaneGeometryFromSettings(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const source: Readonly<Record<string, unknown>> = input as Record<string, unknown>;
    if (!retainedPaneGeometryKeys.some(key => Object.hasOwn(source, key))) return input;
    for (const key of geometryKeys) {
        const pixels = width.safeParse(source[key]);
        if (!pixels.success) continue;
        const legacy = key === 'sessionColumnWidthPx' ? undefined : scaledPaneDefaults[key];
        const usedScaledDefault = legacy && source[legacy.key] === legacy.basis && legacy.pixels.includes(pixels.data);
        // A previous whole-record save persisted the then-default shell width as 272.
        const usedFormerSidebarDefault = key === 'sidebarWidthPx' && pixels.data === 272;
        if (usedScaledDefault || usedFormerSidebarDefault) continue;
        if (paneGeometry.readStrict(key, width.parse) === undefined) paneGeometry.set(key, pixels.data);
    }
    const rails = railWidthsSchema.safeParse(source.collectionRailWidthsV1);
    if (rails.success) {
        for (const [key, pixels] of Object.entries(rails.data)) {
            if (railWidths.readStrict(key, width.parse) === undefined) railWidths.set(key, pixels);
        }
    }
    const remaining = { ...source };
    for (const key of retainedPaneGeometryKeys) delete remaining[key];
    return remaining;
}
