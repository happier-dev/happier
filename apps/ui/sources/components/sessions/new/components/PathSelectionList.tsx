/**
 * PathSelectionList — thin path-picker adapter over the generic SelectionList
 * primitive (Phase 11.3 of the agent-input-selection-list-popover-unification
 * plan).
 *
 * Responsibilities:
 *   - Compose FAVORITES + RECENT (static) + IN THIS FOLDER (dynamic) sections.
 *   - Wire the path-domain input behavior (filter leaf vs dir-seed split,
 *     walk-up on Backspace, autocomplete suppression on trailing-separator
 *     and root states) via Lane G's `makePathBrowseInputBehavior`.
 *   - Resolve the dynamic-section seed to an absolute path via Lane G's
 *     `resolveAbsolutePath` before calling the RPC, while keeping the display
 *     value in shorthand (`~/Doc` stays `~/Doc` until commit).
 *   - Expose the tree-browser escape hatch through the `inputSuffix` slot
 *     (NOT the footer — the footer is hint-only). Disabled when no machine
 *     is bound.
 *
 * Path semantics MUST flow through the machine's platform, never
 * `navigator.platform` (the local UI may run on macOS while the host is
 * Windows). The `machinePlatform` prop is the source of truth.
 */

import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View, type GestureResponderEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    SelectionList,
    type SelectionListHeightBehavior,
    type SelectionListOption,
    type SelectionListSectionDescriptor,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import {
    appendSegment,
    type PathTargetPlatform,
} from '@/utils/path/browseSegments';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { resolveDirectoryFavoriteComparisonKey } from '@/utils/sessions/favoriteDirectoriesToggle';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { InputBrowseButton } from '@/components/ui/buttons/InputBrowseButton';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { listMachineFileBrowserDirectoryEntries } from '@/sync/domains/input/machineFileBrowser';
import { t } from '@/text';

import { PathFavoriteToggleButton } from './PathFavoriteToggleButton';
import {
    createPathSelectionInputBehavior,
    resolvePathSelectionEmptyInputPath,
    resolvePathSelectionInitialInputValue,
    shouldShowPathSelectionBrowseSuggestions,
    type PathSelectionInitialSuggestionMode,
} from './createPathSelectionInputBehavior';


export type PathSelectionListFavorite = Readonly<{ path: string; label?: string }>;
export type PathSelectionListRecent = Readonly<{ path: string; lastUsedAt: number }>;

/**
 * RUX-1 Issue 6: detect "path does not exist" errors from the file-browser
 * RPC. Looks for the canonical Node/POSIX error codes that indicate the
 * directory does not exist OR is not a directory. Anything else is treated
 * as a transient/RPC failure and surfaced via the generic error path.
 *
 * Exported for unit testing. Case-insensitive.
 */
export function isPathNotFoundErrorMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    if (normalized.length === 0) return false;
    if (normalized.includes('enoent')) return true;
    if (normalized.includes('enotdir')) return true;
    if (normalized.includes('no such file or directory')) return true;
    if (normalized.includes('not a directory')) return true;
    return false;
}

