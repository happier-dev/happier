import type { UsageAnalyticsBreakdownDimension } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { getAgentStaticModels } from '@happier-dev/agents';
import { canonicalUsageModelPriceId } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { isUnattributedUsageAgentId } from '@happier-dev/protocol/usage/usageFormatting';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { formatUsageDimensionLabel } from '@/sync/api/account/formatUsageDimensionLabel';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

const SOURCE_LABEL_KEYS = {
    'claude-assistant-usage': 'usage.board.page.sourceClaudeResponses',
    'claude-sdk-result': 'usage.board.page.sourceClaudeSessionSummaries',
    accounting: 'usage.board.page.sourceAccounting',
    quota: 'usage.board.page.sourceQuota',
    work: 'usage.board.page.sourceWork',
    how_you_work: 'usage.board.page.sourceHowYouWork',
    comparison: 'usage.board.page.sourceComparison',
    legacy: 'usage.board.page.sourceAccounting',
    legacy_usage_report: 'usage.board.page.sourceAccounting',
    runtime: 'usage.board.page.sourceAccounting',
    native: 'usage.board.page.sourceAccounting',
} as const;

const SOURCE_AGENTS: Readonly<Record<string, string>> = {
    'claude-assistant-usage': 'claude',
    'claude-sdk-result': 'claude',
    'codex-app-server-token-usage': 'codex',
    'codex-native-accounting': 'codex',
    'pi-native-accounting': 'pi',
    'opencode-native-accounting': 'opencode',
};

/** The Agent an ingestion source belongs to, where the source names one; identity stays the key. */
export function usageSourceAgentId(source: string): string | null {
    const known = SOURCE_AGENTS[source];
    if (known) return known;
    const colon = source.indexOf(':');
    return colon > 0 ? source.slice(colon + 1) : null;
}

export function usageSourceTitle(source: string, fallback?: string): string {
    const display = fallback?.trim();
    // A humanized ingestion id is still an ingestion id, not a contributed title.
    const providedTitle = display && display.toLowerCase() !== source.toLowerCase()
        && display.toLowerCase() !== formatUsageDimensionLabel('source', source).toLowerCase() ? display : undefined;
    const key = SOURCE_LABEL_KEYS[source as keyof typeof SOURCE_LABEL_KEYS];
    if (key) return providedTitle ?? t(key);
    const agentId = SOURCE_AGENTS[source];
    if (agentId) return providedTitle ?? `${t('usage.board.page.sourceAccounting')} · ${usageAgentTitle(agentId)}`;
    if (providedTitle) return providedTitle;
    const colon = source.indexOf(':');
    if (colon > 0) {
        const agentId = source.slice(colon + 1);
        const agent = usageAgentTitle(agentId);
        if (agent !== agentId) return `${usageSourceTitle(source.slice(0, colon))} · ${agent}`;
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
    if (dimension === 'model') {
        const modelId = canonicalUsageModelPriceId(key);
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
