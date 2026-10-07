import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { makeMutable } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import { planetMarkTier } from '@happier-dev/brand/planet';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { VoiceCompactTranscript } from '@/components/voice/presence/VoiceCompactTranscript';
import { VoiceIsland, VOICE_ISLAND_DESKTOP } from '@/components/voice/presence/VoiceIsland';
import { VoiceMarkArt, type VoiceMarkPose } from '@/components/voice/presence/VoiceMark';
import { VoiceStatusLine } from '@/components/voice/presence/VoiceStatusLine';
import { VoiceOrb } from '@/components/voice/presence/VoiceOrb';
import { VoiceGlance } from '@/components/voice/presence/VoiceGlance';
import { VoiceTopBarPresence } from '@/components/voice/presence/VoiceTopBarPresence';
import { VoiceTransport } from '@/components/voice/presence/VoiceTransport';

import { VoicePresenceContainerFrame } from './VoicePresenceContainerFrames';
import { buildVoicePresenceFixture, buildVoicePresenceSurfaceFixture, VOICE_PRESENCE_FIXTURE_STATES, type VoicePresenceFixtureState } from './voicePresenceFixtures';

const PHONE_FRAMES = new Set(['Ip', 'Op', 'Rp', 'STp']);

/**
 * Dev-only fixtures for Voice presence (lab `voice-presence`): the real Mark, primitives and
 * containers at fixed states, so the build can be paired against the lab without a live call.
 * Frames: M (mark ladder) · K (primitives and containers) · ST (every state) · A · C · R · I · O ·
 * Ip · Op · Rp · STp · END (see `VoicePresenceContainerFrames`).
 */
export function VoicePresenceSpecimen(props: Readonly<{ frame: string; state?: VoicePresenceFixtureState | 'all' }>): React.ReactElement {
    const styles = stylesheet;
    return (
        <ScrollView style={styles.page} contentContainerStyle={PHONE_FRAMES.has(props.frame) ? styles.phonePage : styles.pageContent}>
            {props.state === 'all' ? VOICE_PRESENCE_FIXTURE_STATES.map((state) => <SingleState key={state} frame={props.frame} state={state} compact />) : props.state ? <SingleState frame={props.frame} state={props.state} /> : (
                <>
                    {props.frame === 'M' ? <MarkBoard /> : null}
                    {props.frame === 'K' ? <KitBoard /> : null}
                    {props.frame === 'ST' ? <StatesBoard /> : null}
                    {props.frame !== 'M' && props.frame !== 'K' && props.frame !== 'ST' ? <VoicePresenceContainerFrame frame={props.frame} /> : null}
                </>
            )}
        </ScrollView>
    );
}

/** One real container at an explicit inert fixture state, including Orb recovery/attention states. */
function SingleState(props: Readonly<{ frame: string; state: VoicePresenceFixtureState; compact?: boolean }>) {
    const { width } = useWindowDimensions();
    const voice = buildVoicePresenceFixture(props.state);
    const anchor = React.useRef<View | null>(null);
    const translateX = React.useMemo(() => makeMutable(width), [width]);
    const phone = width < 600;
    return <View style={{ gap: 24, minHeight: props.compact ? 190 : 220, padding: phone ? 16 : 0 }} testID="dev-voice-single-state">
        <Text style={stylesheet.h1}>{`${props.frame} · ${props.state}`}</Text>
        {props.frame === 'O' || props.frame === 'Op'
            ? <View style={{ alignItems: 'flex-end', paddingTop: 24 }}><VoiceOrb voice={voice} anchorRef={anchor} sectionOpen={false} onOpenSection={NOOP} shouldSuppressPress={NO_SUPPRESS} translateX={translateX} hostWidth={width} /></View>
            : props.frame === 'I' || props.frame === 'Ip'
                ? <VoiceIsland voice={voice} phone={phone} width={phone ? width - 32 : VOICE_ISLAND_DESKTOP.width} anchorRef={anchor} sectionOpen={false} onOpenSection={NOOP} shouldSuppressPress={NO_SUPPRESS} />
                : <VoiceTopBarPresence voice={voice} />}
        {props.compact ? null : <View style={{ width: '100%', maxWidth: 360 }}><VoiceGlance model={buildVoicePresenceSurfaceFixture(props.state)} presentation="companion" /></View>}
    </View>;
}

