import * as React from 'react';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { themeSurfaceLabel } from '@/theme/css/themeSurfaceLabels';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ThemeActionId } from '@happier-dev/protocol/actions/themeActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ThemeLibraryEntry, ThemeProfileDocument, ThemeProfileMode, ThemeReference } from '@/theme/profiles/themeProfileTypes';
import { usePreparedThemeCss } from '@/theme/css/usePreparedThemeCss';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { resolveCustomThemeSourceLabel, type ThemePresetSourceOption } from './themeProfilePresetOptions';
import type { ThemeLibraryMenuItem, ThemeLibraryTile, ThemeLibrarySlot, ThemeLibraryViewProps } from './themeLibraryViewTypes';
import type { ThemeUiActionExecute } from './useThemeActionExecution';

/** Consumes MODEL's header options while its inventory migration is published atomically. */
export type ThemeLibrarySourceOption = Omit<ThemePresetSourceOption, 'reference' | 'miniature' | 'entry'> & Readonly<{
    reference: ThemeReference | null;
    miniature?: ThemeLibraryEntry['miniature'];
    entry?: ThemeLibraryEntry;
}>;
export type ThemeLibraryModelInput = Readonly<{
    /** MODEL's options include the light and dark base choices. */
    options: readonly ThemeLibrarySourceOption[];
    labels: Readonly<{ sourceYours: string; sourceStore: string; sourcePlugin: string; editTheme: string; exportFile: string }>;
    selection: Readonly<Record<ThemeProfileMode, ThemeReference | null>>;
    showing: ThemeProfileMode;
    appearanceMode?: ThemePreference;
    onChangeAppearanceMode?: (mode: ThemePreference) => void;
    native?: boolean;
    selectedDocuments?: Readonly<Record<ThemeProfileMode, ThemeProfileDocument | null>>;
    onUpdate?: () => void;
    failed?: boolean;
    retry: () => void;
    pluginNames?: ReadonlyMap<string, string>;
    onCreate: (from?: string) => void;
    onEdit: (id: string) => void;
    onExport: (id: string) => void;
    onShare?: (reference: ThemeReference) => void;
    onImport: () => void;
    onOpenStore?: () => void;
    onUseOtherDevices?: (theme: Readonly<{ reference: ThemeReference | null; mode: ThemeProfileMode; name: string }>) => void;
    onFailure?: (error: unknown, actionId?: ThemeActionId) => void;
}>;

