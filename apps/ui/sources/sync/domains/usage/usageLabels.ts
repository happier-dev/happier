import type { UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { getAgentStaticModels } from '@happier-dev/agents';
import { canonicalUsageModelPriceId } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { isUnattributedUsageAgentId } from '@happier-dev/protocol/usage/usageFormatting';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { listProjectedAgentUiBehaviorIds } from '@/agents/registry/agentUiBehaviorProjection';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { formatUsageDimensionLabel } from '@/sync/api/account/formatUsageDimensionLabel';
import { getTranslationValue, t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

const SOURCE_LABEL_KEYS = {
    accounting: 'usage.board.page.sourceAccounting',
    quota: 'usage.board.page.sourceQuota',
    work: 'usage.board.page.sourceWork',
    how_you_work: 'usage.board.page.sourceHowYouWork',
    comparison: 'usage.board.page.sourceComparison',
    legacy: 'usage.board.page.sourceAccounting',
    legacy_usage_report: 'usage.board.page.sourceAccounting',
    runtime: 'usage.board.page.sourceAccounting',
    native: 'usage.board.page.sourceAccounting',
    // The host's own ACP runtime captures (apps/cli agent/acp/usage), named for what they are, not as event ids.
    'acp-usage-update': 'usage.board.page.sourceAgentUsageUpdates',
    'acp-session-update-usage': 'usage.board.page.sourceAgentSessionUsage',
    'acp-prompt-usage': 'usage.board.page.sourceAgentPromptUsage',
} as const;

function readDeclaredAccountingSource(source: string) {
    for (const agentId of new Set([...AGENT_IDS, ...listProjectedAgentUiBehaviorIds()])) {
        const declaration = resolveAgentUiBehavior(agentId).accountingSourcePresentation?.find(row => row.sourceId === source);
        if (declaration) return { agentId, declaration };
    }
    return null;
}

/** The Agent an ingestion source belongs to, where the source names one; identity stays the key. */
export function usageSourceAgentId(source: string): string | null {
    const known = readDeclaredAccountingSource(source);
    if (known) return known.agentId;
    const colon = source.indexOf(':');
    return colon > 0 ? source.slice(colon + 1) : null;
}

export function usageSourceTitle(source: string, fallback?: string, presentation?: 'coverage'): string {
    const display = fallback?.trim();
    // A humanized ingestion id is still an ingestion id, not a contributed title.
    const providedTitle = display && display.toLowerCase() !== source.toLowerCase()
        && display.toLowerCase() !== formatUsageDimensionLabel('source', source).toLowerCase() ? display : undefined;
    const key = SOURCE_LABEL_KEYS[source as keyof typeof SOURCE_LABEL_KEYS];
    if (key) {
        if (providedTitle) return providedTitle;
        if (presentation === 'coverage') {
            if (key === 'usage.board.page.sourceAccounting') return t('usage.board.page.sourceAgentSessionUsage');
            if (key === 'usage.board.page.sourceAgentPromptUsage') return t('usage.board.page.sourceAgentUsageUpdates');
        }
        return t(key);
    }
    const declared = readDeclaredAccountingSource(source);
    if (declared) {
        if (providedTitle) return providedTitle;
        // Coverage lists one row per Agent with how its usage is known; the capture's own name stays its detail.
        if (presentation === 'coverage') return usageAgentTitle(declared.agentId);
        const { title, translatedTitle } = declared.declaration;
        if (typeof title === 'string') return title;
        if (translatedTitle) return resolvePluginLocalizedStringV2Text(title, translatedTitle);
        const translation = getTranslationValue(title.key);
        return resolvePluginLocalizedStringV2Text(title, typeof translation === 'string' ? translation : undefined);
    }
    if (providedTitle) return providedTitle;
    const colon = source.indexOf(':');
    if (colon > 0) {
        const agentId = source.slice(colon + 1);
        const agent = usageAgentTitle(agentId);
        if (agent !== agentId) return presentation === 'coverage' ? agent : `${usageSourceTitle(source.slice(0, colon))} · ${agent}`;
    }
    return formatUsageDimensionLabel('source', source, fallback ?? source.replace(/^[a-z]/, letter => letter.toUpperCase()));
}

const agentEntries = new Map<string, ReturnType<typeof resolveAgentCatalogProjection>>();
function readAgentEntry(agentId: string) {
    let entry = agentEntries.get(agentId);
    if (!entry) { entry = resolveAgentCatalogProjection(agentId, { enabledAgentIds: [] }); agentEntries.set(agentId, entry); }
    return entry;
}

/** Contributed titles stay exact; the catalog's generated unknown fallback uses Usage's label owner. */
export function usageAgentTitle(agentId: string, fallback?: string): string {
    const display = fallback?.trim();
    const providedTitle = display && display.toLowerCase() !== agentId.toLowerCase()
        && display.toLowerCase() !== formatUsageDimensionLabel('source', agentId).toLowerCase() ? display : undefined;
    // The scalar-report bridge records 'legacy' because its Agent was not recorded.
    if (isUnattributedUsageAgentId(agentId)) return t('usage.board.page.unattributed');
    try {
        const entry = readAgentEntry(agentId);
        if (entry.title && (entry.catalogAgentId !== null || entry.identity !== null)) return entry.title;
        return providedTitle || formatUsageDimensionLabel('source', agentId, entry.title || undefined);
    } catch {
        return providedTitle || formatUsageDimensionLabel('source', agentId);
    }
}

/** Shared label projection for accounting dimensions; identity remains the unchanged key. */
export function usageDimensionLabel(dimension: UsageAnalyticsBreakdownDimension, key: string, label?: string,
    machineNames?: ReadonlyMap<string, string>): string {
    if (dimension === 'agent') return usageAgentTitle(key, label);
    if (dimension === 'machine') return machineNames?.get(key) ?? getMachineDisplayName({ id: key, absence: 'unlisted' });
    if (dimension === 'source') return usageSourceTitle(key, label);
    if (dimension !== 'model' && dimension !== 'backendMode') return label ?? key;
    // An engine that is an Agent (`codex`) is named as that Agent, never by its raw id.
    if (dimension === 'backendMode' && (AGENT_IDS as readonly string[]).includes(key)) return usageAgentTitle(key, label);
    if (dimension === 'model') {
        if (key === 'unknown') return t('usage.board.plans.cellUnknown');
        const modelId = canonicalUsageModelPriceId(key);
        if (modelId === null) return t('usage.board.page.unattributed');
        for (const agentId of AGENT_IDS) {
            const model = getAgentStaticModels(agentId, { catalogOnly: true }).find(model => model.id === modelId || model.extendedContextModelId === modelId);
            if (model) return model.name;
        }
    }
    if (!key || key === 'unknown') return label && label !== key ? label : t('usage.board.page.unattributed');
    const display = label?.trim();
    if (display && display !== key && display !== formatUsageDimensionLabel('source', key)) return display;
    // An unknown model id is its exact fallback, not a name invented by title casing.
    return dimension === 'model' ? key : formatUsageDimensionLabel('source', key);
}
