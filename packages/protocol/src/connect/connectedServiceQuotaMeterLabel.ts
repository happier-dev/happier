const USAGE_WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
    five_hour: '5-hour',
    seven_day: 'Weekly',
    seven_day_all: 'Weekly (all models)',
    seven_day_oauth_apps: 'Weekly (OAuth apps)',
    seven_day_sonnet: 'Weekly (Sonnet)',
    seven_day_opus: 'Weekly (Opus)',
    spend: 'Spend',
    iguana_necktie: 'Unknown',
});

const WINDOW_LABEL_PREFIXES = [
    { prefix: 'five_hour_', label: '5-hour' },
    { prefix: 'seven_day_', label: 'Weekly' },
] as const;

const WINDOW_LABEL_TOKEN_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
    api: 'API',
    fable: 'Fable',
    mcp: 'MCP',
    oauth: 'OAuth',
    opus: 'Opus',
    sonnet: 'Sonnet',
});

function humanizeWindowLabel(raw: string): string {
    return raw
        .split(/[_-]+/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
        .map((part) => Object.prototype.hasOwnProperty.call(WINDOW_LABEL_TOKEN_OVERRIDES, part)
            ? WINDOW_LABEL_TOKEN_OVERRIDES[part]!
            : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(' ');
}

/** Shared by usage producers and display projections, including retained raw-label snapshots. */
export function resolveConnectedServiceQuotaMeterLabel(meterId: string, label?: string | null): string {
    const displayLabel = label?.trim();
    const id = meterId.trim();
    // Provider-supplied display names carry meaning that the technical id need not capture.
    if (displayLabel && displayLabel !== id && !displayLabel.includes('_')) return displayLabel;
    const known = Object.prototype.hasOwnProperty.call(USAGE_WINDOW_LABELS, id) ? USAGE_WINDOW_LABELS[id] : undefined;
    if (known) return known;
    for (const { prefix, label: windowLabel } of WINDOW_LABEL_PREFIXES) {
        if (id.startsWith(prefix)) {
            const suffix = humanizeWindowLabel(id.slice(prefix.length));
            return suffix ? `${windowLabel} (${suffix})` : windowLabel;
        }
    }
    return humanizeWindowLabel(displayLabel || id);
}
