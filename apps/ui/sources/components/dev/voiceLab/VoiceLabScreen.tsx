import * as React from 'react';
import { Appearance, Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';

import { ConceptStage } from './ConceptStage';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { VOICE_LAB_CONCEPTS, placementFor } from './voiceLabConcepts';
import {
    VOICE_LAB_PROVIDERS,
    VOICE_LAB_PROVIDER_BY_ID,
    VOICE_LAB_STATES,
    VOICE_LAB_STATE_BY_ID,
    type VoiceControlId,
    type VoiceLabProviderId,
    type VoiceLabStateBasis,
    type VoiceLabStateId,
} from './voiceLabModel';
import { light, useVoiceLightTokens } from '@/components/voice/light/voiceLightTokens';
import type { VoiceLabSurface } from './conceptTypes';

/**
 * The Voice design lab.
 *
 * An isolated exploration surface. It does not import, wrap, or modify the
 * production Voice surface, and the production surface does not know it exists.
 * Its whole job is to make nine structurally different directions comparable
 * under identical state, theme, motion, and surrounding product.
 *
 * The scenario player is the important control: static frames cannot prove feel,
 * and the transitions between states are most of what is being judged here.
 */

const SURFACES: readonly Readonly<{ id: VoiceLabSurface; label: string }>[] = [
    { id: 'sidebar', label: 'Sidebar' },
    { id: 'home', label: 'Voice Home' },
    { id: 'session', label: 'In-session' },
    { id: 'mobile', label: 'Mobile' },
];

/** A believable session: start, talk, delegate, get blocked, leave it running. */
const SCENARIO: readonly Readonly<{ state: VoiceLabStateId; holdMs: number }>[] = [
    { state: 'ready', holdMs: 1400 },
    { state: 'preparing', holdMs: 900 },
    { state: 'connecting', holdMs: 1200 },
    { state: 'listening', holdMs: 1600 },
    { state: 'user_speaking', holdMs: 2600 },
    { state: 'thinking', holdMs: 1400 },
    { state: 'speaking', holdMs: 3000 },
    { state: 'interrupted', holdMs: 1100 },
    { state: 'user_speaking', holdMs: 2000 },
    { state: 'working', holdMs: 3000 },
    { state: 'attention', holdMs: 2600 },
    { state: 'working', holdMs: 2200 },
    { state: 'reconnecting', holdMs: 1600 },
    { state: 'listening', holdMs: 1600 },
    { state: 'ended', holdMs: 2600 },
];

/**
 * Honesty is a rendered property, not a comment.
 *
 * `model` states are real today. `derivable` states have a live signal that the
 * view model discards — shipping them is a projection change. `proposed` states
 * have no signal anywhere, and a concept that renders one without saying so is
 * exactly the lie that ends trust the first time it is wrong.
 */
const BASIS_MARK: Readonly<Record<VoiceLabStateBasis, string | null>> = {
    model: null,
    derivable: '◐',
    proposed: '○',
};

const BASIS_COPY: Readonly<Record<VoiceLabStateBasis, string>> = {
    model: 'Live today — resolveVoiceSurfaceState returns this exact value.',
    derivable: 'Signal exists, projection missing. Shipping this is a view-model change, not a protocol change.',
    proposed: 'No signal exists anywhere. This is a design proposal, not a capability.',
};

const Chip = React.memo(function Chip(props: Readonly<{
    label: string;
    selected: boolean;
    onPress: () => void;
    accent?: string;
    /** Marks how truthful this state is today. */
    basis?: VoiceLabStateBasis;
}>) {
    const tokens = useVoiceLightTokens();
    const mark = props.basis ? BASIS_MARK[props.basis] : null;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.selected }}
            accessibilityLabel={props.basis ? `${props.label}. ${BASIS_COPY[props.basis]}` : props.label}
            onPress={props.onPress}
            style={{
                minHeight: 30,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: props.selected ? 'transparent' : tokens.rule,
                backgroundColor: props.selected
                    ? (tokens.dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.08)')
                    : 'transparent',
            }}
        >
            {props.accent ? (
                <View style={{ width: 6, height: 6, borderRadius: 6, backgroundColor: props.accent }} />
            ) : null}
            <Text
                style={{
                    ...Typography.default(props.selected ? 'semiBold' : 'regular'),
                    fontSize: 12,
                    color: props.selected ? tokens.ink : tokens.inkMuted,
                }}
            >
                {props.label}
            </Text>
            {mark ? (
                <Text style={{ ...Typography.default('semiBold'), fontSize: 9, color: tokens.inkFaint }}>
                    {mark}
                </Text>
            ) : null}
        </Pressable>
    );
});

