import * as React from 'react';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ThemeLibraryEntry, ThemeProfileDocument, ThemeProfileMode, ThemeReference } from '@/theme/profiles/themeProfileTypes';
import { prepareThemeProfileCss } from '@/theme/css/prepareThemeCss';
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
    onFailure?: (error: unknown) => void;
}>;

/** Reads header facts only; selection effects and their admission remain with the theme Action owner. */
export function useThemeLibraryModel(input: ThemeLibraryModelInput, execute: ThemeUiActionExecute): ThemeLibraryViewProps {
    const [mode, setMode] = React.useState(input.showing);
    const [failure, setFailure] = React.useState<Readonly<{ key: string; error: unknown }> | null>(null);
    const title = React.useCallback((option: ThemeLibrarySourceOption) => option.kind === 'base'
        ? t('settingsAppearance.themeProfiles.defaultTheme') : option.title, []);
    const sourceLabel = React.useCallback((option: ThemeLibrarySourceOption) => {
        if (option.kind !== 'custom') return t('settingsAppearance.themeProfiles.builtInTheme');
        return resolveCustomThemeSourceLabel(option.entry?.source, input.labels, input.pluginNames);
    }, [input.pluginNames, input.labels]);
    const activeOption = React.useCallback((slotMode: ThemeProfileMode) => input.options.find(option =>
        option.reference !== null && sameStrictJsonValue(option.reference, input.selection[slotMode]))
        ?? input.options.find(option => option.kind === 'base' && option.preferredMode === slotMode)!, [input.options, input.selection]);
    const previewFor = React.useCallback((option: ThemeLibrarySourceOption, previewMode: ThemeProfileMode): ThemeLibraryTile['preview'] =>
        option.miniature ? { kind: 'miniature', miniature: option.miniature } : {
            kind: 'palette', palette: resolveThemeProfile({ mode: previewMode, profile: option.profile }),
            ...(option.profile?.style?.radius ? { radius: option.profile.style.radius } : {}),
        }, []);
    const chooseTheme = React.useCallback((key: string) => {
        const option = input.options.find(candidate => candidate.id === key);
        if (!option || activeOption(mode).id === key) return;
        setFailure(null);
        void execute(THEME_ACTION_IDS.apply, { ref: option.reference, mode }).catch((error: unknown) => {
            setFailure({ key, error }); input.onFailure?.(error);
        });
    }, [input.options, input.onFailure, activeOption, mode, execute]);
    const openCreate = React.useCallback(() => input.onCreate(), [input.onCreate]);
    const addMenu = React.useMemo((): readonly ThemeLibraryMenuItem[] => [
        { id: 'create', title: t('settingsAppearance.themeProfiles.newTheme'),
            subtitle: t('settingsAppearance.themeProfiles.newThemeDescription'), onSelect: openCreate },
        { id: 'import', title: t('settingsAppearance.themeProfiles.importProfile'),
            subtitle: t('settingsAppearance.themeProfiles.importThemeDescription'), onSelect: input.onImport },
    ], [openCreate, input.onImport]);
    const tiles = React.useMemo((): readonly ThemeLibraryTile[] => input.options.filter(option => option.preferredMode === mode).map(option => {
        const menu: ThemeLibraryMenuItem[] = [];
        if (option.entry?.editable) menu.push({ id: 'edit', title: input.labels.editTheme, onSelect: () => input.onEdit(option.id) });
        menu.push({ id: 'duplicate', title: t('settingsAppearance.themeProfiles.duplicateTheme'), onSelect: () => input.onCreate(option.id) });
        if (option.reference) menu.push({ id: 'export', title: input.labels.exportFile, onSelect: () => input.onExport(option.id) });
        const reference = option.reference;
        const share = input.onShare;
        return { key: option.id, name: title(option), sourceLabel: sourceLabel(option), preview: previewFor(option, mode), menu,
            ...(option.entry?.editable && reference && share ? { onShare: () => share(reference) } : {}) };
    }), [input.options, input.onEdit, input.onCreate, input.onExport, input.onShare, input.labels, mode, title, sourceLabel, previewFor]);
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
            const webOnlyRules = input.native && document ? prepareThemeProfileCss(document.profile).coverage.webOnly : 0;
            if ((compatibility?.status === 'partial' || webOnlyRules > 0) && !partialIds.has(option.id)) {
                partialIds.add(option.id);
                result.push({ kind: 'partial', name: title(option), requiresAppVersion: compatibility?.requiresAppVersion,
                    unsupportedPaths: compatibility?.unsupportedPaths ?? [], ...(webOnlyRules ? { webOnlyRules } : {}),
                    ...(input.onUpdate ? { onUpdate: input.onUpdate } : {}) });
            }
        }
        const document = input.selectedDocuments?.[input.showing];
        const areas = document ? [...new Set(prepareThemeProfileCss(document.profile).coverage.hides
            .filter(hidden => hidden.mode === 'both' || hidden.mode === input.showing)
            .map(hidden => hidden.address.surface))] : [];
        if (areas.length) result.push({ kind: 'hides', name: title(activeOption(input.showing)), areas,
            onUseBuiltIn: () => {
                void execute(THEME_ACTION_IDS.apply, { ref: null, mode: input.showing }).catch(error => input.onFailure?.(error));
            } });
        return result;
    }, [activeOption, title, input.selectedDocuments, input.showing, input.native, input.onUpdate, input.onFailure, execute]);
    return { slots, mode, selectedKey: activeOption(mode).id, tiles, hasOwnThemes: input.options.some(option => option.entry?.source.kind === 'yours'),
        facts,
        addMenu, onNewTheme: openCreate, onChooseMode: setMode, onChooseTheme: chooseTheme, onOpenStore: input.onOpenStore,
        ...(failure ? { notice: { text: resolveActionExecutionErrorMessage(failure.error, t('common.unavailable')),
            action: { title: t('common.retry'), onPress: () => chooseTheme(failure.key) } } }
            : input.failed ? { notice: { text: t('artifacts.browser.loadFailedBody'), action: { title: t('common.retry'), onPress: input.retry } } } : {}),
    };
}
