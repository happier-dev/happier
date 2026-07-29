export function formatAgentLikeIdForDisplay(id: string | null | undefined): string {
    const trimmed = String(id ?? '').trim();
    if (!trimmed) {
        return 'Unknown Backend';
    }

    const tokenized = trimmed
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[.\-_\s]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

    if (tokenized.length === 0) {
        return 'Unknown Backend';
    }

    return tokenized
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
        .join(' ');
}
