function normalizeUsageLabel(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

const usageTokenLabels = new Map<string, string>([
    ['acp', 'ACP'],
    ['api', 'API'],
    ['anthropic', 'Anthropic'],
    ['app', 'App'],
    ['appserver', 'App Server'],
    ['google', 'Google'],
    ['local', 'Local'],
    ['mcp', 'MCP'],
    ['openai', 'OpenAI'],
    ['remote', 'Remote'],
    ['sdk', 'SDK'],
    ['server', 'Server'],
]);

function looksMachineFormatted(value: string): boolean {
    return /[:/_-]/.test(value) || /[a-z][A-Z]/.test(value);
}

function splitUsageLabelTokens(value: string): string[] {
    return value
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[:/_\-\s]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
}

function titleCaseUsageToken(token: string): string {
    const lower = token.toLowerCase();
    const known = usageTokenLabels.get(lower);
    if (known) {
        return known;
    }
    if (lower.startsWith('open') && lower.length > 'open'.length) {
        return `Open${lower.charAt(4).toUpperCase()}${lower.slice(5)}`;
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function humanizeUsageMachineLabel(value: string): string {
    const tokens = splitUsageLabelTokens(value);
    if (tokens.length === 0) {
        return value;
    }

    return tokens
        .map((token) => titleCaseUsageToken(token))
        .filter((token, index, items) => index === 0 || token.toLowerCase() !== items[index - 1]?.toLowerCase())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function formatUsageDimensionLabel(
    dimension: 'backendMode' | 'source',
    key: string,
    label?: string | null,
): string {
    const normalizedLabel = normalizeUsageLabel(label);
    const normalizedKey = normalizeUsageLabel(key) ?? key;
    const candidate = normalizedLabel ?? normalizedKey;

    if (!looksMachineFormatted(candidate)) {
        return candidate;
    }

    const humanized = humanizeUsageMachineLabel(candidate);
    if (humanized.length > 0) {
        return humanized;
    }

    return candidate;
}
