import { t } from '@/text';
import type { UsageCostMode, UsageDimension, UsagePivotDimension } from '@/sync/api/account/usageAnalytics';

export function formatCount(value: number): string {
    return value.toLocaleString();
}

/**
 * Identifier-friendly display form for model/agent ids (R-DESIGN D-4/D-7):
 * short trailing segments are joined with a non-breaking hyphen (U+2011) so
 * wrapping never orphans a tiny tail ("claude-fable-\n5" → "claude-\nfable‑5").
 */
export function formatIdentifierLabel(value: string): string {
    return value.replace(/-(?=[^-]{1,3}$)/, '‑');
}

export function resolveCostModeLabel(mode: UsageCostMode): string {
    if (mode === 'reported') return t('usage.reported');
    if (mode === 'estimated') return t('usage.estimated');
    return t('usage.auto');
}

export function dimensionLabel(dimension: UsageDimension | UsagePivotDimension): string {
    switch (dimension) {
        case 'agent':
            return t('settingsAgents.title');
        case 'model':
            return t('settingsAgents.models');
        case 'session':
            return t('settings.sessions');
        case 'project':
            return t('tabs.projects');
        case 'workspace':
            return t('settings.workspaces');
        case 'backendMode':
            return t('usage.summary.engine');
        case 'source':
            return t('usage.source');
        case 'week':
            return t('usage.weeks');
    }
}
