import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { renderPromptTemplateTextV1, type PromptInvocationEntryV1, type PromptLibraryListItem, type RenderedPromptTemplateTextV1 } from '@happier-dev/protocol';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { SelectionListSearchHeader } from '@/components/ui/selectionList/SelectionListSearchHeader';
import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { useCommandMenuKeyboard, type CommandMenuAnchor, type CommandMenuItem } from '@/components/ui/commandMenu';
import { useUserMessageHistoryEntries, type UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import { BUILT_IN_PROMPTS } from '@/sync/domains/input/slashCommands/builtInPrompts';
import { getStorage, useSetting } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { useNativeKeyboardInput } from '@/keyboard/KeyboardShortcutProvider';
import type { NormalizedKeyboardEvent } from '@/keyboard/types';
import { useShallow } from 'zustand/react/shallow';
import { AgentInputCommandMenu } from './AgentInputCommandMenu';
import { buildPromptPickerRows, type PromptPickerRow } from './promptPickerRows';
import { usePromptPickerLibrary } from './usePromptPickerLibrary';
import { resolvePromptPickerKeyAction } from './promptPickerKeyboard';
import { PromptPickerFooter, PromptPickerNotice, PromptPickerPreview, PromptPickerRowContent, PromptPickerSaveRow, PromptPickerSkeletonRow } from './PromptPickerParts';
import type { SaveMessageAsPromptSaved } from '@/components/sessions/transcript/messageActions/useSaveMessageAsPrompt';

/** The library half of the picker, as the open leaf's data owner publishes it. */
export type PromptPickerLibrarySnapshot = Readonly<{
    documents: readonly PromptLibraryListItem[];
    invocations: readonly PromptInvocationEntryV1[];
    coverage: 'complete' | 'partial' | 'unavailable';
    isLoading: boolean;
    error: boolean;
    read: (artifactId: string) => Promise<string>;
    setFavorite: (artifactId: string, favorite: boolean) => Promise<void>;
    /** Adds a prompt this picker just created (Save in place) without re-listing the library. */
    adopt: (item: PromptLibraryListItem) => void;
    retry: () => void;
}>;

export type AgentInputPromptPickerProps = Readonly<{
    anchor: CommandMenuAnchor;
    serverId: string;
    sessionId: string | null;
    onRequestClose: () => void;
    onApply: (expand: () => Promise<RenderedPromptTemplateTextV1>, mode: 'insert' | 'send') => Promise<boolean>;
    canSend: boolean;
}>;

/** The lab's picker heights: with the preview pane, and the single list (`fprompts` R1 / ST). */
const PICKER_HEIGHT_WITH_PREVIEW = 430;
const PICKER_HEIGHT = 380;
const EMPTY_FOLDERS: ReadonlyMap<string, string> = new Map();

/** This data-active leaf is mounted by the composer controller only while open. */
export function AgentInputPromptPicker(props: AgentInputPromptPickerProps) {
    const library = usePromptPickerLibrary(props.serverId);
    const history = useUserMessageHistoryEntries({ scope: 'global', enabled: true, serverId: props.serverId });
    const folders = useSetting('promptFoldersV1');
    const folderNames = React.useMemo(() => folders.folders?.length
        ? new Map(folders.folders.map((folder) => [folder.id, folder.name]))
        : EMPTY_FOLDERS, [folders]);
    const sessionNames = usePromptPickerSessionNames(history.entries);
    return <PromptPickerView {...props} library={library} history={history} folderNames={folderNames} sessionNames={sessionNames} />;
}

/** Names of the sessions the loaded history came from, read only while the picker is open. */
function usePromptPickerSessionNames(entries: UserMessageHistoryEntriesSnapshot['entries']): ReadonlyMap<string, string> {
    const ids = React.useMemo(() => [...new Set(entries.map((entry) => entry.sessionId))], [entries]);
    const names = getStorage()(useShallow((state) => ids.map((id) => {
        const session = state.sessions[id];
        return session ? getSessionName(session, session.serverId) : '';
    })));
    return React.useMemo(() => new Map(ids.map((id, index) => [id, names[index] ?? ''])), [ids, names]);
}

export type PromptPickerViewProps = AgentInputPromptPickerProps & Readonly<{
    library: PromptPickerLibrarySnapshot;
    history: UserMessageHistoryEntriesSnapshot;
    folderNames: ReadonlyMap<string, string>;
    sessionNames: ReadonlyMap<string, string>;
    /** Fixed clock for specimens; the live picker reads the time it opened. */
    nowMs?: number;
    /** Specimens show the hints a hardware keyboard would see. */
    hardwareKeyboard?: boolean;
    /** Specimens open on a typed query. */
    initialQuery?: string;
}>;

/** One searchable list over favourites, the library and what you sent (lab fprompts R1). */
export function PromptPickerView(props: PromptPickerViewProps) {
    const { library, history } = props;
    const [query, setQuery] = React.useState(props.initialQuery ?? '');
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [applyError, setApplyError] = React.useState(false);
    const [inputFocused, setInputFocused] = React.useState(false);
    const [openedAtMs] = React.useState(() => props.nowMs ?? Date.now());
    const detectedKeyboard = useHardwareKeyboard();
    const hardwareKeyboard = props.hardwareKeyboard ?? detectedKeyboard;
    const { width } = useWindowDimensions();
    const builtRows = React.useMemo(() => buildPromptPickerRows({ documents: library.documents, invocations: library.invocations,
        builtIns: BUILT_IN_PROMPTS, history: history.entries, sessionId: props.sessionId, query }),
    [library.documents, library.invocations, history.entries, props.sessionId, query]);
    // Save in place (lab R1s): a starred Sent before row rises into Favourites as a name field; once
    // saved it is a library prompt, so for the rest of this open it no longer repeats under Sent before.
    const [saving, setSaving] = React.useState<Extract<PromptPickerRow, { kind: 'history' }> | null>(null);
    const [moved, setMoved] = React.useState<ReadonlySet<string>>(() => new Set());
    // Rows may keep an earlier render's handlers; they read whether a save is open from here.
    const savingRef = React.useRef(saving);
    savingRef.current = saving;
    const rows = React.useMemo(() => {
        const remaining = builtRows.filter((row) => !moved.has(row.id) && row.id !== saving?.id);
        if (!saving) return remaining;
        const afterFavorites = remaining.findIndex((row) => row.group !== 'favorites');
        const at = afterFavorites < 0 ? remaining.length : afterFavorites;
        return [...remaining.slice(0, at), { ...saving, group: 'favorites' as const }, ...remaining.slice(at)];
    }, [builtRows, moved, saving]);
    const searchInput = React.useRef<{ focus?: () => void } | null>(null);
    // Stable, so the field takes focus once on open and never again on a later render.
    const searchInputRef = React.useCallback((node: { focus?: () => void } | null) => { searchInput.current = node; focusOnMount(node); }, []);
    const startSave = React.useCallback((row: PromptPickerRow) => {
        if (row.kind !== 'history') return;
        setSaving(row);
        setSelectedId(row.id);
    }, []);
    const cancelSave = React.useCallback(() => {
        setSaving(null);
        searchInput.current?.focus?.();
    }, []);
    const { adopt } = library;
    const finishSave = React.useCallback((saved: SaveMessageAsPromptSaved) => {
        const historyRowId = saving?.id;
        adopt({ artifactId: saved.artifactId, title: saved.title, folderId: null, tags: [], favorite: saved.favorite, updatedAtMs: Date.now() });
        if (historyRowId) setMoved((previous) => new Set(previous).add(historyRowId));
        setSaving(null);
        setSelectedId(`doc:${saved.artifactId}`);
        searchInput.current?.focus?.();
    }, [adopt, saving?.id]);
    const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === selectedId));
    const selected = rows[selectedIndex];
    const move = (direction: number) => {
        if (rows.length) setSelectedId(rows[(selectedIndex + direction + rows.length) % rows.length]!.id);
    };
    const readRow = React.useCallback(async (row: PromptPickerRow): Promise<string> => {
        if (row.kind === 'doc') return library.read(row.document.artifactId);
        return row.kind === 'builtIn' ? row.prompt.body : row.entry.text;
    }, [library.read]);
    const apply = React.useCallback(async (row: PromptPickerRow | undefined, mode: 'insert' | 'send') => {
        // The row being named is a form, not a prompt to insert.
        if (!row || row.id === saving?.id || (mode === 'send' && !props.canSend)) return;
        setApplyError(false);
        try {
            const accepted = await props.onApply(async () => {
                const markdown = await readRow(row);
                return row.kind === 'history' ? { text: markdown }
                    : renderPromptTemplateTextV1({ templateMarkdown: markdown, argsText: '' });
            }, mode);
            if (!accepted) setApplyError(true);
        } catch { setApplyError(true); }
    }, [props.onApply, props.canSend, readRow, saving?.id]);
    const toggleFavorite = React.useCallback(async (row: PromptPickerRow | undefined) => {
        if (row?.kind === 'history') { startSave(row); return; }
        if (row?.kind !== 'doc') return;
        try { await library.setFavorite(row.document.artifactId, !row.document.favorite); } catch { setApplyError(true); }
    }, [library.setFavorite, startSave]);
    const keyboard = useCommandMenuKeyboard({ open: true, onMoveUp: () => move(-1), onMoveDown: () => move(1),
        onSelect: () => { void apply(selected, 'insert'); }, onClose: props.onRequestClose });
    const handleKey = (event: NormalizedKeyboardEvent): boolean => {
        if (event.isComposing) return false;
        const action = resolvePromptPickerKeyAction(event, resolveKeyboardPlatform());
        if (action) {
            if (action === 'favorite') void toggleFavorite(selected);
            else void apply(selected, action);
            return true;
        }
        if (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && event.key !== 'Tab')) return false;
        return keyboard.handleKey(event);
    };
    useNativeKeyboardInput(inputFocused ? {
        bindings: ['Enter', 'Mod+Enter', 'Mod+D', 'ArrowUp', 'ArrowDown', 'Escape'], handleKey,
    } : null);
    const onKeyPress: React.ComponentProps<typeof SelectionListSearchHeader>['onKeyPress'] = (event) => {
        // Web's DOM bridge carries modifiers. Native physical keys belong exclusively
        // to the provider bridge; its consumed Return must not also insert via TextInput.
        if (Platform.OS !== 'web') return;
        const keyEvent: PickerKeyEvent = { ...(event.nativeEvent as PickerKeyEvent | undefined), ...('key' in event ? event as PickerKeyEvent : {}) };
        if (!keyEvent.key) return;
        if (handleKey({ key: keyEvent.key, code: keyEvent.code ?? '',
            metaKey: keyEvent.metaKey === true, ctrlKey: keyEvent.ctrlKey === true, shiftKey: keyEvent.shiftKey === true,
            altKey: keyEvent.altKey === true, repeat: keyEvent.repeat === true, isComposing: keyEvent.isComposing === true })) {
            event.preventDefault?.();
            event.stopPropagation?.();
        }
    };
    const groups = React.useMemo(() => ({
        favorites: t('agentInput.promptPicker.favorites'),
        library: t('agentInput.promptPicker.library'),
        history: t('agentInput.promptPicker.sentBefore'),
    }), []);
    const items: readonly CommandMenuItem[] = React.useMemo(() => rows.map((row) => ({ id: row.id, label: row.title,
        group: groups[row.group], renderRow: () => row.kind === 'history' && row.id === saving?.id
            ? <PromptPickerSaveRow row={row} serverId={props.serverId} nowMs={openedAtMs} onSaved={finishSave} onCancel={cancelSave} />
            : <PromptPickerRowContent row={row} query={query} nowMs={openedAtMs}
                folderNames={props.folderNames} sessionNames={props.sessionNames}
                // While a row is being named, the pointer resting where it rose from never takes the selection.
                onHighlight={() => { if (!savingRef.current) setSelectedId(row.id); }} onToggleFavorite={() => { void toggleFavorite(row); }} /> })),
    [rows, groups, query, openedAtMs, props.folderNames, props.sessionNames, props.serverId, toggleFavorite, saving?.id, finishSave, cancelSave]);
    const libraryUnavailable = library.error || (!library.isLoading && library.coverage === 'unavailable');
    const hasFavorites = rows.some((row) => row.group === 'favorites');
    const wide = width >= 760;
    return <AgentInputCommandMenu
        open anchor={props.anchor} query={query} items={items} selectedIndex={selected ? selectedIndex : -1}
        onMoveUp={() => move(-1)} onMoveDown={() => move(1)} onSelect={(_, index) => { void apply(rows[index], 'insert'); }}
        onRequestClose={props.onRequestClose} preserveHostFocus={false} maxWidth={width} placement="top"
        matchAnchorWidth fillHeight maxHeight={wide ? PICKER_HEIGHT_WITH_PREVIEW : PICKER_HEIGHT}
        testID="agent-input-prompt-picker"
        emptyState={library.isLoading && !rows.length ? <PromptPickerSkeletonRow testID="prompt-picker-loading" />
            : <PromptPickerNotice testID="prompt-picker-empty" text={query
                ? t('agentInput.promptPicker.noMatchesFor', { query: query.trim() })
                : t('agentInput.promptPicker.empty')} action={query ? { label: t('agentInput.promptPicker.clear'), onPress: () => setQuery('') } : undefined} />}
        header={<View>
            <SelectionListSearchHeader value={query} onChangeText={(value) => { setQuery(value); setSelectedId(null); }}
                placeholder={t('agentInput.promptPicker.placeholder')} canPop={false} onKeyPress={onKeyPress}
                onSubmitEditing={() => { void apply(selected, 'insert'); }}
                onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)}
                testID="prompt-picker-header" inputTestID="prompt-picker-search" inputRef={searchInputRef}
                rightAdornment={hardwareKeyboard ? <KeyHint label="esc" />
                    : <IconButton iconName="x" accessibilityLabel={t('common.close')} variant="plain" onPress={props.onRequestClose} testID="prompt-picker-close" />}
                style={styles.header} />
            {libraryUnavailable ? <PromptPickerNotice testID="prompt-picker-library-error" tone="error" text={t('agentInput.promptPicker.libraryError')}
                action={{ label: t('common.retry'), onPress: library.retry }} />
                : library.coverage === 'partial' && !library.isLoading ? <PromptPickerNotice text={t('agentInput.promptPicker.partialLibrary')} />
                : !query && !library.isLoading && !hasFavorites && rows.length > 0 ? <PromptPickerNotice testID="prompt-picker-invite"
                    title={groups.favorites} text={t('agentInput.promptPicker.favoritesInvite')} /> : null}
        </View>}
        preview={wide && selected ? <PromptPickerPreview row={selected} read={readRow} nowMs={openedAtMs}
            folderNames={props.folderNames} sessionNames={props.sessionNames} /> : null}
        footer={<PromptPickerFooter history={history} hardwareKeyboard={hardwareKeyboard}
            canSend={props.canSend} applyError={applyError} />}
    />;
}

type PickerKeyEvent = Readonly<{
    key?: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; repeat?: boolean; isComposing?: boolean;
}>;

/** The field takes focus once, when the picker opens; later renders never steal it back. */
function focusOnMount(node: { focus?: () => void } | null) {
    if (node) setTimeout(() => node.focus?.(), 0);
}

const styles = StyleSheet.create((theme) => ({
    header: {
        minHeight: 44,
        backgroundColor: 'transparent',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
}));
