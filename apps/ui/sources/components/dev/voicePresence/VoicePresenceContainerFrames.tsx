import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { makeMutable } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { AgentInputDictationButton } from '@/components/sessions/agentInput/components/AgentInputDictationButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { VoiceComposerPlanet } from '@/components/voice/composer/VoiceComposerPlanet';
import { VoiceGlance } from '@/components/voice/presence/VoiceGlance';
import { VoiceIsland, VOICE_ISLAND_DESKTOP } from '@/components/voice/presence/VoiceIsland';
import { VoiceOrb } from '@/components/voice/presence/VoiceOrb';
import { VoiceTopBarPresence } from '@/components/voice/presence/VoiceTopBarPresence';
import { resolveVoiceMarkPose } from '@/components/voice/presence/resolveVoiceMarkPose';
import { t } from '@/text';

import {
    buildVoicePresenceFixture,
    buildVoicePresenceSurfaceFixture,
    type VoicePresenceFixtureState,
} from './voicePresenceFixtures';

/**
 * Dev-only container frames (lab `voice-presence` A · C · I · Ip · O · Op · R · Rp · STp): the real
 * containers and section at fixture states inside a plain window mock, positioned where the shell
 * places them, so each can be paired against its lab frame without a live call.
 */
const NO_SUPPRESS = (): boolean => false;
const NOOP = (): void => {};

export function VoicePresenceContainerFrame(props: Readonly<{ frame: string }>): React.ReactElement | null {
    switch (props.frame) {
        case 'A': return <TopBarFrame withCompanion />;
        case 'C': return <TopBarFrame withPopover />;
        case 'R': return <TopBarFrame rest />;
        case 'I': return <DesktopFloatFrame kind="island" />;
        case 'O': return <DesktopFloatFrame kind="orb" />;
        case 'Ip': return <PhoneFrame kind="island" />;
        case 'Op': return <PhoneFrame kind="orb" />;
        case 'Rp': return <PhoneFrame kind="rest" />;
        case 'STp': return <PhoneStates />;
        case 'END': return <EndedFrame />;
        default: return null;
    }
}

function Strip(props: Readonly<{ state: VoicePresenceFixtureState }>) {
    const styles = stylesheet;
    return (
        <View style={styles.strip}>
            <View style={styles.tabs}>
                {['Fix settings modal rem…', 'Review…', 'Relay retry with…', 'Nightly release…'].map((label, index) => (
                    <View key={label} style={[styles.tab, index === 0 ? styles.tabActive : null]}>
                        <Text numberOfLines={1} style={styles.tabLabel}>{label}</Text>
                    </View>
                ))}
            </View>
            <VoiceTopBarPresence voice={buildVoicePresenceFixture(props.state)} />
        </View>
    );
}

function Composer(props: Readonly<{ state: VoicePresenceFixtureState; phone?: boolean }>) {
    const styles = stylesheet;
    const voice = buildVoicePresenceFixture(props.state);
    return (
        <View style={[styles.composer, props.phone ? styles.composerPhone : null]}>
            <View style={styles.field}>
                <Text style={styles.placeholder}>{props.phone ? 'Message Claude…' : 'Message this session…'}</Text>
                <View style={styles.fieldAccessory}>
                    <AgentInputDictationButton status="idle" onPress={NOOP} />
                </View>
            </View>
            <View style={styles.actions}>
                <VoiceComposerPlanet
                    pose={resolveVoiceMarkPose(voice)}
                    muted={voice.live && voice.muted}
                    accessibilityLabel={voice.primaryActionLabel ?? ''}
                    accessibilityHint=""
                    tooltip={t('voicePresence.talkWithVoice')}
                    onPress={NOOP}
                />
                <IconButton iconName="arrow-up" accessibilityLabel={t('common.send')} size={32} onPress={NOOP} />
            </View>
        </View>
    );
}

function TopBarFrame(props: Readonly<{ withCompanion?: boolean; withPopover?: boolean; rest?: boolean }>) {
    const styles = stylesheet;
    const state: VoicePresenceFixtureState = props.rest ? 'rest' : 'speaking';
    return (
        <View style={styles.window}>
            <Strip state={state} />
            <View style={styles.body}>
                <View style={styles.main}>
                    <View style={styles.transcriptLine} />
                    <View style={[styles.transcriptLine, { width: '62%' }]} />
                    <View style={styles.grow} />
                    <Composer state={state} />
                </View>
                {props.withCompanion ? (
                    <View style={styles.companion}>
                        <Text style={styles.companionTitle}>Companion</Text>
                        <VoiceGlance model={buildVoicePresenceSurfaceFixture('speaking')} presentation="companion" />
                    </View>
                ) : null}
            </View>
            {props.withPopover ? (
                <View style={styles.popover}>
                    <VoiceGlance model={buildVoicePresenceSurfaceFixture('speaking')} presentation="popover" />
                </View>
            ) : null}
        </View>
    );
}

function DesktopFloatFrame(props: Readonly<{ kind: 'island' | 'orb' }>) {
    const styles = stylesheet;
    const voice = buildVoicePresenceFixture('speaking');
    const anchor = React.useRef<View | null>(null);
    const translateX = React.useMemo(() => makeMutable(1000), []);
    return (
        <View style={styles.window}>
            <Strip state="rest" />
            <View style={styles.body}>
                <View style={styles.main}>
                    <View style={styles.transcriptLine} />
                    <View style={[styles.transcriptLine, { width: '62%' }]} />
                    <View style={styles.grow} />
                    <Composer state="speaking" />
                </View>
            </View>
            <View style={props.kind === 'island' ? styles.islandSpot : styles.orbSpot}>
                {props.kind === 'island' ? (
                    <VoiceIsland voice={voice} phone={false} width={VOICE_ISLAND_DESKTOP.width} anchorRef={anchor} sectionOpen={false} onOpenSection={NOOP} shouldSuppressPress={NO_SUPPRESS} />
                ) : (
                    <VoiceOrb voice={voice} anchorRef={anchor} sectionOpen={false} onOpenSection={NOOP} shouldSuppressPress={NO_SUPPRESS} translateX={translateX} hostWidth={1100} />
                )}
            </View>
        </View>
    );
}

