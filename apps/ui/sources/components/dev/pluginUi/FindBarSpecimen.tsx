import { matchFindText, type FindOptions, type FindStatus } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FindBar, type FindBarProps } from '@/components/ui/find/FindBar';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { Message } from '@happier-dev/session-core/messages';
import { createTranscriptFindModel } from '@/components/sessions/transcript/find/useTranscriptFind';
import { TranscriptFindRuler } from '@/components/sessions/transcript/find/TranscriptFindRuler';

/**
 * Dev specimen of the shared Find bar in every state of the Find lab (`.happier/design-lab/find/`,
 * concepts `fx` and `ffind`: F1, F1t, F1d, F1tp and the ST board), for side-by-side review against the
 * lab frames. The bar is the real core binding; the surrounding text only shows the Find colour pair.
 */

const OPTIONS_OFF: FindOptions = { matchCase: false, regex: false };
const CAPS = { regex: true, stop: true } as const;
const noop = () => {};

type StaticBar = Readonly<{
    query: string;
    status: FindStatus;
    surfaceLabel: string;
    options?: FindOptions;
    capabilities?: FindBarProps['capabilities'];
    note?: FindBarProps['note'];
}>;

function StaticFindBar(props: StaticBar & Readonly<{ presentation?: FindBarProps['presentation']; testID?: string; style?: FindBarProps['style'] }>) {
    return (
        <FindBar
            query={props.query}
            options={props.options ?? OPTIONS_OFF}
            status={props.status}
            capabilities={props.capabilities ?? CAPS}
            note={props.note}
            surfaceLabel={props.surfaceLabel}
            presentation={props.presentation ?? 'inline'}
            autoFocus={false}
            onQueryChange={noop}
            onOptionsChange={noop}
            onStep={noop}
            onStop={noop}
            onClose={noop}
            testID={props.testID}
            style={props.style}
        />
    );
}

/** A line of sample text with every occurrence of `word` marked and the `current`-th one solid (the real mark owner). */
function MarkedLine(props: Readonly<{ text: string; word: string; current?: number; mono?: boolean }>) {
    const ranges = React.useMemo(() => {
        const found = matchFindText(props.text, props.word, OPTIONS_OFF);
        return 'ranges' in found ? found.ranges.map(([start, end], index) => ({ start, end, current: index === props.current })) : [];
    }, [props.current, props.text, props.word]);
    return (
        <Text style={[styles.line, props.mono ? [styles.mono, Typography.mono()] : null]}>
            <FindHighlightedText text={props.text} ranges={ranges} />
        </Text>
    );
}

function Cell(props: Readonly<{ title: string; description: string; height: number; children: React.ReactNode; testID: string }>) {
    return (
        <View style={styles.cell}>
            <Text style={styles.cellTitle}>{props.title}</Text>
            <Text style={styles.cellDescription}>{props.description}</Text>
            <View style={[styles.panel, { height: props.height }]} testID={props.testID}>{props.children}</View>
        </View>
    );
}

const CHAT_LINES = [
    'The settings modal flickers when the window resizes, and the draft disappears. Find out why it remounts and fix it.',
    'It remounts because SettingsModal’s key includes the window width, so every resize throws its state away.',
    'expected 1 mount, received 3 (remount on width change)',
];

function ChatSample(props: Readonly<{ current?: number; plain?: boolean }>) {
    return (
        <View style={styles.sampleBody}>
            {CHAT_LINES.map((line, i) => (
                props.plain
                    ? <Text key={i} style={[styles.line, i === 2 ? [styles.mono, Typography.mono()] : null]}>{line}</Text>
                    : <MarkedLine key={i} text={line} word="remount" mono={i === 2} current={props.current === undefined ? undefined : props.current - i} />
            ))}
        </View>
    );
}

