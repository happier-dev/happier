export type MarkdownRenderingProfile = 'default' | 'transcript' | 'thinking';

export function normalizeMarkdownRenderingProfile(params: Readonly<{
    profile?: MarkdownRenderingProfile;
    variant?: 'default' | 'thinking';
}>): MarkdownRenderingProfile {
    if (params.profile) return params.profile;
    if (params.variant === 'thinking') return 'thinking';
    return 'default';
}

export function markdownProfileToLegacyVariant(profile: MarkdownRenderingProfile): 'default' | 'thinking' {
    return profile === 'thinking' ? 'thinking' : 'default';
}
