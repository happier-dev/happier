import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PromptInvocationEntryV1Schema, type PromptLibraryListItem } from '@happier-dev/protocol';

import { PromptPickerView, type PromptPickerLibrarySnapshot } from '@/components/sessions/agentInput/commandMenu/AgentInputPromptPicker';
import { AgentInputFieldAccessories } from '@/components/sessions/agentInput/components/AgentInputFieldAccessories';
import { AgentInputDictationButton } from '@/components/sessions/agentInput/components/AgentInputDictationButton';
import { AgentInputExpansionToggle } from '@/components/sessions/agentInput/components/AgentInputExpansionToggle';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import type { Message } from '@happier-dev/session-core/messages';
import { MessageView } from '@/components/sessions/transcript/MessageView';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { SaveMessagePromptForm } from '@/components/sessions/transcript/messageActions/SaveMessageAsPrompt';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useDemoMessages } from '@/hooks/session/useDemoMessages';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev specimen of the composer prompt picker and its library button in the states of the Find lab
 * (`.happier/design-lab/find/`, concept `fprompts`: R1 and the ST board), for side-by-side review. The
 * picker and accessories are the real components; only their data is fixture data with inert callbacks.
 */

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const MINUTE = 60_000;
const noop = () => {};
const E2E_BODY = 'Run the settings end-to-end tests:\nyarn test:e2e --filter $ARGUMENTS\n\nFor every failure, find the cause, fix it, and run the suite again until it passes. Don’t change the tests unless they are wrong; say so if they are.';

const DOCUMENTS: readonly PromptLibraryListItem[] = [
    { artifactId: 'e2e', title: 'Run the settings e2e tests and fix what fails', folderId: null, tags: [], favorite: true, updatedAtMs: NOW - 3 * 24 * 60 * MINUTE },
    { artifactId: 'review', title: 'Review this change like a senior engineer', folderId: null, tags: [], favorite: true, updatedAtMs: NOW - 9 * 24 * 60 * MINUTE },
    { artifactId: 'tdd', title: 'Write a failing test first, then the fix', folderId: 'testing', tags: [], favorite: false, updatedAtMs: NOW - 20 * 24 * 60 * MINUTE },
    { artifactId: 'flaky', title: 'Explain why this test is flaky', folderId: 'debugging', tags: [], favorite: false, updatedAtMs: NOW - 30 * 24 * 60 * MINUTE },
];
const INVOCATIONS = [PromptInvocationEntryV1Schema.parse({ id: 'inv-e2e', token: '/e2e', title: 'e2e', target: { kind: 'doc', artifactId: 'e2e' }, behavior: 'insert', allowArgs: true, availableIn: 'global' })];
const FOLDERS: ReadonlyMap<string, string> = new Map([['testing', 'Testing'], ['debugging', 'Debugging']]);
const SESSIONS: ReadonlyMap<string, string> = new Map([['s1', 'Fix settings modal remount'], ['s2', 'Review #2481'], ['s3', 'Craft pass lab']]);
const HISTORY_ENTRIES: UserMessageHistoryEntriesSnapshot['entries'] = [
    { serverId: 'dev', sessionId: 's1', messageId: 'm1', seq: 9, createdAtMs: NOW - 12 * MINUTE, text: 'Now make sure the end-to-end tests still pass.' },
    { serverId: 'dev', sessionId: 's2', messageId: 'm2', seq: 4, createdAtMs: NOW - 2 * 24 * 60 * MINUTE, text: 'Run yarn test settings --watch and tell me when it’s green' },
    { serverId: 'dev', sessionId: 's3', messageId: 'm3', seq: 2, createdAtMs: NOW - 3 * 24 * 60 * MINUTE, text: 'Add a test that counts mounts across a resize' },
];

function library(documents: readonly PromptLibraryListItem[], extra?: Partial<PromptPickerLibrarySnapshot>): PromptPickerLibrarySnapshot {
    return {
        documents, invocations: INVOCATIONS, coverage: 'complete', isLoading: false, error: false,
        read: async (id) => id === 'e2e' ? E2E_BODY : documents.find((doc) => doc.artifactId === id)?.title ?? '',
        setFavorite: async () => {}, adopt: noop, retry: noop, ...extra,
    };
}

function history(extra?: Partial<UserMessageHistoryEntriesSnapshot>): UserMessageHistoryEntriesSnapshot {
    return {
        entries: HISTORY_ENTRIES, coverage: 'partial', hasMore: true, isLoading: false, error: false,
        progress: { pagesLoaded: 1, sessionsSearched: 3, totalSessions: 14 },
        loadMore: async () => {}, retry: async () => {}, stop: noop, ...extra,
    };
}

export type PromptsSpecimenState = 'picker' | 'nothingSaved' | 'noMatches' | 'olderLoading' | 'composer' | 'message' | 'save' | 'saveInPlace';

