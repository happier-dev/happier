function isValidUsageNumber(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
}

function trimTrailingZero(value: string): string {
    return value.endsWith('.0') ? value.slice(0, -2) : value;
}

export function formatTokenCount(value: number): string {
    if (!isValidUsageNumber(value)) return '—';

    const count = Math.trunc(value);
    if (count >= 1_000_000_000) {
        return `${trimTrailingZero((count / 1_000_000_000).toFixed(1))}B`;
    }
    if (count >= 1_000_000) {
        return `${trimTrailingZero((count / 1_000_000).toFixed(1))}M`;
    }
    if (count >= 1_000) {
        return `${trimTrailingZero((count / 1_000).toFixed(1))}k`;
    }
    return String(count);
}

export function formatTokenCountLong(value: number): string {
    if (!isValidUsageNumber(value)) return '—';
    return new Intl.NumberFormat().format(Math.trunc(value));
}

export function formatUsageCost(usd: number, currency: string): string {
    if (!isValidUsageNumber(usd)) return '—';

    const maximumFractionDigits = usd < 1 ? 4 : 2;
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits,
        }).format(usd);
    } catch {
        return `${currency} ${usd.toFixed(maximumFractionDigits)}`;
    }
}

export function formatPercent(value: number): string {
    if (!isValidUsageNumber(value)) return '—';
    return `${trimTrailingZero(value.toFixed(1))}%`;
}

/**
 * Identifier-friendly display form for model/agent ids (R-DESIGN D-4/D-7):
 * short trailing segments are joined with a non-breaking hyphen (U+2011) so
 * wrapping never orphans a tiny tail ("claude-fable-\n5" → "claude-\nfable‑5").
 */
export function formatIdentifierLabel(value: string): string {
    return value.replace(/-(?=[^-]{1,3}$)/, '‑');
}
