/**
 * `document`: Markdown placed in interface chrome (a plugin's detail step or body), read at the interface
 * reading size with headings that never outrank the step that holds them.
 */
export type MarkdownRenderingProfile = 'default' | 'transcript' | 'assistant' | 'user' | 'thinking' | 'widget' | 'document';

export function isAssistantMarkdownProfile(profile: MarkdownRenderingProfile): boolean {
    return profile === 'assistant' || profile === 'thinking';
}

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
