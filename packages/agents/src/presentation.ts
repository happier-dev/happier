import { BUNDLED_AGENT_PRESENTATION } from './generated/bundledAgentPresentation.js';

export type BundledAgentPresentation = Readonly<{
    name: string;
    identityColor: Readonly<{ light: string; dark: string }> | null;
}>;

export function readBundledAgentPresentation(agentId: string): BundledAgentPresentation | null {
    return Object.hasOwn(BUNDLED_AGENT_PRESENTATION, agentId) ? BUNDLED_AGENT_PRESENTATION[agentId]! : null;
}

/** Declared catalog presentation, including contributed Agent containers. */
export function readConcreteAgentPresentation(agentId: string): BundledAgentPresentation | null {
    return readBundledAgentPresentation(agentId);
}

/** Readable fallback for an open Agent id when no admitted catalog title exists. */
export function formatAgentLikeIdForDisplay(id: string | null | undefined): string {
    const trimmed = String(id ?? '').trim();
    if (!trimmed) return 'Unknown Backend';
    const presentation = readBundledAgentPresentation(trimmed);
    if (presentation) return presentation.name;
    const tokens = trimmed
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[.\-_\s]+/)
        .map(token => token.trim())
        .filter(Boolean);
    return tokens.length > 0
        ? tokens.map(token => token.charAt(0).toUpperCase() + token.slice(1)).join(' ')
        : 'Unknown Backend';
}

/** Shared neutral for an Agent without an admitted identity hue, or a folded Other series. */
export function getNeutralAgentIdentityColor(theme: Readonly<{ dark: boolean }>): string {
    return theme.dark ? '#6C625D' : '#A3A3A8';
}

