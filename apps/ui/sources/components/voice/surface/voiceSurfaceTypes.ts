export type VoiceSurfaceVariant = 'sidebar' | 'session';

export type VoiceSurfaceProps = Readonly<{
    variant: VoiceSurfaceVariant;
    sessionId?: string | null;
    /**
     * The Session presentation owner's existing fact when it retains a hidden
     * native surface. Other hosts mount only presented surfaces, so absence is
     * deliberately mount-as-presented rather than a second visibility owner.
     */
    isPresented?: boolean;
    style?: unknown;
}>;