const SectionLabel = React.memo(function SectionLabel(props: Readonly<{ children: string }>) {
    const tokens = useVoiceLightTokens();
    return (
        <Text style={{ ...Typography.eyebrow(), color: tokens.inkFaint, marginBottom: 8 }}>{props.children}</Text>
    );
});

export function VoiceLabScreen() {
    const { theme } = useUnistyles();
    const tokens = useVoiceLightTokens();
    const reducedMotion = useReducedMotionPreference();
    const [orbEnabled, setOrbEnabled] = useLocalSettingMutable('voiceOrbEnabled');

    const [stateId, setStateId] = React.useState<VoiceLabStateId>('listening');
    const [conceptId, setConceptId] = React.useState<string>('__all__');
    const [surface, setSurface] = React.useState<VoiceLabSurface>('sidebar');
    const [providerId, setProviderId] = React.useState<VoiceLabProviderId>('happier.agent.codex/realtime-codex');
    const [expanded, setExpanded] = React.useState(false);
    /** Orthogonal to state, exactly as `micMuted` is on the real snapshot. */
    const [muted, setMuted] = React.useState(false);
    const [playing, setPlaying] = React.useState(false);
    const [lastAction, setLastAction] = React.useState<string | null>(null);
    /**
     * Deterministic single-frame render. Visual regression against a live clock
     * is impossible; freezing at an exact millisecond makes every concept
     * diffable and stops the frame callback entirely.
     */
    const [frozenAtMs, setFrozenAtMs] = React.useState<number | null>(null);

    const state = VOICE_LAB_STATE_BY_ID[stateId];
    const provider = VOICE_LAB_PROVIDER_BY_ID[providerId];

    // Scenario playback. One timer chain; stopping it is immediate.
    React.useEffect(() => {
        if (!playing) return;
        let index = SCENARIO.findIndex((s) => s.state === stateId);
        if (index < 0) index = 0;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const advance = () => {
            if (cancelled) return;
            const step = SCENARIO[index % SCENARIO.length]!;
            setStateId(step.state);
            index += 1;
            timer = setTimeout(advance, step.holdMs);
        };
        advance();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
        // Intentionally not re-running on manual stateId changes: the player owns
        // the sequence once it starts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playing]);

    const onAction = React.useCallback((id: VoiceControlId) => {
        setLastAction(id);
        if (id === 'start') setStateId('preparing');
        if (id === 'end') setStateId('ended');
        if (id === 'retry') setStateId('connecting');
        if (id === 'openConversation') setExpanded(true);
    }, []);

    const onToggleExpanded = React.useCallback(() => setExpanded((v) => !v), []);

    /**
     * Theme switching goes through the canonical theme owner.
     *
     * `UnistylesRuntime.setTheme('dark')` looks like the obvious call and is
     * wrong: the app registers *profile-derived* themes (18 profiles), so a bare
     * 'light'/'dark' name is not guaranteed to exist and throws into the crash
     * boundary. `applyThemeRuntimeSelection` resolves the registered themes from
     * the user's profiles, and the preference is persisted alongside it exactly
     * as Settings → Appearance does.
     */
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const toggleTheme = React.useCallback(() => {
        const next = theme.dark ? 'light' : 'dark';
        const profiles = themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE;
        setThemePreference(next);
        applyThemeRuntimeSelection({
            themePreference: next,
            themeProfiles: profiles,
            systemTheme: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
        });
    }, [setThemePreference, theme.dark, themeProfiles]);
    void themePreference;

    const concepts = conceptId === '__all__'
        ? VOICE_LAB_CONCEPTS
        : VOICE_LAB_CONCEPTS.filter((c) => c.id === conceptId);

    const detail = conceptId === '__all__' ? null : VOICE_LAB_CONCEPTS.find((c) => c.id === conceptId) ?? null;

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.background.canvas }}>
            {/* Lab chrome. Deliberately quiet — the concepts are the content. */}
            <View
                style={{
                    paddingHorizontal: 18,
                    paddingTop: 14,
                    paddingBottom: 12,
                    gap: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: tokens.rule,
                    backgroundColor: theme.colors.surface.base,
                }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 16, letterSpacing: -0.3, color: tokens.ink }}>
                        Voice concepts
                    </Text>
                    <View style={{ flex: 1, minWidth: 8 }} />
                    <Chip
                        label={playing ? 'Stop scenario' : 'Play scenario'}
                        selected={playing}
                        onPress={() => setPlaying((v) => !v)}
                        accent={playing ? light('warm', 1, tokens) : undefined}
                    />
                    <Chip label={expanded ? 'Collapse' : 'Expand'} selected={expanded} onPress={onToggleExpanded} />
                    <Chip
                        label={orbEnabled ? 'Orb on' : 'Orb off'}
                        selected={!orbEnabled}
                        onPress={() => setOrbEnabled(!orbEnabled)}
                    />
                    <Chip
                        label={muted ? 'Mic muted' : 'Mic open'}
                        selected={muted}
                        onPress={() => setMuted((v) => !v)}
                        accent={muted ? light('warm', 1, tokens) : undefined}
                    />
                    <Chip
                        label={frozenAtMs === null ? 'Freeze frame' : 'Unfreeze'}
                        selected={frozenAtMs !== null}
                        onPress={() => {
                            setPlaying(false);
                            // A fixed sample rather than "now": the same frame every time.
                            setFrozenAtMs((v) => (v === null ? 2400 : null));
                        }}
                    />
                    <Chip
                        label={theme.dark ? 'Dark theme' : 'Light theme'}
                        selected={false}
                        onPress={toggleTheme}
                    />
                    <Chip
                        label={reducedMotion ? 'Reduced motion ON' : 'Reduced motion off'}
                        selected={reducedMotion}
                        onPress={() => setLastAction('reduced-motion-is-a-system-preference')}
                    />
                </View>

                <View style={{ gap: 8 }}>
                    <SectionLabel>Concept</SectionLabel>
                    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                        <Chip label="Compare all" selected={conceptId === '__all__'} onPress={() => setConceptId('__all__')} />
                        {VOICE_LAB_CONCEPTS.map((c) => (
                            <Chip
                                key={c.id}
                                label={c.name}
                                selected={conceptId === c.id}
                                onPress={() => setConceptId(c.id)}
                            />
                        ))}
                        <View style={{ width: 16 }} />
                        {SURFACES.map((s) => (
                            <Chip
                                key={s.id}
                                label={s.label}
                                selected={surface === s.id}
                                onPress={() => setSurface(s.id)}
                            />
                        ))}
                    </View>
                </View>

                <View style={{ gap: 8 }}>
                    <SectionLabel>
                        Provider — capability decides which controls may render at all
                    </SectionLabel>
                    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {VOICE_LAB_PROVIDERS.map((p) => (
                            <Chip
                                key={p.id}
                                label={p.label}
                                selected={providerId === p.id}
                                onPress={() => setProviderId(p.id)}
                            />
                        ))}
                        <Text style={{ ...Typography.default(), fontSize: 11, color: tokens.inkFaint, flexShrink: 1 }}>
                            {provider.note}
                        </Text>
                    </View>
                </View>

                <View style={{ gap: 8 }}>
                    <SectionLabel>
                        State — ◐ signal exists, projection missing · ○ no signal anywhere
                    </SectionLabel>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={{ flexDirection: 'row', gap: 6, paddingRight: 18 }}>
                            {VOICE_LAB_STATES.map((s) => (
                                <Chip
                                    key={s.id}
                                    label={s.label}
                                    selected={stateId === s.id}
                                    basis={s.basis}
                                    accent={light(s.stop, 1, tokens)}
                                    onPress={() => {
                                        setPlaying(false);
                                        setStateId(s.id);
                                    }}
                                />
                            ))}
                        </View>
                    </ScrollView>
                    <Text style={{ ...Typography.default(), fontSize: 11.5, lineHeight: 16, color: tokens.inkFaint }}>
                        <Text style={{ ...Typography.default('semiBold'), fontSize: 11.5, color: tokens.inkMuted }}>
                            {state.basis === 'model' ? 'Live today' : state.basis === 'derivable' ? 'Derivable' : 'Proposed'}
                            {' — '}
                        </Text>
                        {state.source ?? state.modelState ?? BASIS_COPY[state.basis]}
                    </Text>
                </View>
            </View>

            {/* The concepts come first. Reading about a design before seeing it
                is the wrong order for a lab. */}
            <ScrollView contentContainerStyle={{ padding: 22, gap: 22 }}>
                {/*
                  * One provider for the whole page — nine concepts on screen must
                  * cost ONE frame callback, not nine. This is the discipline the
                  * production surface already keeps and the thing most likely to
                  * be lost when a concept graduates.
                  */}
                <VoiceEnergyProvider state={state} previewTimeMs={frozenAtMs}>
                    <View style={{ flexDirection: 'row', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        {concepts.map((concept) => {
                            const Component = concept.Component;
                            return (
                                <View key={concept.id} style={{ gap: 8 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                                        <Text style={{ ...Typography.default('semiBold'), fontSize: 13, color: tokens.ink }}>
                                            {concept.name}
                                        </Text>
                                        <Text style={{ ...Typography.default(), fontSize: 11, color: tokens.inkFaint }}>
                                            {concept.model.split('.')[0]}
                                        </Text>
                                    </View>
                                    <ConceptStage surface={surface} placement={placementFor(concept.id)}>
                                        <Component
                                            state={state}
                                            provider={provider}
                                            surface={surface}
                                            // Voice Home is the conversational
                                            // state by definition — there is no
                                            // collapsed Home.
                                            expanded={expanded || surface === 'home'}
                                            muted={muted}
                                            onToggleExpanded={onToggleExpanded}
                                            onToggleMute={() => setMuted((v) => !v)}
                                            onAction={onAction}
                                        />
                                    </ConceptStage>
                                </View>
                            );
                        })}
                    </View>
                </VoiceEnergyProvider>

                {detail ? (
                    <View style={{ gap: 6, maxWidth: 760 }}>
                        <Text style={{ ...Typography.default('semiBold'), fontSize: 22, letterSpacing: -0.5, color: tokens.ink }}>
                            {detail.name}
                        </Text>
                        <Text style={{ ...Typography.default(), fontSize: 15, lineHeight: 21, color: tokens.ink }}>
                            {detail.thesis}
                        </Text>
                        <Text style={{ ...Typography.default(), fontSize: 13, lineHeight: 19, color: tokens.inkMuted }}>
                            <Text style={{ ...Typography.default('semiBold'), fontSize: 13, color: tokens.inkMuted }}>
                                Structural model — </Text>
                            {detail.model}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 26, flexWrap: 'wrap', marginTop: 6 }}>
                            <View style={{ gap: 3, minWidth: 240, flex: 1 }}>
                                <SectionLabel>Strengths</SectionLabel>
                                {detail.strengths.map((s) => (
                                    <Text key={s} style={{ ...Typography.default(), fontSize: 12.5, lineHeight: 18, color: tokens.inkMuted }}>
                                        · {s}
                                    </Text>
                                ))}
                            </View>
                            <View style={{ gap: 3, minWidth: 240, flex: 1 }}>
                                <SectionLabel>{`Risks — cost: ${detail.cost}`}</SectionLabel>
                                {detail.risks.map((s) => (
                                    <Text key={s} style={{ ...Typography.default(), fontSize: 12.5, lineHeight: 18, color: tokens.inkMuted }}>
                                        · {s}
                                    </Text>
                                ))}
                            </View>
                        </View>
                    </View>
                ) : null}

                <View style={{ gap: 4, maxWidth: 760 }}>
                    <SectionLabel>Notes</SectionLabel>
                    <Text style={{ ...Typography.default(), fontSize: 12, lineHeight: 18, color: tokens.inkFaint }}>
                        Reduced motion follows the system preference and is read through the app’s canonical
                        `useReducedMotionPreference` hook — toggle it in macOS Accessibility to see every concept’s
                        reduced interpretation. Audio level is synthesised on the UI thread and never enters React
                        state, so nine mounted concepts share one frame callback and the shared
                        energy loop causes zero React re-renders per frame.
                    </Text>
                    {lastAction ? (
                        <Text style={{ ...Typography.default(), fontSize: 12, color: tokens.inkFaint }}>
                            Last action: {lastAction}
                        </Text>
                    ) : null}
                </View>
            </ScrollView>
        </View>
    );
}