function PhoneFrame(props: Readonly<{ kind: 'island' | 'orb' | 'rest' }>) {
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    const state: VoicePresenceFixtureState = props.kind === 'rest' ? 'rest' : 'speaking';
    const voice = buildVoicePresenceFixture(state);
    const anchor = React.useRef<View | null>(null);
    const translateX = React.useMemo(() => makeMutable(width), [width]);
    return (
        <View style={styles.phone}>
            <View style={styles.transcriptLine} />
            <View style={[styles.transcriptLine, { width: '70%' }]} />
            <View style={styles.grow} />
            <Composer state={state} phone />
            {props.kind === 'island' ? (
                <View style={styles.phoneIsland}>
                    <VoiceIsland voice={voice} phone width={width - 32} anchorRef={anchor} sectionOpen={false} onOpenSection={NOOP} shouldSuppressPress={NO_SUPPRESS} />
                </View>
            ) : null}
            {props.kind === 'orb' ? (
                <View style={styles.phoneOrb}>
                    <VoiceOrb voice={voice} anchorRef={anchor} sectionOpen={false} onOpenSection={NOOP} shouldSuppressPress={NO_SUPPRESS} translateX={translateX} hostWidth={width} />
                </View>
            ) : null}
            <View style={styles.bar} />
        </View>
    );
}

const PHONE_STATES: readonly VoicePresenceFixtureState[] = ['connecting', 'speaking', 'muted', 'blocked', 'reconnecting', 'failed', 'ended'];

function PhoneStates() {
    const styles = stylesheet;
    const { width } = useWindowDimensions();
    const anchor = React.useRef<View | null>(null);
    return (
        <View style={styles.phoneStates}>
            {PHONE_STATES.map((state) => (
                <View key={state} style={styles.phoneStateRow}>
                    <Text style={styles.stateName}>{state}</Text>
                    <VoiceIsland voice={buildVoicePresenceFixture(state)} phone width={width - 32} anchorRef={anchor} sectionOpen={false} onOpenSection={NOOP} shouldSuppressPress={NO_SUPPRESS} />
                </View>
            ))}
        </View>
    );
}

function EndedFrame() {
    const styles = stylesheet;
    return (
        <View style={styles.endedRow}>
            <View style={styles.endedCell}><VoiceTopBarPresence voice={buildVoicePresenceFixture('ended')} /></View>
            <View style={styles.endedGlance}><VoiceGlance model={buildVoicePresenceSurfaceFixture('ended')} presentation="companion" /></View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    window: { height: 860, borderRadius: 12, overflow: 'hidden', backgroundColor: theme.colors.background.canvas, borderWidth: 1, borderColor: theme.colors.border.default },
    strip: { height: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
    tabs: { flex: 1, flexDirection: 'row', gap: 6, minWidth: 0 },
    tab: { height: 28, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center', maxWidth: 200 },
    tabActive: { backgroundColor: theme.colors.surface.base },
    tabLabel: { ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text.secondary },
    body: { flex: 1, flexDirection: 'row', margin: 6, marginTop: 0, borderRadius: 10, backgroundColor: theme.colors.surface.base, overflow: 'hidden' },
    main: { flex: 1, padding: 40, gap: 14 },
    transcriptLine: { height: 12, width: '80%', borderRadius: 6, backgroundColor: theme.colors.surface.inset },
    grow: { flex: 1 },
    companion: { width: 390, paddingHorizontal: 12, paddingTop: 12, borderLeftWidth: 1, borderLeftColor: theme.colors.border.default },
    companionTitle: { ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.text.primary, marginBottom: 8 },
    popover: { position: 'absolute', top: 44, right: 12, width: 340, borderRadius: 14, paddingHorizontal: 14, paddingBottom: 14, paddingTop: 4, backgroundColor: theme.colors.surface.elevated, borderWidth: 0.5, borderColor: theme.colors.border.default },
    composer: { borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border.default, backgroundColor: theme.colors.surface.base, padding: 12, gap: 18 },
    composerPhone: { marginHorizontal: 12 },
    field: { minHeight: 40, position: 'relative' },
    fieldAccessory: { position: 'absolute', top: -6, right: -6, width: 44, height: 44 },
    placeholder: { ...Typography.default(), fontSize: 15, color: theme.colors.text.tertiary },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
    islandSpot: { position: 'absolute', right: 24, bottom: 160 },
    orbSpot: { position: 'absolute', right: 30, bottom: 160 },
    phone: { height: 844, paddingTop: 80, backgroundColor: theme.colors.surface.base, gap: 14 },
    phoneIsland: { marginHorizontal: 16, marginTop: 4 },
    phoneOrb: { position: 'absolute', right: 14, bottom: 260 },
    bar: { height: 56, marginHorizontal: 70, marginBottom: 20, marginTop: 12, borderRadius: 28, backgroundColor: theme.colors.surface.inset },
    phoneStates: { padding: 16, gap: 12 },
    phoneStateRow: { gap: 4 },
    stateName: { ...Typography.default(), fontSize: 12, color: theme.colors.text.tertiary },
    endedRow: { flexDirection: 'row', gap: 40, alignItems: 'flex-start' },
    endedCell: { width: 260, alignItems: 'flex-start' },
    endedGlance: { width: 360 },
}));