/** One state per page so each screenshot frames exactly one open picker above its composer. */
export function PromptsSpecimen(props: Readonly<{ state: PromptsSpecimenState; query?: string; touch?: boolean }>) {
    const anchorRef = React.useRef<View>(null);
    if (props.state === 'composer') return <ComposerAccessoriesSpecimen />;
    if (props.state === 'message') return <CommittedMessageSpecimen />;
    if (props.state === 'save') return <SaveFormSpecimen />;
    const pickerLibrary = props.state === 'nothingSaved' ? library([]) : library(DOCUMENTS);
    const pickerHistory = props.state === 'olderLoading'
        ? history({ entries: HISTORY_ENTRIES.slice(0, 1), isLoading: true, progress: { pagesLoaded: 2, sessionsSearched: 5, totalSessions: 14 } })
        : history();
    return (
        <View style={styles.stage}>
            <View ref={anchorRef} collapsable={false} style={styles.composer} testID="prompts-specimen-composer">
                <Text style={styles.placeholder}>Message this session…</Text>
            </View>
            <PromptPickerViewWithQuery
                key={props.state}
                initialQuery={props.query ?? (props.state === 'noMatches' ? 'kubernetes' : props.state === 'picker' || props.state === 'olderLoading' ? 'test' : '')}
                anchorRef={anchorRef} library={pickerLibrary} history={pickerHistory} hardwareKeyboard={!props.touch}
            />
        </View>
    );
}

function PromptPickerViewWithQuery(props: Readonly<{
    initialQuery: string;
    anchorRef: React.RefObject<View | null>;
    library: PromptPickerLibrarySnapshot;
    history: UserMessageHistoryEntriesSnapshot;
    hardwareKeyboard: boolean;
}>) {
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => setMounted(true), []);
    if (!mounted) return null;
    return <PromptPickerView
        anchor={{ kind: 'view', ref: props.anchorRef }} serverId="dev" sessionId="s1" canSend
        onRequestClose={noop} onApply={async () => true}
        library={props.library} history={props.history} folderNames={FOLDERS} sessionNames={SESSIONS}
        nowMs={NOW} hardwareKeyboard={props.hardwareKeyboard} initialQuery={props.initialQuery}
    />;
}

/** The composer's top-right corner: library button beside dictation, voice off, and under the expand toggle. */
function ComposerAccessoriesSpecimen() {
    const cells: ReadonlyArray<Readonly<{ label: string; dictation: boolean; toggle: boolean }>> = [
        { label: 'Voice on: library, then dictation', dictation: true, toggle: false },
        { label: 'Voice off: library only', dictation: false, toggle: false },
        { label: 'Tall draft: below the expand toggle', dictation: true, toggle: true },
    ];
    return (
        <View style={styles.cells}>
            {cells.map((cell) => (
                <View key={cell.label} style={styles.cell} testID={`prompts-specimen-accessories:${cell.dictation ? 'voice' : 'novoice'}${cell.toggle ? ':toggle' : ''}`}>
                    <Text style={styles.cellLabel}>{cell.label}</Text>
                    <View style={[styles.composer, styles.composerStatic]}>
                        <Text style={styles.placeholder}>Message this session…</Text>
                        {cell.toggle ? <AgentInputExpansionToggle expanded={false} onToggle={noop} /> : null}
                        <AgentInputFieldAccessories showLibrary onOpenLibrary={noop} belowToggle={cell.toggle}
                            accessory={cell.dictation ? <AgentInputDictationButton status="idle" onPress={noop} /> : undefined} />
                    </View>
                </View>
            ))}
        </View>
    );
}

const MESSAGES: Message[] = [
    { id: 'u-e2e', localId: null, createdAt: NOW - 12 * MINUTE, kind: 'user-text', text: 'Now make sure the end-to-end tests still pass.' },
    { id: 'a-e2e', localId: null, createdAt: NOW - 11 * MINUTE, kind: 'agent-text', text: 'All 12 settings end-to-end tests pass.' },
];

/** A sent message and its committed action row (real `MessageView`, read-only transcript source). */
function CommittedMessageSpecimen() {
    const source = useDemoMessages(MESSAGES);
    const byId = source.useMessagesById();
    return (
        <SessionTranscriptSourceProvider source={source}>
            <View style={styles.transcript} testID="prompts-specimen-message">
                {MESSAGES.map((message) => (
                    <MessageView key={message.id} message={message} metadata={null} sessionId={source.sessionId}
                        getMessageById={(id: string) => byId[id] ?? null} />
                ))}
            </View>
        </SessionTranscriptSourceProvider>
    );
}

/** The Save as prompt form as its popover draws it (R1s): name, favourite, collapsed shortcut. */
function SaveFormSpecimen() {
    return (
        <View style={styles.cells}>
            <View style={styles.saveFrame} testID="prompts-specimen-save">
                <FloatingOverlay surfaceChrome="theme" maxHeight={400}>
                    <View style={styles.saveBody}>
                        <SaveMessagePromptForm messageId="u-e2e" text={'Check the e2e suite still passes\n\nRun yarn test:e2e and fix what fails.'}
                            onClose={noop} onSaved={noop} />
                    </View>
                </FloatingOverlay>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    transcript: { flex: 1, paddingVertical: 24, maxWidth: 860, width: '100%', alignSelf: 'center' },
    saveFrame: { width: 340 },
    saveBody: { width: 340 },
    stage: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 24, paddingBottom: 32, minHeight: 640 },
    composer: {
        alignSelf: 'center', width: '100%', maxWidth: 820, minHeight: 104, borderRadius: 22,
        paddingHorizontal: 18, paddingVertical: 14,
        backgroundColor: theme.colors.surface.base, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.default,
    },
    composerStatic: { position: 'relative' },
    placeholder: { ...Typography.default(), fontSize: 15, color: theme.colors.text.placeholder },
    cells: { padding: 28, gap: 28 },
    cell: { gap: 10, maxWidth: 820 },
    cellLabel: { ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text.secondary },
}));
