export type VoiceSurfaceVariant = 'sidebar' | 'session';

export type VoiceSurfaceProps = Readonly<{
    variant: VoiceSurfaceVariant;
    sessionId?: string | null;
    style?: unknown;
}>;
