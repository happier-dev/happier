import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { WidgetFrameAppearanceSection } from '@/components/settings/appearance/WidgetFrameAppearanceSection';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SessionWidgetHost, type SessionWidgetDensity } from '@/components/sessions/board/SessionWidgetHost';
import { SessionAgentPlanCard } from '@/components/sessions/companion/plan/SessionAgentPlanCard';
import { projectSessionAgentPlan } from '@/components/sessions/companion/plan/sessionAgentPlan';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetFrame, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { projectSessionBoard, type SessionBoardItemProjection } from '@/sync/domains/session/board';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * The F1 frame at static props on the lab's session (lab `cwidgets` WB, WK, WA, WS): real Board
 * items through `SessionWidgetHost`, the Plan through its Companion card, and the W1 states through
 * the frame itself. Plugin and hosted bodies cannot run on a dev page, so they show their honest
 * runtime state inside the same frame.
 */

function boardItem(title: string, source: SessionSurfaceItemV1['source'], frame: SessionSurfaceItemV1['frame'] = 'card') {
    const value: SessionSurfaceItemV1 = { v: 1, title, frame, height: { mode: 'auto', fallback: 'regular' }, source };
    return { revision: 'r1', outcome: { status: 'ready' as const, value } };
}

const CHECKLIST = createSessionSurfaceNoteDocumentV1([
    '- [x] Backoff capped at 5 attempts',
    '- [x] Jitter on reconnect',
    '- [ ] Soak test 30 min on devbox',
    '- [ ] Changelog entry',
].join('\n'));