type LadderCell = Readonly<{ label: string; pose: VoiceMarkPose; morph?: number; energy?: number; flow?: number; muted?: boolean }>;

const LADDER: readonly LadderCell[] = [
    { label: 'Rest · mic', pose: 'mic' },
    { label: 'Tap · 35 %', pose: 'ready', morph: 0.35 },
    { label: 'Tap · 70 %', pose: 'ready', morph: 0.7 },
    { label: 'Live · listening', pose: 'ready', morph: 1, energy: 0.18, flow: -1 },
    { label: 'Live · speaking', pose: 'ready', morph: 1, energy: 0.9, flow: 1 },
    { label: 'Muted', pose: 'ready', morph: 1, muted: true },
    { label: 'Failed', pose: 'shade', morph: 1 },
];
const SIZES = [16, 20, 24, 32, 48] as const;
const NO_SUPPRESS = (): boolean => false;
const NOOP = (): void => {};

function MarkBoard(): React.ReactElement {
    const styles = stylesheet;
    return (
        <View style={styles.board}>
            <Text style={styles.h1}>The mark: a microphone at rest, the planet when live</Text>
            <View style={styles.tableHead}>
                <Text style={[styles.th, styles.sizeCol]}>Size</Text>
                {LADDER.map((cell) => <Text key={cell.label} style={[styles.th, styles.cellCol]}>{cell.label}</Text>)}
            </View>
            {SIZES.map((size) => {
                const tier = planetMarkTier(size);
                return (
                    <View key={size} style={styles.tableRow}>
                        <View style={styles.sizeCol}>
                            <Text style={styles.rowTitle}>{size} pt</Text>
                            <Text style={styles.rowMeta}>{`${tier.columns} × ${tier.rows} grid · ${tier.micDots} dots · pitch ${tier.pitch.toFixed(1)}`}</Text>
                        </View>
                        {LADDER.map((cell) => (
                            <View key={cell.label} style={[styles.cellCol, styles.cellCentre]}>
                                <VoiceMarkArt
                                    size={size}
                                    pose={cell.pose}
                                    muted={cell.muted}
                                    preview={{ morph: cell.pose === 'mic' ? 0 : cell.morph ?? 1, energy: cell.energy ?? 0, flow: cell.flow ?? 0 }}
                                />
                            </View>
                        ))}
                    </View>
                );
            })}
        </View>
    );
}

function KitBoard(): React.ReactElement {
    const styles = stylesheet;
    const speaking = React.useMemo(() => buildVoicePresenceFixture('speaking'), []);
    const anchor = React.useRef<View | null>(null);
    return (
        <View style={styles.board}>
            <Text style={styles.h1}>One presence model, three containers</Text>
            <Text style={styles.h2}>Shared primitives</Text>
            <View style={styles.prims}>
                <Prim title="Mark">
                    <VoiceMarkArt pose="mic" size={32} preview={{ morph: 0 }} />
                    <View style={{ width: 16 }} />
                    <VoiceMarkArt pose="ready" size={32} preview={{ morph: 1, energy: 0.85, flow: 1 }} />
                </Prim>
                <Prim title="Status line"><VoiceStatusLine voice={speaking} size="island" /></Prim>
                <Prim title="Transport"><VoiceTransport voice={speaking} size="island" /></Prim>
                <Prim title="Compact transcript"><VoiceCompactTranscript voice={speaking} /></Prim>
            </View>
            <Text style={styles.h2}>Containers</Text>
            <View style={styles.containers}>
                <View style={styles.container}>
                    <View style={styles.miniTop}><View style={styles.tabsBar} /><VoiceTopBarPresence voice={speaking} /></View>
                    <View style={styles.miniTop}><View style={styles.tabsBar} /><VoiceTopBarPresence voice={buildVoicePresenceFixture('rest')} /></View>
                </View>
                <View style={[styles.container, styles.containerIsland]}>
                    <VoiceIsland
                        voice={speaking}
                        phone={false}
                        width={300}
                        anchorRef={anchor}
                        sectionOpen={false}
                        onOpenSection={NOOP}
                        shouldSuppressPress={NO_SUPPRESS}
                    />
                </View>
            </View>
        </View>
    );
}