/** The interactive bar: type, step and toggle; the count is a fixed seven-match fixture. */
function InteractiveChatFind() {
    const [query, setQuery] = React.useState('remount');
    const [options, setOptions] = React.useState<FindOptions>(OPTIONS_OFF);
    const [current, setCurrent] = React.useState(5);
    const [open, setOpen] = React.useState(true);
    const total = 7;
    const status: FindStatus = query.length === 0 ? { kind: 'idle' } : { kind: 'results', current, total, coverage: 'complete' };
    const onStep = React.useCallback((direction: 1 | -1) => {
        setCurrent((value) => ((value - 1 + direction + total) % total) + 1);
    }, []);
    return (
        <>
            <ChatSample current={current - 5 >= 0 ? current - 5 : undefined} />
            {open ? (
                <FindBar
                    query={query}
                    options={options}
                    status={status}
                    capabilities={CAPS}
                    surfaceLabel={t('find.surface.chat')}
                    presentation="inline"
                    autoFocus={false}
                    onQueryChange={setQuery}
                    onOptionsChange={setOptions}
                    onStep={onStep}
                    onStop={noop}
                    onClose={() => setOpen(false)}
                    testID="dev-find-interactive"
                    style={styles.floating}
                />
            ) : (
                <Text style={[styles.cellDescription, styles.reopen]} onPress={() => setOpen(true)}>Closed — tap to reopen</Text>
            )}
        </>
    );
}

/** Seven matches spread through a long chat (lab F1 ticks at 14 · 21 · 36 · 42 · 57 %, the current third). */
const RULER_MESSAGES: readonly Message[] = [14, 21, 36, 42, 57].map((percent, index): Message => ({
    kind: 'user-text', id: `ruler-${percent}`, localId: null, createdAt: index, seq: index + 1,
    text: index === 2 ? 'why it remounts' : 'remount',
}));
const RULER_CONTENT_HEIGHT = 1000;
const measureRulerMessage = (messageId: string) => {
    const percent = Number(messageId.slice('ruler-'.length));
    return Number.isFinite(percent) ? { y: (percent / 100) * RULER_CONTENT_HEIGHT, height: 40 } : null;
};

/** The real chat Find model and overview ruler over a fixture transcript whose rows are not mounted. */
function RulerChatFind() {
    const [model] = React.useState(() => createTranscriptFindModel({
        readCorpus: () => ({ messages: RULER_MESSAGES, history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } }),
        loadPage: null, jumpToTarget: async () => ({ status: 'not-found', reason: 'unsupported' }), reveal: async () => {},
    }));
    const snapshot = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
    React.useEffect(() => { model.setQuery('remount'); model.step(1); model.step(1); }, [model]);
    return (
        <>
            <ChatSample current={0} />
            <FindBar query={snapshot.query} options={snapshot.options} status={snapshot.status} capabilities={model.capabilities}
                surfaceLabel={t('find.surface.chat')} presentation="inline" autoFocus={false}
                onQueryChange={model.setQuery} onOptionsChange={model.setOptions} onStep={model.step} onStop={model.stop} onClose={noop}
                testID="dev-find-ruler-bar" style={styles.floating} />
            <TranscriptFindRuler model={model} measureMessage={measureRulerMessage} contentHeight={RULER_CONTENT_HEIGHT} olderRemaining />
        </>
    );
}