const BOARD = projectSessionBoard({
    layout: undefined,
    items: new Map([
        ['relay', boardItem('Relay retries, last 90 min', { kind: 'hostedHtml', source: { kind: 'html', html: '<main></main>' }, requestedCapabilities: {} })],
        ['checklist', boardItem('Release checklist', { kind: 'declarative', document: CHECKLIST })],
        ['conv', boardItem('External conversations', { kind: 'widget', instance: {
            v: 1, id: 'conv', definition: { kind: 'installed', surface: { pluginId: 'happier.channels', localId: 'session-conversations-widget' } }, bindings: {},
        } })],
        ['question', boardItem('Open question', { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Does the phone sheet need the same retry budget as desktop?') })],
    ]),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

function item(id: string): SessionBoardItemProjection {
    const projected = BOARD.itemsById.get(id);
    if (!projected) throw new Error(`specimen item ${id} missing`);
    return projected;
}

const PLAN = projectSessionAgentPlan([
    { id: 'p1', content: 'Add backoff with jitter', status: 'completed', priority: 'medium' },
    { id: 'p2', content: 'Cover the 503 path', status: 'completed', priority: 'medium' },
    { id: 'p3', content: 'Soak test 30 min on devbox', status: 'in_progress', priority: 'medium' },
    { id: 'p4', content: 'Write the changelog entry', status: 'pending', priority: 'medium' },
]);

const NOOP = (): void => {};

function Card(props: Readonly<{
    id: string;
    frameStyle?: WidgetFrameStyle;
    density?: SessionWidgetDensity;
    section?: boolean;
    fresh?: boolean;
}>) {
    return (
        <SessionWidgetHost
            sessionId="specimen-session"
            item={item(props.id)}
            host={props.section ? 'companion' : 'details'}
            primaryHost={null}
            density={props.density ?? 'full'}
            canEdit
            executableCurrentness="not_executable"
            width="medium"
            heightBounds={{ min: 72, max: 360 }}
            {...(props.section ? { frame: 'section' as const } : {})}
            {...(props.frameStyle ? { frameStyle: props.frameStyle } : {})}
            {...(props.fresh ? { fresh: true } : {})}
            onRemove={NOOP}
            onRename={NOOP}
            testID={`specimen-${props.id}`}
        />
    );
}

/** The Board's two-column tier at a Details width (lab WB). */
function BoardGrid(props: Readonly<{ frameStyle: WidgetFrameStyle; phone: boolean; fresh?: boolean }>) {
    const styles = stylesheet;
    const plain = props.frameStyle === 'plain';
    if (props.phone) {
        return (
            <View style={[styles.column, plain ? styles.plainColumn : null]}>
                <Card id="checklist" frameStyle={props.frameStyle} />
                <Card id="relay" frameStyle={props.frameStyle} fresh={props.fresh} />
                <Card id="conv" frameStyle={props.frameStyle} />
            </View>
        );
    }
    return (
        <View style={[styles.grid, plain ? styles.plainGrid : null]}>
            <Card id="relay" frameStyle={props.frameStyle} fresh={props.fresh} />
            <View style={[styles.pair, plain ? styles.plainPair : null]}>
                <View style={styles.half}><Card id="checklist" frameStyle={props.frameStyle} /></View>
                <View style={styles.half}><Card id="conv" frameStyle={props.frameStyle} /></View>
            </View>
            <Card id="question" frameStyle={props.frameStyle} />
        </View>
    );
}

function Pane(props: Readonly<{ phone: boolean; caption?: string; children: React.ReactNode }>) {
    const styles = stylesheet;
    return (
        <View style={props.phone ? styles.phonePane : styles.pane}>
            {props.caption ? <Text style={styles.caption}>{props.caption}</Text> : null}
            {props.children}
        </View>
    );
}

/** The Companion column: the Plan and a Board widget as sections (Plain) or cards. */
function CompanionColumn(props: Readonly<{ frameStyle: WidgetFrameStyle; phone: boolean }>) {
    const styles = stylesheet;
    return (
        <View style={props.phone ? styles.phonePane : styles.companion}>
            <View style={props.frameStyle === 'card' ? styles.cardStack : null}>
                <SessionAgentPlanCard plan={PLAN} agentLabel="Claude" activity="working" frameStyle={props.frameStyle} testID="specimen-plan" />
                <Card id="checklist" section frameStyle={props.frameStyle} density="compact" />
            </View>
        </View>
    );
}

function StatesBoard(props: Readonly<{ phone: boolean }>) {
    const styles = stylesheet;
    const cell = (child: React.ReactNode, key: string) => (
        <View key={key} style={props.phone ? null : styles.stateCell}>{child}</View>
    );
    return (
        <View style={props.phone ? styles.column : styles.states}>
            {cell(
                <WidgetFrame
                    testID="specimen-state-loading"
                    frameStyle="card"
                    placement="board"
                    mark="puzzle-piece"
                    title="External conversations"
                    source="Channels"
                    rows={3}
                    body={{ kind: 'loading', accessibilityLabel: 'Loading' }}
                />,
                'loading',
            )}
            {cell(
                <WidgetFrame
                    testID="specimen-state-error"
                    frameStyle="card"
                    placement="board"
                    mark="puzzle-piece"
                    title="External conversations"
                    source="Channels"
                    body={{
                        kind: 'error',
                        title: 'Channels didn’t answer',
                        reason: 'MacBook Pro may be asleep. Your conversations are safe.',
                        action: { label: 'Try again', onPress: NOOP },
                        diagnosticCode: 'plugin_widget_failed',
                    }}
                />,
                'error',
            )}
            {cell(<Card id="conv" />, 'unavailable')}
            {cell(<Card id="relay" />, 'hosted')}
        </View>
    );
}

/** WA: the arrival ring is one-shot, so the specimen can replay the arrival (a fresh mount). */
function ArrivalSpecimen(props: Readonly<{ phone: boolean }>) {
    const [mount, setMount] = React.useState(0);
    return (
        <View style={stylesheet.arrival}>
            <Pressable testID="widgets-specimen-replay-arrival" onPress={() => setMount((value) => value + 1)}>
                <Text style={stylesheet.caption}>Replay arrival</Text>
            </Pressable>
            <Pane phone={props.phone}>
                <BoardGrid key={mount} frameStyle="card" phone={props.phone} fresh />
            </Pane>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    arrival: { gap: 8 },
    settingsPane: { width: 720, minHeight: 700, backgroundColor: theme.colors.surface.base },
    pane: {
        width: 600,
        paddingTop: 16,
        paddingBottom: 20,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    phonePane: {
        width: 390,
        paddingTop: 12,
        paddingBottom: 20,
        backgroundColor: theme.colors.surface.base,
    },
    companion: {
        width: 300,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    cardStack: { gap: 10 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.tertiary, paddingHorizontal: 20, paddingBottom: 10 },
    grid: { gap: 12, paddingHorizontal: 20 },
    plainGrid: { gap: 6 },
    pair: { flexDirection: 'row', gap: 12, alignItems: 'stretch' },
    plainPair: { gap: 28 },
    half: { flex: 1, minWidth: 0 },
    column: { gap: 12, paddingHorizontal: 16 },
    plainColumn: { gap: 6 },
    states: { width: 1200, flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
    stateCell: { width: 282 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start', maxWidth: 1380 },
}));

export const FRAME_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    WB: ({ phone }) => (
        <Pane phone={phone}>
            <BoardGrid frameStyle="card" phone={phone} />
        </Pane>
    ),
    WK: ({ phone }) => (
        <View style={stylesheet.row}>
            <Pane phone={phone} caption="Board · Card"><BoardGrid frameStyle="card" phone={phone} /></Pane>
            <Pane phone={phone} caption="Board · Plain"><BoardGrid frameStyle="plain" phone={phone} /></Pane>
            <CompanionColumn frameStyle="plain" phone={phone} />
            <CompanionColumn frameStyle="card" phone={phone} />
        </View>
    ),
    WKp: () => (
        <Pane phone>
            <BoardGrid frameStyle="plain" phone />
        </Pane>
    ),
    WA: ({ phone }) => <ArrivalSpecimen phone={phone} />,
    WS: ({ phone }) => <StatesBoard phone={phone} />,
    // Settings → Appearance → Widgets: the real section (reads and writes this device's settings).
    WKs: ({ phone }) => (
        <View style={phone ? stylesheet.phonePane : stylesheet.settingsPane}>
            <ItemList>
                <WidgetFrameAppearanceSection />
            </ItemList>
        </View>
    ),
};