const ORDER: readonly VoicePresenceFixtureState[] = [
    'connecting', 'listening', 'transcribing', 'thinking', 'working', 'needs_you', 'speaking', 'interrupted', 'muted', 'blocked', 'reconnecting', 'failed', 'ended',
];

function StatesBoard(): React.ReactElement {
    const styles = stylesheet;
    const anchor = React.useRef<View | null>(null);
    return (
        <View style={styles.board}>
            <Text style={styles.h1}>Every state, one projection</Text>
            {ORDER.map((state) => {
                const voice = buildVoicePresenceFixture(state);
                return (
                    <View key={state} style={styles.stateRow}>
                        <Text style={[styles.rowTitle, styles.stateName]}>{state}</Text>
                        <View style={styles.stateCell}><VoiceTopBarPresence voice={voice} /></View>
                        <VoiceIsland
                            voice={voice}
                            phone={false}
                            width={VOICE_ISLAND_DESKTOP.width}
                            anchorRef={anchor}
                            sectionOpen={false}
                            onOpenSection={NOOP}
                            shouldSuppressPress={NO_SUPPRESS}
                        />
                    </View>
                );
            })}
        </View>
    );
}

function Prim(props: Readonly<{ title: string; children: React.ReactNode }>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View style={styles.prim}>
            <View style={styles.primPreview}>{props.children}</View>
            <Text style={styles.rowTitle}>{props.title}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.background.canvas },
    pageContent: { padding: 36, gap: 24 },
    phonePage: { padding: 0 },
    board: { maxWidth: 1360, gap: 0 },
    h1: { ...Typography.default('bold'), fontSize: 24, lineHeight: 30, letterSpacing: -0.48, color: theme.colors.text.primary, marginBottom: 22 },
    h2: { ...Typography.default('semiBold'), fontSize: 16, lineHeight: 22, color: theme.colors.text.primary, marginTop: 30, marginBottom: 12 },
    tableHead: { flexDirection: 'row', paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
    th: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.tertiary },
    tableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border.default, minHeight: 64 },
    sizeCol: { width: 190 },
    cellCol: { flex: 1, textAlign: 'center' },
    cellCentre: { alignItems: 'center', justifyContent: 'center' },
    rowTitle: { ...Typography.default('semiBold'), fontSize: 13.5, color: theme.colors.text.primary },
    rowMeta: { ...Typography.default(), fontSize: 12, color: theme.colors.text.tertiary },
    prims: { flexDirection: 'row', gap: 14 },
    prim: { flex: 1, gap: 8 },
    primPreview: {
        height: 88,
        borderRadius: 14,
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 14,
    },
    containers: { flexDirection: 'row', gap: 16 },
    container: {
        flex: 1,
        height: 330,
        borderRadius: 14,
        backgroundColor: theme.colors.background.canvas,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        overflow: 'hidden',
        gap: 12,
    },
    containerIsland: { justifyContent: 'flex-end', alignItems: 'flex-end', padding: 16 },
    miniTop: { height: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
    tabsBar: { flex: 1, height: 10, marginRight: 10, borderRadius: 5, backgroundColor: theme.colors.surface.inset },
    stateRow: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
    stateName: { width: 120 },
    stateCell: { width: 280, alignItems: 'flex-start' },
}));
