/** Primary vendor documentation re-read on this date; tariffs stay in U10's price catalog. */
const asOf = '2026-10-10';
const docs = (url: string) => ({ url, sourceKind: 'vendor_docs' as const, asOf });
export const COACH_VENDOR_FACTS = {
    cache: { citation: docs('https://platform.claude.com/docs/en/build-with-claude/prompt-caching'),
        shortTtlMs: 5 * 60_000, longTtlMs: 60 * 60_000, longWriteMultiplier: 2 },
    requestCache: { citation: { ...docs('https://developers.openai.com/api/docs/guides/prompt-caching'), asOf: '2026-11-01' },
        gpt56MinTtlMs: 30 * 60_000,
        gpt56MinTtlQualification: {
            minimumModelVersion: { major: 5, minor: 6 },
            route: { authType: 'chatgpt', modelProvider: 'openai' },
            citation: { sourceKind: 'happier_live_probe', asOf: '2026-11-01',
                evidencePath: '.project/plans/2026-11-01-idle-compaction/evidence/IMPL-OTHERS/codex-route-probe.jsonl' },
        } },
    costs: { citation: docs('https://code.claude.com/docs/en/costs'), behaviorFlagShare: 0.1 },
    mcp: { citation: docs('https://code.claude.com/docs/en/mcp'), deferredDefinitionContextShare: 0.1 },
    compaction: { citation: { url: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
        sourceKind: 'vendor_changelog' as const, asOf }, immediateRefillsInARow: 3 },
    corrections: { citation: docs('https://code.claude.com/docs/en/best-practices'), moreThanTwice: 2 },
    pricing: { citation: docs('https://platform.claude.com/docs/en/about-claude/pricing'),
        haiku55LongPromptTokens: 100_000, haiku55LongPromptMultiplier: 5 },
    reasoning: { citation: docs('https://developers.openai.com/api/docs/guides/reasoning'),
        experimentalHeadroomTokens: 25_000 },
} as const;

export const COACH_RESEARCH_SOURCES = {
    agentDiet: { url: 'https://arxiv.org/abs/2509.23586', sourceKind: 'research_paper' as const, asOf },
    swePruner: { url: 'https://arxiv.org/abs/2601.16746', sourceKind: 'research_paper' as const, asOf },
    modelEvaluation: { url: 'https://arxiv.org/abs/2407.01502', sourceKind: 'research_paper' as const, asOf },
} as const;

/** Vendor durations and evidenced qualifications; Agents map their native route/model facts. */
export const PROMPT_CACHE_DURATIONS = {
    anthropic: { shortTtlMs: COACH_VENDOR_FACTS.cache.shortTtlMs, longTtlMs: COACH_VENDOR_FACTS.cache.longTtlMs },
    openai: { gpt56MinTtlMs: COACH_VENDOR_FACTS.requestCache.gpt56MinTtlMs,
        gpt56MinTtlQualification: COACH_VENDOR_FACTS.requestCache.gpt56MinTtlQualification },
} as const;