export type PathSelectionListProps = Readonly<{
    initialValue: string;
    /**
     * Default `browse` preserves the original direct picker behavior: a
     * path-shaped initial value immediately drives IN THIS FOLDER. Popover
     * callers use `history` so opening the picker shows favorites/recents first
     * and only starts folder suggestions after explicit user input.
     */
    initialSuggestionMode?: PathSelectionInitialSuggestionMode;
    favorites: ReadonlyArray<PathSelectionListFavorite>;
    recents: ReadonlyArray<PathSelectionListRecent>;
    machineHomeDir: string;
    /**
     * RUX-3: predicate that decides whether a given absolute path is currently
     * a favorite. When omitted (back-compat), the favorite-toggle accessory is
     * NOT rendered on any row.
     */
    isFavorite?: (absolutePath: string) => boolean;
    /**
     * RUX-3: callback invoked when the user presses the favorite-toggle
     * accessory on a row. Receives the absolute path. The orchestrator (parent)
     * is responsible for persisting the change (e.g. via `useSettingMutable
     * ('favoriteDirectories')`). When omitted (back-compat), the toggle is not
     * rendered.
     */
    onToggleFavorite?: (absolutePath: string) => void;
    /**
     * `null` when no machine is bound (e.g. unattached new-session draft). When
     * null:
     *   - The dynamic IN THIS FOLDER section's resolver short-circuits to an
     *     empty result (no RPC fired).
     *   - The tree-browser `inputSuffix` button is disabled (nothing to browse).
     */
    machineId: string | null;
    serverId?: string | null;
    /**
     * Target machine platform. MUST be derived from machine metadata, NEVER
     * from `navigator.platform`. Defaults to `'auto'` only when the caller has
     * no platform info; callers should pass the explicit machine platform.
     */
    machinePlatform?: PathTargetPlatform;
    onCommit: (path: string) => void;
    onChangeDraftPath?: (path: string) => void;
    onRequestClose: () => void;
    /**
     * Pre-existing path-picker escape-hatch hook — must still fire (and be
     * awaited) before the tree-browser modal opens.
     */
    onBeforeBrowseMachinePath?: () => void | Promise<void>;
    /**
     * RUX-8: clamps the underlying `SelectionList` height so the body
     * scrolls within the popover instead of sprawling beyond the surface and
     * pushing the footer (keyboard hints) off-screen. When `undefined`, the
     * list is unconstrained (back-compat / full-screen embedding).
     */
    maxHeight?: number;
    heightBehavior?: SelectionListHeightBehavior;
}>;

type FavoriteAccessoryFactory = (absolutePath: string, optionTestIdPrefix: string) => React.ReactNode | undefined;

function PathDrillDownButton(props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    onPress: () => void;
}>): React.ReactElement {
    const { testID, accessibilityLabel, onPress } = props;
    const { theme } = useUnistyles();
    const handlePress = React.useCallback((event?: GestureResponderEvent) => {
        event?.stopPropagation();
        onPress();
    }, [onPress]);

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPress={handlePress}
            hitSlop={8}
            style={{
                width: 28,
                height: 28,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 14,
            }}
        >
            <Ionicons name="chevron-forward" size={16} color={theme.colors.text.tertiary} />
        </Pressable>
    );
}

function buildFavoriteOptions(
    favorites: ReadonlyArray<PathSelectionListFavorite>,
    machineHomeDir: string,
    onCommit: (path: string) => void,
    favoriteAccessory: FavoriteAccessoryFactory,
    rootTestId: string,
): ReadonlyArray<SelectionListOption> {
    return favorites
        .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim().length > 0)
        .map((entry) => {
            const absolutePath = resolveAbsolutePath(entry.path, machineHomeDir);
            const optionId = `favorite:${absolutePath}`;
            const accessoryTestIdPrefix = `${rootTestId}:path-root:option:${optionId}`;
            return {
                id: optionId,
                label: entry.label ?? formatPathRelativeToHome(absolutePath, machineHomeDir),
                subtitle: absolutePath,
                labelEllipsizeMode: 'head',
                subtitleEllipsizeMode: 'head',
                onSelect: () => onCommit(absolutePath),
                autocompleteValue: absolutePath,
                rightAccessory: favoriteAccessory(absolutePath, accessoryTestIdPrefix),
            } satisfies SelectionListOption;
        });
}

function buildRecentOptions(
    recents: ReadonlyArray<PathSelectionListRecent>,
    machineHomeDir: string,
    onCommit: (path: string) => void,
    favoriteAccessory: FavoriteAccessoryFactory,
    rootTestId: string,
): ReadonlyArray<SelectionListOption> {
    return recents
        .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim().length > 0)
        .map((entry) => {
            const absolutePath = resolveAbsolutePath(entry.path, machineHomeDir);
            const optionId = `recent:${absolutePath}`;
            const accessoryTestIdPrefix = `${rootTestId}:path-root:option:${optionId}`;
            return {
                id: optionId,
                label: formatPathRelativeToHome(absolutePath, machineHomeDir),
                subtitle: absolutePath,
                labelEllipsizeMode: 'head',
                subtitleEllipsizeMode: 'head',
                onSelect: () => onCommit(absolutePath),
                autocompleteValue: absolutePath,
                rightAccessory: favoriteAccessory(absolutePath, accessoryTestIdPrefix),
            } satisfies SelectionListOption;
        });
}