export function FindBarSpecimen() {
    const terminal = t('find.surface.terminal', { name: 'zsh' });
    return (
        <View style={styles.board} testID="dev-plugin-ui-find">
            <Cell testID="dev-find-f1" title="F1 · Chat (interactive)" description="⌘F in the chat: field · count · ↑ ↓ · Aa · .* · ×. ↵ / ⇧↵ step, Esc closes." height={210}>
                <InteractiveChatFind />
            </Cell>
            <Cell testID="dev-find-ruler" title="F1 · Overview ruler" description="Where the matches are, on the scroll edge: the current one solid, a dotted cap while older messages are unsearched. Step with ↑ ↓." height={320}>
                <RulerChatFind />
            </Cell>
            <Cell testID="dev-find-f1d" title="F1d · Review" description="Every file of the change set: “3 of 8 · 3 files”." height={120}>
                <ChatSample plain />
                <StaticFindBar query="width" surfaceLabel={t('find.surface.changes')} status={{ kind: 'results', current: 3, total: 8, files: 3, coverage: 'complete' }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-f1t" title="F1t · Terminal" description="The same bar, in the terminal pane." height={120}>
                <ChatSample plain />
                <StaticFindBar query="SettingsModal" surfaceLabel={terminal} status={{ kind: 'results', current: 3, total: 3, coverage: 'complete' }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-searching" title="Searching older messages" description="Loaded rows match at once; older pages load with progress and Stop." height={170}>
                <ChatSample />
                <StaticFindBar query="remount" surfaceLabel={t('find.surface.chat')} status={{ kind: 'searching', current: 2, total: 4 }} note={{ icon: 'history', text: t('find.note.searchingOlder') }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-none" title="No matches" description="Red count, arrows off, the query stays." height={120}>
                <ChatSample plain />
                <StaticFindBar query="remounted twice" surfaceLabel={t('find.surface.chat')} status={{ kind: 'results', current: null, total: 0, coverage: 'complete' }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-invalid" title="Invalid pattern" description="With .* on, a broken expression says so in the count slot." height={120}>
                <ChatSample plain />
                <StaticFindBar query="remount(" options={{ matchCase: false, regex: true }} surfaceLabel={t('find.surface.chat')} status={{ kind: 'invalidPattern' }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-limited" title="Terminal: only what it keeps" description="Find reads the scrollback the renderer still holds." height={150}>
                <ChatSample plain />
                <StaticFindBar query="error TS" surfaceLabel={terminal} capabilities={{ regex: true, stop: false }} status={{ kind: 'results', current: 2, total: 2, coverage: 'limited' }} note={{ icon: 'info', text: t('find.note.terminalKept', { lines: '5,000' }) }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-offline" title="Offline: older messages wait" description="Loaded messages still match; older ones need the connection." height={150}>
                <ChatSample current={2} />
                <StaticFindBar query="remount" surfaceLabel={t('find.surface.chat')} status={{ kind: 'results', current: 3, total: 5, coverage: 'loaded' }} note={{ icon: 'offline', text: t('find.note.offlineOlder') }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-loaded-none" title="Nothing in what was searched" description="Never “No matches” for a partial scope." height={150}>
                <ChatSample plain />
                <StaticFindBar query="rollback" surfaceLabel={t('find.surface.chat')} status={{ kind: 'results', current: null, total: 0, coverage: 'loaded' }} note={{ icon: 'offline', text: t('find.note.offlineOlder') }} style={styles.floating} />
            </Cell>
            <Cell testID="dev-find-narrow" title="Narrow pane" description="A split terminal leaf or slim review pane: the compact capsule keeps every control." height={120}>
                <View style={styles.narrow}>
                    <ChatSample plain />
                    <StaticFindBar query="SettingsModal" surfaceLabel={terminal} status={{ kind: 'results', current: 12, total: 148, coverage: 'complete' }} style={styles.floating} />
                </View>
            </Cell>
            <Cell testID="dev-find-f1p" title="F1p · Phone chat" description="The bar sits above the keyboard: ↑ ↓, the field with its count, Done." height={190}>
                <ChatSample current={2} />
                <StaticFindBar presentation="keyboardSeated" query="remount" surfaceLabel={t('find.surface.chat')} status={{ kind: 'results', current: 5, total: 7, coverage: 'complete' }} style={styles.seated} />
            </Cell>
            <Cell testID="dev-find-f1tp" title="F1tp · Phone terminal" description="Takes the key rail’s place while finding; Done brings it back." height={190}>
                <ChatSample plain />
                <StaticFindBar presentation="keyboardSeated" query="SettingsModal" surfaceLabel={terminal} status={{ kind: 'results', current: 2, total: 3, coverage: 'complete' }} style={styles.seated} />
            </Cell>
            <Cell testID="dev-find-phone-none" title="Phone · no matches" description="The seated count turns red; arrows off." height={190}>
                <ChatSample plain />
                <StaticFindBar presentation="keyboardSeated" query="remounted twice" surfaceLabel={t('find.surface.chat')} status={{ kind: 'results', current: null, total: 0, coverage: 'complete' }} style={styles.seated} />
            </Cell>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    board: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 22,
    },
    cell: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 420,
        minWidth: 0,
        maxWidth: 680,
        gap: 4,
    },
    cellTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    cellDescription: {
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
        marginBottom: 6,
    },
    panel: {
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    sampleBody: {
        paddingTop: 62,
        paddingHorizontal: 18,
        gap: 10,
    },
    line: {
        fontSize: 14,
        lineHeight: 22,
        color: theme.colors.text.primary,
    },
    mono: {
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    // The surface spans the bar across its width; the capsule sits at the right and shrinks its field
    // when the pane is narrow (Find lab `.fd-bar`: 10 from the top, 14 from the edge).
    floating: {
        position: 'absolute',
        top: 10,
        left: 14,
        right: 14,
    },
    seated: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    narrow: {
        width: 296,
        height: '100%',
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
    },
    reopen: {
        position: 'absolute',
        top: 16,
        right: 18,
    },
}));