/** Reads header facts only; selection effects and their admission remain with the theme Action owner. */
export function useThemeLibraryModel(input: ThemeLibraryModelInput, execute: ThemeUiActionExecute): ThemeLibraryViewProps {
    const presented = useLayoutPresentationActive();
    const lightCss = usePreparedThemeCss(input.selectedDocuments?.light?.profile.css ?? '', presented);
    const darkCss = usePreparedThemeCss(input.selectedDocuments?.dark?.profile.css ?? '', presented);
    const preparedLight = lightCss.prepared;
    const preparedDark = darkCss.prepared;
    const mode = input.showing;
    const [failure, setFailure] = React.useState<Readonly<{ key: string; error: unknown; retry?: () => void }> | null>(null);
    const title = React.useCallback((option: ThemeLibrarySourceOption) => option.kind === 'base'
        ? t('settingsAppearance.themeProfiles.defaultTheme') : option.title, []);
    const sourceLabel = React.useCallback((option: ThemeLibrarySourceOption) => {
        if (option.kind !== 'custom') return t('settingsAppearance.themeProfiles.builtInTheme');
        return resolveCustomThemeSourceLabel(option.entry?.source, input.labels, input.pluginNames);
    }, [input.pluginNames, input.labels]);
    const activeOption = React.useCallback((slotMode: ThemeProfileMode) => input.options.find(option =>
        option.reference !== null && sameStrictJsonValue(option.reference, input.selection[slotMode]))
        ?? input.options.find(option => option.kind === 'base' && option.preferredMode === slotMode)!, [input.options, input.selection]);
    const preparationError = lightCss.error ?? darkCss.error;
    React.useEffect(() => {
        if (preparationError) input.onFailure?.(preparationError);
    }, [preparationError, input.onFailure]);
    const previewFor = React.useCallback((option: ThemeLibrarySourceOption, previewMode: ThemeProfileMode): ThemeLibraryTile['preview'] => {
        const miniature = option.entry?.miniatures?.[previewMode] ?? option.miniature;
        return miniature ? { kind: 'miniature', miniature } : {
            kind: 'palette', palette: resolveThemeProfile({ mode: previewMode, profile: option.profile }),
            ...(option.profile?.style?.radius ? { radius: option.profile.style.radius } : {}),
        };
    }, []);
    const chooseTheme = React.useCallback((key: string) => {
        const option = input.options.find(candidate => candidate.id === key);
        if (!option) return;
        setFailure(null);
        void (async () => {
            const document = option.reference ? (await execute(THEME_ACTION_IDS.get, {
                ref: option.reference, include: ['document'],
            })).document : null;
            if (document === undefined) throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'Theme not found' });
            await execute(THEME_ACTION_IDS.tryOn, { document, mode: option.preferredMode, origin: { kind: 'editor' } });
        })().catch((error: unknown) => {
            setFailure({ key, error }); input.onFailure?.(error, THEME_ACTION_IDS.tryOn);
        });
    }, [input.options, input.onFailure, execute]);
    const deleteTheme = React.useCallback((key: string, reference: ThemeReference) => {
        setFailure(null);
        void execute(THEME_ACTION_IDS.delete, { ref: reference }).catch((error: unknown) => {
            setFailure({ key, error, retry: () => deleteTheme(key, reference) });
            input.onFailure?.(error, THEME_ACTION_IDS.delete);
        });
    }, [execute, input.onFailure]);
    const openCreate = React.useCallback(() => input.onCreate(), [input.onCreate]);
    const addMenu = React.useMemo((): readonly ThemeLibraryMenuItem[] => [
        { id: 'create', title: t('settingsAppearance.themeProfiles.newTheme'),
            subtitle: t('settingsAppearance.themeProfiles.newThemeDescription'), onSelect: openCreate },
        { id: 'import', title: t('settingsAppearance.themeProfiles.importProfile'),
            subtitle: t('settingsAppearance.themeProfiles.importThemeDescription'), onSelect: input.onImport },
        ...(input.onOpenStore ? [{ id: 'store', title: t('settingsAppearance.themeProfiles.fromStore'), onSelect: input.onOpenStore }] : []),
    ], [openCreate, input.onImport, input.onOpenStore]);
    const tiles = React.useMemo((): readonly ThemeLibraryTile[] => input.options.map(option => {
        const menu: ThemeLibraryMenuItem[] = [];
        if (option.entry?.editable) menu.push({ id: 'edit', title: input.labels.editTheme, onSelect: () => input.onEdit(option.id) });
        menu.push({ id: 'duplicate', title: t('settingsAppearance.themeProfiles.duplicateTheme'), onSelect: () => input.onCreate(option.id) });
        if (option.reference) menu.push({ id: 'export', title: input.labels.exportFile, onSelect: () => input.onExport(option.id) });
        const reference = option.reference;
        const share = input.onShare;
        return { key: option.id, name: title(option), sourceLabel: sourceLabel(option), preview: previewFor(option, option.preferredMode),
            dual: (option.entry?.modes?.length ?? 1) > 1,
            previews: Object.fromEntries((option.entry?.modes ?? [option.preferredMode]).map(previewMode => [previewMode,
                option.entry?.miniatures?.[previewMode] ? { kind: 'miniature' as const, miniature: option.entry.miniatures[previewMode]! } : previewFor(option, previewMode)])), menu,
            ...(option.entry?.editable && reference ? { onDelete: () => deleteTheme(option.id, reference) } : {}),
            ...(option.entry?.editable && reference && share ? { onShare: () => share(reference) } : {}) };
    }), [input.options, input.onEdit, input.onCreate, input.onExport, input.onShare, input.labels, title, sourceLabel, previewFor, deleteTheme]);
    const retainedTiles = React.useRef<readonly ThemeLibraryTile[]>([]);
    retainedTiles.current = retainDeep(retainedTiles.current, tiles);
    const stableTiles = retainedTiles.current;
    const sections = React.useMemo(() => {
        const byKey = new Map(input.options.map(option => [option.id, option.preferredMode]));
        const grouped: Record<ThemeProfileMode, ThemeLibraryTile[]> = { light: [], dark: [] };
        for (const tile of stableTiles) grouped[byKey.get(tile.key)!].push(tile);
        return (['light', 'dark'] as const).map(sectionMode => ({ mode: sectionMode, selectedKey: activeOption(sectionMode).id, tiles: grouped[sectionMode] }));
    }, [stableTiles, input.options, activeOption]);
    const slots = React.useMemo((): Record<ThemeProfileMode, ThemeLibrarySlot> => {
        const slot = (slotMode: ThemeProfileMode): ThemeLibrarySlot => {
            const option = activeOption(slotMode);
            return { mode: slotMode, name: title(option), sourceLabel: sourceLabel(option), preview: previewFor(option, slotMode),
                showing: input.showing === slotMode,
                ...(input.onUseOtherDevices ? { onUseOtherDevices: () => input.onUseOtherDevices!({ reference: option.reference, mode: slotMode, name: title(option) }) } : {}) };
        };
        return { light: slot('light'), dark: slot('dark') };
    }, [activeOption, title, sourceLabel, previewFor, input.showing, input.onUseOtherDevices]);
    const facts = React.useMemo((): NonNullable<ThemeLibraryViewProps['facts']> => {
        const result: NonNullable<ThemeLibraryViewProps['facts']>[number][] = [];
        const partialIds = new Set<string>();
        for (const slotMode of ['light', 'dark'] as const) {
            const option = activeOption(slotMode);
            const document = input.selectedDocuments?.[slotMode];
            const compatibility = option.entry?.compatibility ?? document?.compatibility;
            const prepared = slotMode === 'light' ? preparedLight : preparedDark;
            const webOnlyRules = input.native && document ? prepared?.coverage.webOnly ?? 0 : 0;
            if ((compatibility?.status === 'partial' || webOnlyRules > 0) && !partialIds.has(option.id)) {
                partialIds.add(option.id);
                result.push({ kind: 'partial', name: title(option), requiresAppVersion: compatibility?.requiresAppVersion,
                    unsupportedPaths: compatibility?.unsupportedPaths ?? [], ...(webOnlyRules ? { webOnlyRules } : {}),
                    ...(input.onUpdate ? { onUpdate: input.onUpdate } : {}) });
            }
        }
        const document = input.selectedDocuments?.[input.showing];
        const prepared = input.showing === 'light' ? preparedLight : preparedDark;
        const areas = document && prepared ? [...new Set(prepared.coverage.hides
            .filter(hidden => hidden.mode === 'both' || hidden.mode === input.showing)
            .map(hidden => hidden.address.surface))].map(themeSurfaceLabel) : [];
        if (areas.length) result.push({ kind: 'hides', name: title(activeOption(input.showing)), areas,
            onUseBuiltIn: () => {
                void execute(THEME_ACTION_IDS.apply, { ref: null, mode: input.showing }).catch(error => input.onFailure?.(error));
            } });
        return result;
    }, [activeOption, title, input.selectedDocuments, input.showing, input.native, input.onUpdate, input.onFailure, execute, preparedLight, preparedDark]);
    return { slots, mode, appearanceMode: input.appearanceMode, onChangeAppearanceMode: input.onChangeAppearanceMode, sections, selectedKey: activeOption(mode).id, tiles: stableTiles, hasOwnThemes: input.options.some(option => option.entry?.source.kind === 'yours'),
        facts,
        addMenu, onChooseMode: next => input.onChangeAppearanceMode?.(next), onChooseTheme: chooseTheme, onOpenStore: input.onOpenStore,
        ...(preparationError ? { notice: { text: resolveActionExecutionErrorMessage(preparationError, t('common.unavailable')),
            action: { title: t('common.retry'), onPress: () => { lightCss.retry(); darkCss.retry(); } } } }
            : failure ? { notice: { text: resolveActionExecutionErrorMessage(failure.error, t('common.unavailable')),
            action: { title: t('common.retry'), onPress: failure.retry ?? (() => chooseTheme(failure.key)) } } }
            : input.failed ? { notice: { text: t('artifacts.browser.loadFailedBody'), action: { title: t('common.retry'), onPress: input.retry } } } : {}),
    };
}