export function PathSelectionList(props: PathSelectionListProps): React.ReactElement {
    // Destructure cleanly so memo deps aren't fed `props` itself (which would
    // re-run effects on every parent render).
    const {
        initialValue,
        initialSuggestionMode = 'browse',
        favorites,
        recents,
        machineHomeDir,
        machineId,
        serverId,
        machinePlatform = 'auto',
        onCommit,
        onChangeDraftPath,
        onRequestClose,
        onBeforeBrowseMachinePath,
        isFavorite,
        onToggleFavorite,
        maxHeight,
    } = props;
    const ROOT_TEST_ID = 'path-selection-list';
    const modalPortalTarget = useModalPortalTarget();

    const [inputValue, setInputValue] = React.useState(() => resolvePathSelectionInitialInputValue({
        initialValue,
        initialSuggestionMode,
    }));
    const [hasUserEditedInput, setHasUserEditedInput] = React.useState(false);
    const handleChangeInputValue = React.useCallback((nextValue: string) => {
        setHasUserEditedInput(true);
        setInputValue(nextValue);
        onChangeDraftPath?.(nextValue);
    }, [onChangeDraftPath]);

    // Bug 4e fix: when the parent swaps `initialValue` (e.g. the user
    // selected a different machine and the path picker is reused with a
    // new starting value), reset the local input to mirror the new prop.
    // Comparing the previous prop identity avoids clobbering user edits
    // on every re-render — only an actual prop swap triggers the reset.
    const lastInitialInputRef = React.useRef({ initialSuggestionMode, initialValue });
    React.useEffect(() => {
        const lastInitialInput = lastInitialInputRef.current;
        if (
            lastInitialInput.initialValue === initialValue
            && lastInitialInput.initialSuggestionMode === initialSuggestionMode
        ) {
            return;
        }
        lastInitialInputRef.current = { initialSuggestionMode, initialValue };
        setHasUserEditedInput(false);
        setInputValue(resolvePathSelectionInitialInputValue({
            initialValue,
            initialSuggestionMode,
        }));
    }, [initialSuggestionMode, initialValue]);

    // R16a: stabilize values captured by the dynamic-section's `resolve`
    // closure via refs so the resolver doesn't need to be re-created when the
    // parent hands us new closure identities for `onCommit` / `machineHomeDir`
    // / `serverId` / `machinePlatform`. The dynamic-sections hook now keys
    // invalidation on the explicit `resolverKey` (see _types.ts), so the
    // resolver closure can stay stable across re-renders without flashing the
    // loading skeleton. The `machineId` swap (which IS a meaningful identity
    // change because it rebinds the underlying RPC) is signalled via the
    // explicit `resolverKey` below.
    const onCommitRef = React.useRef(onCommit);
    const machineHomeDirRef = React.useRef(machineHomeDir);
    const serverIdRef = React.useRef(serverId);
    const machinePlatformRef = React.useRef(machinePlatform);
    const machineIdRef = React.useRef(machineId);
    const isFavoriteRef = React.useRef(isFavorite);
    const onToggleFavoriteRef = React.useRef(onToggleFavorite);
    const onChangeDraftPathRef = React.useRef(onChangeDraftPath);
    React.useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
    React.useEffect(() => { machineHomeDirRef.current = machineHomeDir; }, [machineHomeDir]);
    React.useEffect(() => { serverIdRef.current = serverId; }, [serverId]);
    React.useEffect(() => { machinePlatformRef.current = machinePlatform; }, [machinePlatform]);
    React.useEffect(() => { machineIdRef.current = machineId; }, [machineId]);
    React.useEffect(() => { isFavoriteRef.current = isFavorite; }, [isFavorite]);
    React.useEffect(() => { onToggleFavoriteRef.current = onToggleFavorite; }, [onToggleFavorite]);
    React.useEffect(() => { onChangeDraftPathRef.current = onChangeDraftPath; }, [onChangeDraftPath]);

    // RUX-3: render the favorite-toggle star as the row's rightAccessory.
    // Returns `undefined` when the favorite callbacks are not supplied so the
    // row falls back to the prior "no accessory" (or the in-folder
    // drill-chevron) behavior. Translations are resolved once per render so
    // the button doesn't pay the `t(...)` cost on every press.
    const favoriteAddLabel = t('newSession.pathPicker.favoriteAdd');
    const favoriteRemoveLabel = t('newSession.pathPicker.favoriteRemove');
    const favoriteAddLabelRef = React.useRef(favoriteAddLabel);
    const favoriteRemoveLabelRef = React.useRef(favoriteRemoveLabel);
    React.useEffect(() => { favoriteAddLabelRef.current = favoriteAddLabel; }, [favoriteAddLabel]);
    React.useEffect(() => { favoriteRemoveLabelRef.current = favoriteRemoveLabel; }, [favoriteRemoveLabel]);
    const renderFavoriteAccessoryStatic: FavoriteAccessoryFactory = React.useCallback(
        (absolutePath: string, optionTestIdPrefix: string) => {
            if (!isFavorite || !onToggleFavorite) return undefined;
            return (
                <PathFavoriteToggleButton
                    testID={`${optionTestIdPrefix}:favorite-toggle`}
                    path={absolutePath}
                    isFavorite={isFavorite(absolutePath)}
                    addLabel={favoriteAddLabel}
                    removeLabel={favoriteRemoveLabel}
                    onToggle={onToggleFavorite}
                />
            );
        },
        [favoriteAddLabel, favoriteRemoveLabel, isFavorite, onToggleFavorite],
    );

    const visibleFavorites = React.useMemo(() => {
        const seenFavoriteKeys = new Set<string>();
        return favorites.filter((entry) => {
            if (!entry || typeof entry.path !== 'string' || entry.path.trim().length === 0) return false;
            const comparisonKey = resolveDirectoryFavoriteComparisonKey(entry.path, machineHomeDir);
            if (seenFavoriteKeys.has(comparisonKey)) return false;
            seenFavoriteKeys.add(comparisonKey);
            return true;
        });
    }, [favorites, machineHomeDir]);

    const visibleFavoriteKeys = React.useMemo(() => new Set(
        visibleFavorites.map((entry) => resolveDirectoryFavoriteComparisonKey(entry.path, machineHomeDir)),
    ), [machineHomeDir, visibleFavorites]);

    const visibleRecents = React.useMemo(() => {
        const seenRecentKeys = new Set<string>();
        return recents.filter((entry) => {
            if (!entry || typeof entry.path !== 'string' || entry.path.trim().length === 0) return false;
            const comparisonKey = resolveDirectoryFavoriteComparisonKey(entry.path, machineHomeDir);
            if (visibleFavoriteKeys.has(comparisonKey)) return false;
            if (seenRecentKeys.has(comparisonKey)) return false;
            seenRecentKeys.add(comparisonKey);
            return true;
        });
    }, [machineHomeDir, recents, visibleFavoriteKeys]);

    // Path-domain input behavior bound to the machine's platform (NEVER the
    // local browser's platform). When `machinePlatform === 'auto'`, the
    // adapter falls back to shape-based inference, which is correct for
    // local-machine browsing only.
    const inputBehavior = React.useMemo(
        () => createPathSelectionInputBehavior({
            targetPlatform: machinePlatform,
            initialSuggestionMode,
            inputActivated: hasUserEditedInput,
            initialValue,
            machineHomeDir,
        }),
        [hasUserEditedInput, initialSuggestionMode, initialValue, machineHomeDir, machinePlatform],
    );

    const canBrowseMachine = machineId !== null;

    const handleOpenTreeBrowser = React.useCallback(async () => {
        if (machineId === null) return;
        if (onBeforeBrowseMachinePath) {
            await onBeforeBrowseMachinePath();
        }
        const browseStart = inputValue.trim().length > 0
            ? inputValue
            : resolvePathSelectionEmptyInputPath({
                initialValue,
                initialSuggestionMode,
                machineHomeDir,
            });
        const initialPath = resolveAbsolutePath(browseStart, machineHomeDir);
        const selectedPath = await openMachinePathBrowserModal({
            machineId,
            serverId: serverId ?? null,
            initialPath,
            webPortalTarget: modalPortalTarget,
        });
        if (selectedPath !== null && selectedPath !== undefined) {
            onCommit(selectedPath);
        }
    }, [
        inputValue,
        initialSuggestionMode,
        initialValue,
        machineHomeDir,
        machineId,
        modalPortalTarget,
        onBeforeBrowseMachinePath,
        onCommit,
        serverId,
    ]);

    // R16a: a stable resolver closure that reads volatile dependencies (machine
    // id, home dir, etc.) via refs. Identity is anchored once per mount; the
    // dynamic-sections hook re-fetches when the descriptor's `resolverKey`
    // changes (machine swap → resolverKey changes → cache invalidates), but a
    // plain parent re-render does NOT cause a re-fetch.
    const inThisFolderResolver = React.useCallback(
        async (seed: string, _abortSignal: AbortSignal) => {
            const currentMachineId = machineIdRef.current;
            const currentMachineHomeDir = machineHomeDirRef.current;
            const currentServerId = serverIdRef.current;
            const currentMachinePlatform = machinePlatformRef.current;
            const currentOnCommit = onCommitRef.current;
            if (currentMachineId === null) {
                return { options: [] };
            }
            // Resolve the shorthand seed (`~/`) to an absolute path
            // before issuing the RPC, but the display value (and
            // autocompleteValue) stays in shorthand.
            const directoryPath = resolveAbsolutePath(
                seed.length > 0 ? seed : currentMachineHomeDir,
                currentMachineHomeDir,
            );
            const result = await listMachineFileBrowserDirectoryEntries({
                machineId: currentMachineId,
                serverId: currentServerId ?? null,
                directoryPath,
                includeFiles: false,
            });
            if (!result.ok) {
                // RUX-1 Issue 6: distinguish "path doesn't exist" (ENOENT /
                // ENOTDIR) from genuinely-broken transports (network, RPC,
                // permissions). The path-not-found case is the user's own
                // typo and should NOT show the raw scandir traceback —
                // surface it as a friendly hint and keep favorites/recents
                // visible (the orchestrator handles the latter when the
                // dynamic section reports notFound).
                const errorMessage = result.error ?? '';
                if (isPathNotFoundErrorMessage(errorMessage)) {
                    return { options: [], notFound: true };
                }
                // Sanitized: drop the raw OS-style traceback (which contains
                // the absolute path and looks alarming). The orchestrator
                // falls back to the i18n-keyed `selectionList.dynamicSectionError`.
                throw new Error('');
            }
            const directorySeed = seed.length > 0 ? seed : currentMachineHomeDir;
            const options: SelectionListOption[] = result.entries
                .filter((entry) => entry.type === 'directory')
                .map((entry) => {
                    // Bug 4b fix: append with `kind: 'directory'` so
                    // accepting the autocomplete yields a value with
                    // a trailing separator (e.g. `~/Documents/`),
                    // which re-fires IN THIS FOLDER for the new dir.
                    // The user-visible shorthand is preserved (the
                    // seed is in shorthand form); commit on row press
                    // resolves to the absolute path.
                    const drillValue = appendSegment(
                        directorySeed,
                        entry.name,
                        currentMachinePlatform,
                        'directory',
                    );
                    const optionTestIdPrefix = `${ROOT_TEST_ID}:path-root:option:in-folder:${entry.path}`;
                    return {
                        id: `in-folder:${entry.path}`,
                        label: entry.name,
                        subtitle: formatPathRelativeToHome(entry.path, currentMachineHomeDir),
                        labelEllipsizeMode: 'head',
                        subtitleEllipsizeMode: 'head',
                        autocompleteValue: drillValue,
                        // Bug 4c fix: row press commits the absolute
                        // path; the chevron in `rightAccessory` drills
                        // into the directory WITHOUT committing.
                        onSelect: () => currentOnCommit(entry.path),
                        rightAccessory: () => {
                            const currentIsFavorite = isFavoriteRef.current;
                            const currentOnToggleFavorite = onToggleFavoriteRef.current;
                            const favoriteAccessory = currentIsFavorite && currentOnToggleFavorite
                                ? (
                                    <PathFavoriteToggleButton
                                        testID={`${optionTestIdPrefix}:favorite-toggle`}
                                        path={entry.path}
                                        isFavorite={currentIsFavorite(entry.path)}
                                        addLabel={favoriteAddLabelRef.current}
                                        removeLabel={favoriteRemoveLabelRef.current}
                                        onToggle={currentOnToggleFavorite}
                                    />
                                )
                                : null;
                            return (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    {favoriteAccessory}
                                    <PathDrillDownButton
                                        testID={`${optionTestIdPrefix}:drill`}
                                        // FR3-11: the drill chevron only descends into the folder
                                        // by updating the input shorthand — it does NOT open the
                                        // tree-browser modal. Use a dedicated drill/descend label
                                        // so screen-reader users hear the correct action; the
                                        // tree-browser label remains on the input-suffix button.
                                        accessibilityLabel={t('newSession.pathPicker.openFolderLabel')}
                                        onPress={() => {
                                            setHasUserEditedInput(true);
                                            setInputValue(drillValue);
                                            onChangeDraftPathRef.current?.(drillValue);
                                        }}
                                    />
                                </View>
                            );
                        },
                    };
                });
            return {
                options,
                emptyHint: t('newSession.pathPicker.emptyInThisFolder'),
            };
        },
        // Empty deps — the closure is anchored at mount and reads volatile
        // state via refs. This is the whole point of R16a.
        [],
    );

    const rootStep: SelectionListStep = React.useMemo(() => {
        const sections: ReadonlyArray<SelectionListSectionDescriptor> = [
            {
                kind: 'dynamic',
                id: 'in-this-folder',
                title: t('newSession.pathPicker.inThisFolderTitle'),
                // R16a + FR4-9: explicit identity key — any change to the
                // resolver context (machineId, home dir, server scope, target
                // platform) rebinds the underlying RPC's effective output, so
                // we MUST bump `resolverKey` for ALL of those. Reusing only
                // `machine:<id>` allowed cached directory rows for one
                // (home/server/platform) combo to surface under a different
                // combo on the same machine id. The empty sentinel keeps the
                // key stable across "no machine bound" re-renders.
                resolverKey: [
                    `machine:${machineId ?? 'no-machine'}`,
                    `home:${machineHomeDir ?? ''}`,
                    `platform:${machinePlatform}`,
                    `server:${serverId ?? ''}`,
                ].join('::'),
                // Only show when the input shape suggests a path AND a machine
                // is bound. NEVER infer the target platform from the local
                // browser — always thread the machine's platform.
                visibleWhen: (input) => canBrowseMachine
                    && shouldShowPathSelectionBrowseSuggestions({
                        inputValue: input,
                        targetPlatform: machinePlatform,
                        initialSuggestionMode,
                        inputActivated: hasUserEditedInput,
                    }),
                // Auto-virtualize when the directory has many children.
                virtualization: 'auto',
                resolve: inThisFolderResolver,
                // RUX-9.2: every path row's subtitle is the absolute path
                // (parent directory always present), so tier-3 substring
                // matches against subtitle would surface every sibling for
                // any query — disable the subtitle tier for path rows.
                disableSubtitleRanking: true,
            },
            {
                kind: 'static',
                id: 'favorites',
                title: t('newSession.pathPicker.favoritesTitle'),
                options: buildFavoriteOptions(visibleFavorites, machineHomeDir, onCommit, renderFavoriteAccessoryStatic, ROOT_TEST_ID),
                // RUX-9.2: favorites carry path subtitles too — disable
                // subtitle-tier ranking for the same reason.
                disableSubtitleRanking: true,
            },
            {
                kind: 'static',
                id: 'recent',
                title: t('newSession.pathPicker.recentTitle'),
                options: buildRecentOptions(visibleRecents, machineHomeDir, onCommit, renderFavoriteAccessoryStatic, ROOT_TEST_ID),
                // RUX-9.2: same — recent rows have path subtitles.
                disableSubtitleRanking: true,
            },
        ];
        return {
            id: 'path-root',
            inputPlaceholder: t('newSession.pathPicker.enterPathPlaceholder'),
            sections,
            footerHints: [
                { id: 'navigate', label: '↑↓', description: t('newSession.pathPicker.hints.navigate') },
                { id: 'enter', label: '↵', description: t('newSession.pathPicker.hints.commit') },
                { id: 'tab', label: 'Tab', description: t('newSession.pathPicker.hints.autocomplete') },
                { id: 'backspace', label: '⌫', description: t('newSession.pathPicker.hints.walkUp') },
            ],
        };
    }, [
        canBrowseMachine,
        hasUserEditedInput,
        inThisFolderResolver,
        initialSuggestionMode,
        machineHomeDir,
        machineId,
        machinePlatform,
        onCommit,
        visibleFavorites,
        visibleRecents,
        renderFavoriteAccessoryStatic,
        // FR4-9: the dynamic section's resolverKey reads `serverId` from the
        // current render, so make memoization depend on it too.
        serverId,
    ]);

    const inputSuffix = (
        <InputBrowseButton
            testID="path-selection-list:open-tree-browser"
            accessibilityLabel={t('newSession.pathPicker.openInTreeBrowserLabel')}
            onPress={handleOpenTreeBrowser}
            disabled={!canBrowseMachine}
        />
    );

    // R13 (Fix 2): NO `inputPrefix`. The SelectionList's search-header already
    // renders a leading search-glass icon for the input row; mounting our own
    // folder-icon prefix produced a double-leading-icon. The semantic role of
    // "this is a path field" is communicated by the placeholder, the title,
    // and the suffix browse button.

    return (
        <SelectionList
            rootStep={rootStep}
            inputMode="value"
            inputBehavior={inputBehavior}
            inputSuffix={inputSuffix}
            inputValueEllipsizeMode="head"
            autoFocusInputOnWeb
            maxHeight={maxHeight}
            heightBehavior={props.heightBehavior ?? (
                maxHeight !== undefined ? 'stabilizedContentHeight' : undefined
            )}
            inputValue={inputValue}
            onChangeInputValue={handleChangeInputValue}
            // Bug 4a fix: SelectionList's row already invokes
            // `option.onSelect()` directly (see PlanOptionRow.handlePress),
            // so this top-level `onSelect` MUST be a no-op. Returning the
            // commit through both paths produced a double-commit on every
            // row press (the popover saw two onCommit calls per tap).
            onSelect={() => {}}
            // Enter on the input (no row focused): commit the resolved
            // absolute path. The display value is preserved in shorthand
            // until this commit; the committed value is always absolute.
            onCommitInputValue={(value) => {
                const commitValue = value.trim().length > 0
                    ? value
                    : resolvePathSelectionEmptyInputPath({
                        initialValue,
                        initialSuggestionMode,
                        machineHomeDir,
                    });
                onCommit(resolveAbsolutePath(commitValue, machineHomeDir));
            }}
            onRequestClose={onRequestClose}
            testID="path-selection-list"
        />
    );
}
