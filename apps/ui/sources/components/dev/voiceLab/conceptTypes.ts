import type { VoiceControlId, VoiceLabProviderSpec, VoiceLabStateSpec } from './voiceLabModel';

/**
 * Which host the concept is being rendered into.
 *
 * `home` is the "Voice Home" the approved plan requires the exploration to
 * cover. It is included so the question *does a dedicated Voice Home earn its
 * place, or is it just the expanded presence with an identity header?* can be
 * answered with evidence rather than asserted.
 */
export type VoiceLabSurface = 'sidebar' | 'home' | 'session' | 'mobile';

export type VoiceConceptProps = Readonly<{
    state: VoiceLabStateSpec;
    /** Provider capability gates which controls may render at all. */
    provider: VoiceLabProviderSpec;
    surface: VoiceLabSurface;
    expanded: boolean;
    /**
     * Orthogonal to state — `micMuted` is a flag on the snapshot, not a state.
     * It is passed separately so concepts cannot accidentally model it as one.
     */
    muted: boolean;
    onToggleExpanded: () => void;
    onToggleMute: () => void;
    onAction: (id: VoiceControlId) => void;
}>;

export type VoiceConceptSpec = Readonly<{
    id: string;
    name: string;
    thesis: string;
    /** The structural model — this is what must differ between concepts. */
    model: string;
    strengths: readonly string[];
    risks: readonly string[];
    cost: 'low' | 'medium' | 'high';
    Component: React.ComponentType<VoiceConceptProps>;
}>;
