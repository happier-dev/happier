import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { selectLatestUsageMcpBindingWindows } from './usageMcpBindingUsage.js';
import { resolveUsageCostBasis, createUsageModelCostEstimator } from '../usageCost.js';
import { bundledUsageModelPriceCatalog, LITELLM_MODEL_PRICE_URL } from '../usageModelPriceCatalog.js';
import { COACH_VENDOR_FACTS as facts, COACH_RESEARCH_SOURCES as research } from './coachVendorFacts.js';
import { UsageRequestAttributionSchema } from '../usageAnalyticsContracts.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { selectUsageWorkPermissions } from '../usageWorkIntervals.js';
import { summarizeUsageExecutionSources } from '../usageSourceSummary.js';
import { UsageCoachPreferencesV1Schema, type UsageCoachPreferencesV1 } from '../../account/settings/usageCoachPreferencesV1.js';
import { USAGE_COACH_DETECTOR_IDS, USAGE_COACH_REQUIRED_EVIDENCE, type UsageCoachCapability, type UsageCoachEvaluation,
    type UsageCoachEvaluationInput, type UsageCoachConceptEvaluation, type UsageCoachDetectorId, type UsageCoachFinding,
    type UsageCoachAdmittedRemedy, type UsageCoachNativeCacheFact } from './coachFinding.js';

export function applyUsageCoachPreferences(evaluation: UsageCoachEvaluation, preferences: Pick<UsageCoachPreferencesV1, 'suppressions'>,
    nowMs: number): UsageCoachEvaluation {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Invalid usage preference observation time');
    const suppressions = new Map(preferences.suppressions.map(row => [row.evidenceKey, row]));
    const evaluations = evaluation.evaluations.map(row => {
        if (row.status !== 'finding') return row;
        const suppression = suppressions.get(row.finding.evidenceKey);
        const dismissed = suppression?.kind === 'dismissed';
        const snoozedUntilMs = suppression?.kind === 'snoozed' && suppression.untilMs > nowMs ? suppression.untilMs : null;
        if (row.finding.state.dismissed === dismissed && row.finding.state.snoozedUntilMs === snoozedUntilMs) return row;
        return { ...row, finding: { ...row.finding, state: { ...row.finding.state,
            dismissed, snoozedUntilMs,
        } } };
    });
    if (evaluations.every((row, index) => row === evaluation.evaluations[index])) return evaluation;
    return { ...evaluation, evaluations,
        findings: evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []) };
}

/** Supported owner effects attach only to the exact observed evidence, never by detector id alone. */
export function admitUsageCoachRemedies(evaluation: UsageCoachEvaluation, admittedRemedies: readonly UsageCoachAdmittedRemedy[]): UsageCoachEvaluation {
    if (evaluation.currentness !== 'current' || admittedRemedies.length === 0) return evaluation;
    const evaluations = evaluation.evaluations.map(row => {
        if (row.status !== 'finding') return row;
        const evidenceIds = [...new Set(row.finding.evidence.map(ref => ref.id))].sort();
        const remedies = admittedRemedies.filter(proposal => proposal.detectorId === row.detectorId
            && JSON.stringify([...new Set(proposal.evidenceIds)].sort()) === JSON.stringify(evidenceIds));
        // Ambiguous owner proposals grant no Apply. The Action owner revalidates at execution.
        const remedy = remedies.length === 1 ? remedies[0]!.remedy : null;
        return { ...row, finding: { ...row.finding, remedy,
            action: remedy ? { actionId: 'usage.coach.apply' as const, detectorId: row.detectorId, evidenceKey: row.finding.evidenceKey } : null } };
    });
    return { ...evaluation, evaluations,
        findings: evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []) };
}

export function evaluateUsageCoach(input: UsageCoachEvaluationInput): UsageCoachEvaluation {
    // A failed Account read is not evidence that the user enabled every check.
    const preferences = input.preferences === null ? null : UsageCoachPreferencesV1Schema.parse(input.preferences ?? {});
    const enabled = (id: UsageCoachDetectorId) => preferences !== null && !preferences.disabledChecks.includes(id)
        && (id !== 'model_misfit' || preferences.modelSuggestion !== 'off');
    const inPeriod = (instant: number) => Number.isSafeInteger(instant) && instant >= input.period.startMs
        && instant < input.period.endMs && (input.asOfMs === null || instant <= input.asOfMs);
    const detail = preferences === null || input.detail?.coverage === 'unknown' ? undefined : input.detail;
    const complete = detail?.coverage === 'complete';
    const unique = <T extends { evidenceId: string; observedAtMs: number }>(values: readonly T[]) =>
        [...new Map(values.filter(row => inPeriod(row.observedAtMs)).map(row => [row.evidenceId, row])).values()];
    const insufficient = (detectorId: UsageCoachDetectorId, capability: UsageCoachCapability): UsageCoachConceptEvaluation =>
        ({ detectorId, requiredEvidence: [capability], status: 'insufficient_evidence', missingEvidence: [capability] });
    const negative = (detectorId: UsageCoachDetectorId, capability: UsageCoachCapability, covered: boolean): UsageCoachConceptEvaluation =>
        covered ? { detectorId, requiredEvidence: [capability], status: 'no_finding' } : insufficient(detectorId, capability);
    const basis = (id: UsageCoachDetectorId): UsageCoachFinding['basis'] => {
        switch (id) {
            case 'duplicated_instructions': return { method: 'exact_duplicate_injection_v1', kind: 'observation',
                citations: [facts.costs.citation, research.agentDiet], limitations: ['Exact repeated bytes do not establish quality harm or dollar savings.'],
                advice: ['Remove exact duplicate instructions. Claude Code recommends concise CLAUDE.md files; its auto-memory loading limit is not a universal instruction-size limit.'] };
            case 'model_misfit': return { method: 'matched_completed_host_request_n1_v1', kind: 'observation',
                citations: [research.modelEvaluation, facts.requestCache.citation],
                limitations: ['n=1 observed pair, not a task-suitability verdict. Completion is not a quality label.',
                    'Partial accounting and unknown response attribution may confound this comparison. Cache-rebuild adjustment is not available.'],
                advice: ['Validate the outcome before choosing a model. A mid-session model switch rebuilds its cache; compare current-context tokens × candidate cache-write rate against future observed savings, rather than treating the raw difference as net savings.'] };
            case 'idle_recaching':
            case 'cache_busting_prompt_changes':
            case 'cache_economics': return { method: 'request_ttl_cache_economics_v1', kind: 'derived',
                citations: [facts.cache.citation, facts.costs.citation, facts.requestCache.citation],
                limitations: ['No universal cache-hit target. The spend-share warning borrows the vendor behavior-flag convention, not a research cutoff.',
                    'Expected compaction, tool clearing and deliberate model/effort rebuilds are excluded. Missing request causes or prices cannot establish waste.'],
                advice: ['Use the request’s actual TTL, not a provider-wide default. Where supported, compare 1h versus 5m caching: avoided expiries per write must exceed (1h write rate − 5m write rate) / (5m write rate − read rate). Use the model’s catalog read rate, not a universal read multiplier.'] };
            case 'approval_friction': return { method: 'permission_wait_request_ttl_v1', kind: 'derived',
                citations: [facts.costs.citation], limitations: ['A wait is cost-linked only when it reaches the witnessed active TTL; this is not a proven cache miss or wasted approval.'],
                advice: ['Review consistently allowed operations for an appropriate allowlist or sandbox. Preserve meaningful approvals.'] };
            case 'mcp_overhead': return { method: 'witnessed_mcp_definition_loading_v1', kind: 'vendor_fact',
                citations: [facts.mcp.citation], limitations: ['Unused bindings alone are informational. No assumed tokens-per-tool or dollar saving.',
                    'The context-share threshold is Claude Code tool-search policy, not a research harm threshold.'],
                advice: ['Prefer deferred definitions where supported; review measured upfront schemas and unused bindings.'] };
            case 'repeated_file_reads': return { method: 'unchanged_selection_without_compaction_v1', kind: 'observation',
                citations: [research.agentDiet, research.swePruner], limitations: ['No token-cost estimate without measured read content carried through later requests.'],
                advice: ['Review exact unchanged redundant reads; changed files and reads following compaction are not counted.'] };
            case 'compaction_storms': return { method: 'three_immediate_compaction_refills_v1', kind: 'vendor_fact',
                citations: [facts.compaction.citation, facts.costs.citation], limitations: ['Requires native immediate-refill evidence, not two compaction events or an invented time/turn window.'],
                advice: ['Investigate context that refills to its limit immediately after compaction. Normal compaction is expected.'] };
            case 'anomalous_looping_usage': return { method: 'identical_failures_guidance_v1', kind: 'guidance_derived',
                citations: [facts.corrections.citation], limitations: ['Three consecutive identical failed operations with identical errors and no progress adapt “corrected more than twice”; this is guidance-derived, not a measured optimum.'],
                advice: ['Change the approach after repeated identical failures. No state change or successful intervening operation may be ignored.'] };
            case 'context_bloat': return { method: 'observed_request_context_growth_cost_v1', kind: 'derived',
                citations: [facts.costs.citation, facts.pricing.citation, facts.reasoning.citation],
                limitations: ['No universal long-context or quality-degradation threshold. Request counts and normalized, nonoverlapping tokens are required.'],
                advice: ['Show actual growing request context and cached-history cost. Clear between unrelated tasks or compact at natural breaks.',
                    `Haiku 5.5 prompts above ${facts.pricing.haiku55LongPromptTokens} tokens (including cache) have a ${facts.pricing.haiku55LongPromptMultiplier}× price step.`,
                    `For OpenAI reasoning models, the experimental guidance is to reserve at least ${facts.reasoning.experimentalHeadroomTokens} tokens for reasoning and output, then tune to observed workloads; it is not a universal trigger.`] };
            case 'outside_usage': return { method: 'witnessed_execution_accounting_v1', kind: 'observation',
                citations: [facts.costs.citation], limitations: ['Informational, not waste or savings. Vendor local dashboards exclude other devices and web usage.'], advice: [] };
            case 'effort_audit': return { method: 'recorded_request_effort_audit_v1', kind: 'observation',
                citations: [facts.costs.citation, facts.reasoning.citation, facts.requestCache.citation],
                limitations: ['Recorded effort is required. Thinking/output share has no research-backed waste cutoff.'],
                advice: ['Compare outcomes before lowering effort. Set effort at session start where possible; changes can rebuild the cache on affected models.'] };
            case 'subagent_fanout': return { method: 'observed_subagent_token_breakdown_v1', kind: 'observation',
                citations: [facts.requestCache.citation, facts.costs.citation], limitations: ['Token fan-out is informational, not waste; parallelism may improve outcomes.'],
                advice: ['Inspect parent and subagent token shares. Ordinary subagents have independent caches; forks may reuse their parent prefix.'] };
        }
    };
    const finding = (detectorId: UsageCoachDetectorId, capability: UsageCoachCapability,
        summaryCode: UsageCoachFinding['summaryCode'], evidence: UsageCoachFinding['evidence'], measurements: UsageCoachFinding['measurements'],
        coverage: UsageCoachFinding['coverage'] = detail?.coverage ?? 'partial',
        modelComparison?: UsageCoachFinding['modelComparison'],
        classification: UsageCoachFinding['classification'] = 'informational',
        details: Pick<UsageCoachFinding, 'cacheCauses' | 'evidenceSeries'> = {}): UsageCoachConceptEvaluation => {
        // Suppression/remedy identity remains independent of presentation chronology.
        const identityEvidence = [...evidence].sort((a, b) => a.id.localeCompare(b.id) || a.observedAtMs - b.observedAtMs);
        evidence.sort((a, b) => a.observedAtMs - b.observedAtMs || a.id.localeCompare(b.id));
        const evidenceBasis = basis(detectorId);
        if (measurements.some(row => row.unit === 'currency' && row.costKind === 'api_equivalent')) {
            const catalog = input.accounting?.priceCatalog ?? bundledUsageModelPriceCatalog;
            const priceDate = new Date(catalog.provenance.asOfMs);
            if (Number.isFinite(priceDate.getTime())) evidenceBasis.citations.push({ url: LITELLM_MODEL_PRICE_URL,
                sourceKind: 'price_catalog', asOf: priceDate.toISOString().slice(0, 10) });
            evidenceBasis.limitations.push(`API-equivalent pricing uses U10 catalog ${catalog.provenance.revision}; not an invoice or plan-quota conversion.`);
        }
        // The requested query key already identifies its range/calendar. An open
        // query's witnessed display end advances without changing these facts.
        // Presentation samples reuse this finding's evidence; adding a chart does not retire its dismissal or remedy identity.
        const { evidenceSeries: _evidenceSeries, ...evidenceDetails } = details;
        const evidenceKey = computeCanonicalDomainSeparatedDigest('happier.usage.coach.finding.v1',
            [detectorId, input.queryKey, summaryCode, JSON.stringify(identityEvidence), JSON.stringify(measurements),
                evidenceBasis.method, classification, JSON.stringify(evidenceDetails),
                ...(modelComparison ? [JSON.stringify(modelComparison)] : [])]);
        const state = input.findingStates?.find(row => row.detectorId === detectorId && row.evidenceKey === evidenceKey)?.state
            ?? { dismissed: false, snoozedUntilMs: null, applied: null };
        return { detectorId, requiredEvidence: [capability], status: 'finding', finding: {
            detectorId, evidenceKey, queryKey: input.queryKey, period: input.period, asOfMs: input.asOfMs,
            currentness: input.currentness, coverage, severity: classification === 'cost_linked' ? 'warning' : 'info',
            classification, basis: evidenceBasis, summaryCode, evidence, measurements, remedy: null,
            action: null, state, ...details, ...(modelComparison ? { modelComparison } : {}),
        } };
    };
    const ref = (kind: UsageCoachFinding['evidence'][number]['kind'], row: { evidenceId: string; observedAtMs: number }) =>
        ({ kind, id: row.evidenceId, observedAtMs: row.observedAtMs });
    const series = (metric: UsageCoachFinding['measurements'][number]['metric'],
        unit: UsageCoachFinding['measurements'][number]['unit'],
        points: NonNullable<UsageCoachFinding['evidenceSeries']>[number]['points']) => ({ metric, unit,
        points: points.sort((a, b) => a.observedAtMs - b.observedAtMs || a.evidenceId.localeCompare(b.evidenceId)) });
    const usesComposition = enabled('duplicated_instructions') || enabled('cache_busting_prompt_changes') || enabled('idle_recaching') || enabled('cache_economics');
    const composition = !usesComposition || input.composition === undefined ? undefined
        : unique(input.composition);
    const fullComposition = input.compositionCoverage === 'complete' && composition !== undefined
        && composition.every(row => row.coverage === 'complete_native');
    // The two retained preference ids are cause views of this ONE cache analysis.
    // Unknown rebuilds can explain a miss, but cannot be priced as avoidable waste.
    const cacheEnabled = enabled('idle_recaching') || enabled('cache_busting_prompt_changes') || enabled('cache_economics');
    const cacheRows: UsageCoachNativeCacheFact[] = cacheEnabled && detail?.nativeCache ? unique(detail.nativeCache).map(row => ({ ...row })) : [];
    const seenCacheInputs = new Set(cacheRows.map(row => JSON.stringify([row.sessionId ?? null, row.inputId])));
    if (cacheEnabled && composition) {
        const previous = new Map<string, typeof composition[number]>();
        for (const row of [...composition].sort((a, b) => a.observedAtMs - b.observedAtMs || a.evidenceId.localeCompare(b.evidenceId))) {
            if (row.boundary !== 'agent_native_request' || row.coverage !== 'complete_native' || !row.nativePrefix || !row.inputId) continue;
            const before = previous.get(row.sessionId);
            const prefix = row.nativePrefix;
            const inputKey = JSON.stringify([row.sessionId, row.inputId]);
            if (!seenCacheInputs.has(inputKey)) cacheRows.push({
                evidenceId: row.evidenceId, observedAtMs: row.observedAtMs, inputId: row.inputId, boundary: 'agent_native_request',
                sessionId: row.sessionId, ...(row.turnId ? { turnId: row.turnId } : {}),
                ...(row.requestIdentity ? { modelId: row.requestIdentity.selection.modelId } : {}),
                cacheOutcome: prefix.cacheOutcome, missCause: prefix.missCause, cacheWriteTokens: prefix.cacheWriteTokens,
                idleMs: before ? row.observedAtMs - before.observedAtMs : null, ttlMs: prefix.ttlMs,
                prefixDigest: prefix.digest, previousPrefixDigest: before?.nativePrefix?.digest ?? null,
                rebuildCause: detail?.compactions?.some(compaction => compaction.sessionId === row.sessionId
                    && before && compaction.observedAtMs >= before.observedAtMs && compaction.observedAtMs <= row.observedAtMs)
                    ? 'compaction' : before?.requestIdentity && row.requestIdentity
                        && before.requestIdentity.selection.modelId !== row.requestIdentity.selection.modelId ? 'model_switch' : 'unknown',
            });
            seenCacheInputs.add(inputKey);
            previous.set(row.sessionId, row);
        }
    }
    const previousCacheRequest = new Map<string, number>();
    for (const row of [...cacheRows].sort((a, b) => a.observedAtMs - b.observedAtMs || a.evidenceId.localeCompare(b.evidenceId))) {
        if (!row.sessionId && !row.turnId) continue;
        const scope = JSON.stringify([row.sessionId ?? null, row.sessionId ? null : row.turnId]);
        const before = previousCacheRequest.get(scope) ?? input.period.startMs;
        if (detail?.compactions?.some(compaction => (row.sessionId ? compaction.sessionId === row.sessionId : compaction.turnId === row.turnId)
            && compaction.observedAtMs >= before && compaction.observedAtMs <= row.observedAtMs)) row.rebuildCause = 'compaction';
        previousCacheRequest.set(scope, row.observedAtMs);
    }
    const expectedRebuild = (row: UsageCoachNativeCacheFact) => row.rebuildCause !== undefined
        && row.rebuildCause !== 'unknown' && row.rebuildCause !== 'unexpected';
    const cacheCause = (row: UsageCoachNativeCacheFact) => {
        if (expectedRebuild(row) || row.cacheOutcome !== 'miss' || !row.cacheWriteTokens) return null;
        if (row.missCause === 'ttl_expired' && row.idleMs !== null && row.ttlMs !== undefined && row.ttlMs !== null
            && row.ttlMs > 0 && row.idleMs >= row.ttlMs) return 'idle_recaching';
        if (row.missCause === 'prefix_change' && row.prefixDigest && row.previousPrefixDigest
            && row.prefixDigest !== row.previousPrefixDigest) return 'cache_busting_prompt_changes';
        return null;
    };
    const usesPrices = cacheEnabled || enabled('context_bloat');
    const catalog = usesPrices ? input.accounting?.priceCatalog ?? bundledUsageModelPriceCatalog : bundledUsageModelPriceCatalog;
    const accountingRows = usesPrices && input.accounting?.contributions
        ? [...new Map(input.accounting.contributions.filter(row => inPeriod(row.observedAtMs)).map(row => [row.id, row])).values()] : undefined;
    const estimateCost = createUsageModelCostEstimator(catalog, input.pricingOverrides);
    const pricedRows = accountingRows?.map(row => {
        let price: ReturnType<typeof estimateCost> | undefined;
        return { row, get price() {
            if (price === undefined) price = row.tokenCategories ? estimateCost(row.modelId, row.tokenCategories) : null;
            return price;
        } };
    });
    const pricedRequests = new Map<string, NonNullable<typeof pricedRows>>();
    const requestKey = (sessionId: string, turnId: string, modelId: string) => JSON.stringify([sessionId, turnId, modelId]);
    for (const entry of cacheRows.length ? pricedRows ?? [] : []) {
        const row = entry.row;
        if (row.eventCount !== 1 || !row.sessionId || !row.turnId || !row.modelId) continue;
        const key = requestKey(row.sessionId, row.turnId, row.modelId);
        const matches = pricedRequests.get(key);
        if (matches) matches.push(entry); else pricedRequests.set(key, [entry]);
    }
    const cachePremium = (row: UsageCoachNativeCacheFact): number | null => {
        if (!cacheCause(row) || row.rebuildCause !== 'unexpected' || !row.sessionId || !row.turnId || !row.modelId) return null;
        const matches = pricedRequests.get(requestKey(row.sessionId, row.turnId, row.modelId)) ?? [];
        if (matches.length !== 1 || !matches[0]!.price || !matches[0]!.row.tokenCategories
            || matches[0]!.row.tokenCategories.cacheWrite !== row.cacheWriteTokens) return null;
        const rates = matches[0]!.price!.price.rates;
        let write = rates.cacheWriteUsdPerMillion;
        if (row.ttlMs === facts.cache.longTtlMs
            && catalog.models[matches[0]!.price!.price.modelId]?.provider === 'anthropic') {
            // U10's generic write tariff may describe 5m caching. Do not divide a
            // 1h premium by a 5m-priced total and invent a spend-share warning.
            if (write !== rates.inputUsdPerMillion * facts.cache.longWriteMultiplier) return null;
        } else if (row.ttlMs !== facts.cache.shortTtlMs) return null;
        return write === undefined || rates.cacheReadUsdPerMillion === undefined ? null
            : Math.max(0, row.cacheWriteTokens! * (write - rates.cacheReadUsdPerMillion) / 1_000_000);
    };
    const hasPricedCacheCause = cacheRows.some(row => cacheCause(row) !== null && row.rebuildCause === 'unexpected');
    const totalPricedCost = hasPricedCacheCause && pricedRows?.length && pricedRows.every(entry => entry.price !== null)
        ? pricedRows.reduce((sum, entry) => sum + entry.price!.total, 0) : null;
    const causeShare = (rows: readonly UsageCoachNativeCacheFact[]) => {
        const premiums = rows.map(cachePremium);
        if (!premiums.length || premiums.some(value => value === null) || totalPricedCost === null || totalPricedCost <= 0) return null;
        return premiums.reduce<number>((sum, value) => sum + value!, 0) / totalPricedCost;
    };

    const evaluations = USAGE_COACH_DETECTOR_IDS.map((id): UsageCoachConceptEvaluation => {
        const capability = USAGE_COACH_REQUIRED_EVIDENCE[id][0];
        if (preferences === null) return insufficient(id, capability);
        if (!enabled(id)) return { detectorId: id, requiredEvidence: [capability], status: 'disabled' };
        switch (id) {
            case 'duplicated_instructions': {
                if (!composition) return insufficient(id, capability);
                let duplicateCount = 0;
                let duplicateBytes = 0;
                const evidence: UsageCoachFinding['evidence'] = [];
                const points: NonNullable<UsageCoachFinding['evidenceSeries']>[number]['points'] = [];
                for (const row of composition) {
                    const seen = new Set<string>();
                    let duplicate = false;
                    let rowDuplicateBytes = 0;
                    for (const component of row.components) {
                        if (component.kind !== 'instructions' || component.overlap !== 'none' || component.byteLength === 0) continue;
                        const key = JSON.stringify([component.digest, component.location, component.byteLength]);
                        if (seen.has(key)) { duplicateCount += 1; duplicateBytes += component.byteLength;
                            rowDuplicateBytes += component.byteLength; duplicate = true; }
                        seen.add(key);
                    }
                    if (duplicate) { evidence.push(ref('composition', row));
                        points.push({ evidenceId: row.evidenceId, observedAtMs: row.observedAtMs, value: rowDuplicateBytes }); }
                }
                if (duplicateCount) return finding(id, capability, 'duplicate_injection_observed', evidence,
                    [{ metric: 'duplicate_injections', value: duplicateCount, unit: 'count' },
                        { metric: 'duplicate_bytes', value: duplicateBytes, unit: 'bytes' }], fullComposition ? 'complete' : 'partial',
                    undefined, 'informational', { evidenceSeries: [series('duplicate_bytes', 'bytes', points)] });
                return negative(id, capability, fullComposition && composition.every(row => row.components.every(component =>
                    component.kind !== 'instructions' || component.overlap === 'none')));
            }
            case 'model_misfit': {
                // Native accounting does not certify whole-request cost completeness. An exhausted
                // history page is not that certificate; complete-only must remain insufficient.
                if (preferences.modelSuggestion === 'complete_only') return insufficient(id, capability);
                if (detail?.modelRequests && input.accounting?.contributions) {
                    const requests = unique(detail.modelRequests.filter(row => inPeriod(row.startedAtMs)));
                    if (!requests.length) return insufficient(id, capability);
                    const contributionsBySession = new Map<string | null, Map<string | null, Map<string, (typeof input.accounting.contributions)[number]>>>();
                    for (const row of input.accounting.contributions) {
                        let turns = contributionsBySession.get(row.sessionId);
                        if (!turns) contributionsBySession.set(row.sessionId, turns = new Map());
                        let contributions = turns.get(row.turnId);
                        if (!contributions) turns.set(row.turnId, contributions = new Map());
                        contributions.set(row.id, row);
                    }
                    const priced = requests.flatMap(request => {
                        const selection = request.requestIdentity.selection;
                        if (selection.modelId === 'default' || selection.modelId === 'automatic') return [];
                        const contributions = [...(contributionsBySession.get(request.sessionId)?.get(request.turnId)?.values() ?? [])];
                        if (!contributions.length || contributions.some(row => !inPeriod(row.observedAtMs)
                            || row.observedAtMs < request.startedAtMs || row.observedAtMs > request.observedAtMs
                            || row.modelId !== selection.modelId
                            || row.providerAttribution === 'known' && row.providerConnectionId !== selection.providerConnectionId)) return [];
                        const costs = contributions.map(row => resolveUsageCostBasis(row.cost, 'auto'));
                        const basis = costs[0];
                        if (!basis || basis.kind === 'mixed' || costs.some(cost => !cost || cost.kind !== basis.kind || cost.currency !== basis.currency)) return [];
                        // Consume the host-captured AMEND-2 identity, never current Session binding
                        // dimensions. Mixed or missing source evidence remains explicitly unknown.
                        const sources = contributions.map(row => {
                            const source = row.providerAttribution !== 'known' ? undefined : row.providerSource === 'native'
                                ? { kind: 'native', connectedAccount: row.connectedAccount ?? null }
                                : row.providerSource === 'provider' ? { kind: 'provider', providerId: row.providerId ?? null,
                                    providerConnectionId: row.providerConnectionId } : undefined;
                            const parsed = UsageRequestAttributionSchema.shape.source.safeParse(source);
                            return parsed.success ? parsed.data : undefined;
                        });
                        const responseSource = sources[0] && sources.every(source => source && sameStrictJsonValue(source, sources[0]))
                            ? sources[0] : undefined;
                        return [{ request, contributions, responseSource,
                            cost: { ...basis, kind: basis.kind, amountUsd: costs.reduce((sum, cost) => sum + cost!.amountUsd, 0) } }];
                    });
                    // Each observed request participates once; the finding does not add speculative savings across pairs.
                    for (const model of priced) {
                        const selection = model.request.requestIdentity.selection;
                        const candidate = priced.find(other => other.request.sessionId === model.request.sessionId
                            && other.request.turnId !== model.request.turnId
                            && other.request.requestIdentity.scopeKey === model.request.requestIdentity.scopeKey
                            && other.request.requestIdentity.digest === model.request.requestIdentity.digest
                            && other.request.requestIdentity.selection.agentTargetKey === selection.agentTargetKey
                            && other.request.requestIdentity.selection.providerConnectionId === selection.providerConnectionId
                            && other.request.requestIdentity.selection.modelId !== selection.modelId
                            && other.cost.kind === model.cost.kind && other.cost.currency === model.cost.currency
                            && other.cost.amountUsd < model.cost.amountUsd);
                        if (!candidate) continue;
                        return finding(id, capability, 'comparable_completed_request_cost_difference',
                            [ref('model_comparison', model.request), ref('model_comparison', candidate.request),
                                ...[...model.contributions, ...candidate.contributions].map(row => ({ kind: 'accounting' as const,
                                    id: row.id, observedAtMs: row.observedAtMs }))],
                            [{ metric: 'observed_cost_difference', value: model.cost.amountUsd - candidate.cost.amountUsd,
                                unit: 'currency', currency: model.cost.currency, costKind: model.cost.kind }], 'partial', {
                            basis: 'matched_completed_host_request_v1', sessionId: model.request.sessionId,
                            agentTargetKey: selection.agentTargetKey, providerConnectionId: selection.providerConnectionId,
                            modelId: selection.modelId, candidateModelId: candidate.request.requestIdentity.selection.modelId,
                            modelTurnId: model.request.turnId, candidateTurnId: candidate.request.turnId,
                            requestKey: model.request.requestIdentity.digest, requestScopeKey: model.request.requestIdentity.scopeKey,
                            modelCost: model.cost.amountUsd, candidateCost: candidate.cost.amountUsd,
                            currency: model.cost.currency, costKind: model.cost.kind,
                            costCoverage: 'partial',
                            providerAttribution: model.responseSource && candidate.responseSource ? 'known' : 'unknown',
                            ...(model.responseSource ? { modelResponseSource: model.responseSource } : {}),
                            ...(candidate.responseSource ? { candidateResponseSource: candidate.responseSource } : {}),
                        });
                    }
                }
                // Completion of matched host requests is the sole model trigger. A synthetic
                // outcome assertion is not research-backed evidence of model suitability.
                return insufficient(id, capability);
            }
            case 'idle_recaching':
            case 'cache_busting_prompt_changes': {
                if (!detail?.nativeCache && !composition) return insufficient(id, capability);
                const matches = cacheRows.filter(row => cacheCause(row) === id);
                if (matches.length) return finding(id, capability, id === 'idle_recaching' ? 'idle_cache_recreation_observed' : 'prefix_change_cache_miss_observed',
                    matches.map(row => ref('native_cache', row)), [{ metric: 'cache_write_tokens', value: matches.reduce((sum, row) => sum + row.cacheWriteTokens!, 0), unit: 'tokens' }],
                    detail?.coverage ?? 'partial', undefined, (causeShare(matches) ?? 0) >= facts.costs.behaviorFlagShare ? 'cost_linked' : 'informational',
                    { evidenceSeries: [series('cache_write_tokens', 'tokens', matches.map(row => ({ evidenceId: row.evidenceId,
                        observedAtMs: row.observedAtMs, value: row.cacheWriteTokens! })))] });
                return negative(id, capability, (complete || fullComposition) && cacheRows.every(row => expectedRebuild(row) || row.cacheOutcome === 'hit'
                    || row.cacheOutcome === 'miss' && row.missCause !== 'unknown' && row.cacheWriteTokens !== null
                        && (id !== 'idle_recaching' || row.missCause !== 'ttl_expired' || row.idleMs !== null && row.ttlMs !== undefined && row.ttlMs !== null && row.ttlMs > 0)
                        && (id !== 'cache_busting_prompt_changes' || row.missCause !== 'prefix_change'
                            || row.prefixDigest !== null && row.previousPrefixDigest !== null)));
            }
            case 'approval_friction': {
                if (!detail?.permissions) return insufficient(id, capability);
                const { requests: rows, paired } = selectUsageWorkPermissions(detail.permissions, input.period, input.asOfMs);
                if (paired.length) return finding(id, capability, 'approval_wait_observed',
                    paired.map(row => ({ kind: 'permission', id: JSON.stringify([row.workId, row.requestId]), observedAtMs: row.decidedAtMs! })),
                    [{ metric: 'permission_wait', value: paired.reduce((sum, row) => sum + row.decidedAtMs! - row.requestedAtMs!, 0), unit: 'milliseconds' },
                        { metric: 'permission_requests', value: paired.length, unit: 'count' }], detail?.coverage ?? 'partial', undefined,
                    paired.some(row => row.cacheTtlMs !== undefined && row.cacheTtlMs !== null && row.cacheTtlMs > 0
                        && row.decidedAtMs! - row.requestedAtMs! >= row.cacheTtlMs) ? 'cost_linked' : 'informational',
                    { evidenceSeries: [series('permission_wait', 'milliseconds', paired.map(row => ({
                        evidenceId: JSON.stringify([row.workId, row.requestId]), observedAtMs: row.decidedAtMs!,
                        value: row.decidedAtMs! - row.requestedAtMs! })))] });
                return negative(id, capability, complete && rows.every(row => row.requestedAtMs !== null && row.decidedAtMs !== null
                    && row.decidedAtMs >= row.requestedAtMs));
            }
            case 'mcp_overhead': {
                const observed = unique((detail?.mcpUsage ?? []).filter(row => inPeriod(row.window.startMs)));
                const rows = selectLatestUsageMcpBindingWindows(observed);
                if (!rows.length || rows.some(row => row.coverage !== 'complete')) return insufficient(id, capability);
                const bindings = new Map<string, { calls: number; identity: string; consistent: boolean }>();
                for (const row of rows) for (const binding of row.bindings) {
                    const identity = JSON.stringify([row.v, binding.serverId, binding.serverRevision, binding.bindingRevision]);
                    const previous = bindings.get(binding.bindingId);
                    bindings.set(binding.bindingId, { calls: (previous?.calls ?? 0) + binding.toolCallCount, identity,
                        consistent: (previous?.consistent ?? true) && (!previous || previous.identity === identity) });
                }
                if (!bindings.size || [...bindings.values()].some(binding => !binding.consistent)) return insufficient(id, capability);
                const unused = [...bindings.values()].filter(binding => binding.calls === 0).length;
                const definitionWindows = rows.flatMap(row => {
                    if (!row.bindings.length || row.bindings.some(binding => binding.schemaTokens === undefined || binding.schemaTokens === null
                        || !binding.contextWindowTokens)) return [];
                    const denominator = row.bindings[0]!.contextWindowTokens!;
                    if (!row.bindings.every(binding => binding.contextWindowTokens === denominator)) return [];
                    return [{ row, tokens: row.bindings.reduce((sum, binding) => sum + binding.schemaTokens!, 0), denominator }];
                });
                const loaded = rows.some(row => row.bindings.some(binding => binding.definitionsLoading === 'upfront'))
                    || definitionWindows.some(window => window.tokens / window.denominator >= facts.mcp.deferredDefinitionContextShare);
                const measurements: UsageCoachFinding['measurements'] = [{ metric: 'unused_mcp_bindings', value: unused, unit: 'count' }];
                if (definitionWindows.length) measurements.push({ metric: 'loaded_schema_tokens',
                    value: Math.max(...definitionWindows.map(window => window.tokens)), unit: 'tokens' });
                if (unused || loaded) return finding(id, capability, loaded ? 'mcp_definition_overhead_observed' : 'unused_mcp_binding_observed', rows.map(row => ref('mcp_usage', row)),
                    measurements, 'partial', undefined, loaded ? 'cost_linked' : 'informational',
                    definitionWindows.length ? { evidenceSeries: [series('loaded_schema_tokens', 'tokens', definitionWindows.map(window => ({
                        evidenceId: window.row.evidenceId, observedAtMs: window.row.observedAtMs, value: window.tokens })))] } : {});
                return { detectorId: id, requiredEvidence: [capability], status: 'no_finding' };
            }
            case 'repeated_file_reads': {
                if (!detail?.fileReads) return insufficient(id, capability);
                const rows = unique(detail.fileReads).sort((a, b) => a.observedAtMs - b.observedAtMs);
                const previous = new Map<string, typeof rows[number]>();
                const redundant: typeof rows = [];
                const evidence = new Map<string, typeof rows[number]>();
                let unknown = false;
                for (const row of rows) {
                    const key = JSON.stringify([row.turnId, row.fileKey, row.selectionKey]);
                    const before = previous.get(key);
                    if (before && (row.versionDigest === null || before.versionDigest === null)) unknown = true;
                    else if (before && row.versionDigest === before.versionDigest && !detail.compactions?.some(compaction => compaction.turnId === row.turnId
                        && compaction.observedAtMs >= before.observedAtMs && compaction.observedAtMs <= row.observedAtMs)) {
                        if (row.reason === 'redundant') { redundant.push(row); evidence.set(before.evidenceId, before); evidence.set(row.evidenceId, row); }
                        else if (row.reason === 'unknown') unknown = true;
                    }
                    previous.set(key, row);
                }
                if (redundant.length) return finding(id, capability, 'redundant_unchanged_read_observed',
                    [...evidence.values()].map(row => ref('file_read', row)), [{ metric: 'unchanged_reads', value: redundant.length, unit: 'count' }]);
                return negative(id, capability, complete && !unknown);
            }
            case 'compaction_storms': {
                if (!detail?.compactions) return insufficient(id, capability);
                const rows = unique(detail.compactions).sort((a, b) => a.observedAtMs - b.observedAtMs || a.evidenceId.localeCompare(b.evidenceId));
                const sessions = new Map<string, typeof rows>();
                for (const row of rows) {
                    const group = sessions.get(row.sessionId) ?? [];
                    group.push(row);
                    sessions.set(row.sessionId, group);
                }
                const repeated: typeof rows = [];
                for (const group of sessions.values()) {
                    let run: typeof rows = [];
                    for (const row of group) {
                        if (row.immediateRefillToLimit !== true) { run = []; continue; }
                        run.push(row);
                        if (run.length === facts.compaction.immediateRefillsInARow) repeated.push(...run);
                        else if (run.length > facts.compaction.immediateRefillsInARow) repeated.push(row);
                    }
                }
                if (repeated.length) return finding(id, capability, 'compaction_thrash_observed', repeated.map(row => ref('compaction', row)),
                    [{ metric: 'compactions', value: repeated.length, unit: 'count' }]);
                return negative(id, capability, complete && rows.every(row => typeof row.immediateRefillToLimit === 'boolean'));
            }
            case 'anomalous_looping_usage': {
                if (!detail?.loops) return insufficient(id, capability);
                const rows = unique(detail.loops).sort((a, b) => a.observedAtMs - b.observedAtMs);
                const runs = new Map<string, typeof rows>();
                const repeated = new Map<string, typeof rows[number]>();
                for (const row of rows) {
                    const before = runs.get(row.turnId) ?? [];
                    const last = before.at(-1);
                    const failed = row.outcome === 'failed' && row.progress === 'none' && Boolean(row.errorDigest);
                    const run = failed && last?.operationKey === row.operationKey && last.errorDigest === row.errorDigest ? before : [];
                    if (failed) run.push(row);
                    runs.set(row.turnId, run);
                    if (run.length > facts.corrections.moreThanTwice) for (const match of run) repeated.set(match.evidenceId, match);
                }
                if (repeated.size) return finding(id, capability, 'failed_loop_observed', [...repeated.values()].map(row => ref('loop', row)),
                    [{ metric: 'failed_repetitions', value: repeated.size, unit: 'count' }]);
                return negative(id, capability, complete && rows.every(row => row.outcome !== 'unknown' && row.progress !== 'unknown'
                    && (row.outcome !== 'failed' || Boolean(row.errorDigest))));
            }
            case 'context_bloat': {
                // Keep the preference id, replace its full-window rule. Never treat aggregate
                // event buckets as individual requests or infer a universal "long" context.
                if (!pricedRows) return insufficient(id, capability);
                const sessions = new Map<string, typeof pricedRows>();
                for (const entry of pricedRows) {
                    if (!entry.row.sessionId || entry.row.eventCount !== 1 || !entry.row.tokenCategories) continue;
                    const group = sessions.get(entry.row.sessionId) ?? [];
                    group.push(entry); sessions.set(entry.row.sessionId, group);
                }
                for (const group of sessions.values()) {
                    group.sort((a, b) => a.row.observedAtMs - b.row.observedAtMs || a.row.id.localeCompare(b.row.id));
                    const size = (entry: typeof group[number]) => entry.row.tokenCategories!.input
                        + entry.row.tokenCategories!.cacheRead + entry.row.tokenCategories!.cacheWrite;
                    let growingRequest: typeof group[number] | undefined;
                    for (let index = group.length - 1; index > 0; index -= 1) {
                        if (size(group[index]!) > size(group[index - 1]!)) {
                            growingRequest = group[index];
                            break;
                        }
                    }
                    if (!growingRequest) continue;
                    // The measured request must witness the growth. A later compaction or
                    // output-only observation does not erase that observation or supply its size.
                    const measurements: UsageCoachFinding['measurements'] = [{ metric: 'composed_tokens', value: size(growingRequest), unit: 'tokens' }];
                    if (group.every(entry => entry.price !== null && (entry.row.tokenCategories!.cacheRead === 0
                        || entry.price!.price.rates.cacheReadUsdPerMillion !== undefined))) measurements.push({
                        metric: 'cached_history_cost', value: group.reduce((sum, entry) => sum + entry.row.tokenCategories!.cacheRead
                            * (entry.price!.price.rates.cacheReadUsdPerMillion ?? 0) / 1_000_000, 0),
                        unit: 'currency', currency: 'USD', costKind: 'api_equivalent',
                    });
                    return finding(id, capability, 'context_growth_cost_observed', group.map(entry => ({ kind: 'accounting',
                        id: entry.row.id, observedAtMs: entry.row.observedAtMs })), measurements, 'partial', undefined, 'informational',
                    { evidenceSeries: [series('composed_tokens', 'tokens', group.map(entry => ({ evidenceId: entry.row.id,
                        observedAtMs: entry.row.observedAtMs, value: size(entry) })))] });
                }
                return negative(id, capability, input.accounting?.coverage?.status === 'complete'
                    && pricedRows.every(entry => entry.row.eventCount === 1 && entry.row.tokenCategories !== undefined && entry.row.tokenCategories !== null));
            }
            case 'cache_economics': {
                if (!accountingRows?.length || accountingRows.some(row => !row.tokenCategories)) return insufficient(id, capability);
                const totals = accountingRows.reduce((sum, row) => ({ input: sum.input + row.tokenCategories!.input,
                    read: sum.read + row.tokenCategories!.cacheRead, write: sum.write + row.tokenCategories!.cacheWrite }), { input: 0, read: 0, write: 0 });
                const denominator = totals.input + totals.read + totals.write;
                if (denominator === 0) return negative(id, capability, input.accounting?.coverage?.status === 'complete');
                const measurements: UsageCoachFinding['measurements'] = [
                    { metric: 'input_tokens', value: totals.input, unit: 'tokens' },
                    { metric: 'cache_read_tokens', value: totals.read, unit: 'tokens' },
                    { metric: 'cache_write_tokens', value: totals.write, unit: 'tokens' },
                    { metric: 'cache_hit_ratio', value: totals.read / denominator, unit: 'count' },
                ];
                const causes = cacheRows.filter(row => cacheCause(row) !== null);
                const share = causeShare(causes);
                if (share !== null) measurements.push({ metric: 'cache_replacement_premium', value: share * totalPricedCost!,
                    unit: 'currency', currency: 'USD', costKind: 'api_equivalent' }, { metric: 'cache_cost_share', value: share, unit: 'count' });
                const cacheCauses: NonNullable<UsageCoachFinding['cacheCauses']> = (['ttl_expired', 'prefix_change'] as const).flatMap(cause => {
                    const matches = causes.filter(row => row.missCause === cause);
                    if (!matches.length) return [];
                    const premiums = matches.map(cachePremium);
                    return [{ cause, cacheWriteTokens: matches.reduce((sum, row) => sum + row.cacheWriteTokens!, 0),
                        premiumUsd: premiums.every(value => value !== null) ? premiums.reduce<number>((sum, value) => sum + value!, 0) : null }];
                });
                return finding(id, capability, 'cache_economics_observed', [
                    ...accountingRows.map(row => ({ kind: 'accounting' as const, id: row.id, observedAtMs: row.observedAtMs })),
                    ...causes.map(row => ref('native_cache', row)),
                ], measurements, input.accounting?.coverage?.status ?? 'unknown', undefined,
                share !== null && share >= facts.costs.behaviorFlagShare ? 'cost_linked' : 'informational', { cacheCauses,
                    evidenceSeries: (['input_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const).map(metric => series(metric, 'tokens',
                        accountingRows.map(row => ({ evidenceId: row.id, observedAtMs: row.observedAtMs, value: metric === 'input_tokens'
                            ? row.tokenCategories!.input : metric === 'cache_read_tokens' ? row.tokenCategories!.cacheRead : row.tokenCategories!.cacheWrite })))),
                });
            }
            case 'effort_audit': {
                const rows = unique(detail?.effortAudits ?? []).filter(row => row.effort.trim()
                    && Number.isFinite(row.outputTokens) && row.outputTokens >= 0 && Number.isFinite(row.thinkingTokens) && row.thinkingTokens >= 0);
                if (!rows.length) return insufficient(id, capability);
                const result = finding(id, capability, 'effort_audit_observed', rows.map(row => ref('effort', row)), [
                    { metric: 'output_tokens', value: rows.reduce((sum, row) => sum + row.outputTokens, 0), unit: 'tokens' },
                    { metric: 'thinking_tokens', value: rows.reduce((sum, row) => sum + row.thinkingTokens, 0), unit: 'tokens' },
                ], detail?.coverage ?? 'partial', undefined, 'informational', { evidenceSeries: [
                    series('output_tokens', 'tokens', rows.map(row => ({ evidenceId: row.evidenceId, observedAtMs: row.observedAtMs, value: row.outputTokens }))),
                    series('thinking_tokens', 'tokens', rows.map(row => ({ evidenceId: row.evidenceId, observedAtMs: row.observedAtMs, value: row.thinkingTokens }))),
                ] });
                if (result.status === 'finding') result.finding.basis.limitations.push(`Recorded efforts: ${[...new Set(rows.map(row => row.effort))].join(', ')}.`);
                return result;
            }
            case 'subagent_fanout': {
                const rows = unique(detail?.subagentUsage ?? []).filter(row => Number.isFinite(row.parentTokens) && row.parentTokens >= 0
                    && Number.isFinite(row.subagentTokens) && row.subagentTokens >= 0);
                if (!rows.length) return insufficient(id, capability);
                const parent = rows.reduce((sum, row) => sum + row.parentTokens, 0);
                const children = rows.reduce((sum, row) => sum + row.subagentTokens, 0);
                return finding(id, capability, 'subagent_fanout_observed', rows.map(row => ref('subagent', row)), [
                    { metric: 'parent_tokens', value: parent, unit: 'tokens' }, { metric: 'subagent_tokens', value: children, unit: 'tokens' },
                    ...(parent > 0 ? [{ metric: 'fanout_multiplier' as const, value: (parent + children) / parent, unit: 'count' as const }] : []),
                ], detail?.coverage ?? 'partial', undefined, 'informational', { evidenceSeries: [
                    series('parent_tokens', 'tokens', rows.map(row => ({ evidenceId: row.evidenceId, observedAtMs: row.observedAtMs, value: row.parentTokens }))),
                    series('subagent_tokens', 'tokens', rows.map(row => ({ evidenceId: row.evidenceId, observedAtMs: row.observedAtMs, value: row.subagentTokens }))),
                ] });
            }
            case 'outside_usage': {
                const accounting = input.accounting;
                if (!accounting?.contributions || !accounting.coverage) return insufficient(id, capability);
                const rows = [...new Map(accounting.contributions.filter(row => inPeriod(row.observedAtMs))
                    .map(row => [row.id, row])).values()];
                const summary = summarizeUsageExecutionSources(rows);
                const outside = summary.groups.find(group => group.execution === 'outside')?.contributions ?? [];
                if (outside.length) return finding(id, capability, 'outside_happier_usage_observed',
                    outside.map(row => ({ kind: 'accounting', id: row.id, observedAtMs: row.observedAtMs })),
                    [{ metric: 'outside_tokens', value: outside.reduce((sum, row) => sum + row.tokens.total, 0), unit: 'tokens' }], accounting.coverage.status,
                    undefined, 'informational', { evidenceSeries: [series('outside_tokens', 'tokens', outside.map(row => ({ evidenceId: row.id,
                        observedAtMs: row.observedAtMs, value: row.tokens.total })))] });
                return negative(id, capability, accounting.coverage.status === 'complete' && accounting.coverage.range.complete
                    && accounting.coverage.range.startMs === input.period.startMs && accounting.coverage.range.endMs === input.period.endMs
                    && summary.coverage === 'complete');
            }
            default: return insufficient(id, capability);
        }
    });
    const result: UsageCoachEvaluation = { v: 1, queryKey: input.queryKey, period: input.period, asOfMs: input.asOfMs,
        currentness: input.currentness, evaluations,
        findings: evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []),
        unavailableChecks: [{ check: 'fast_mode', reason: 'not_available' }, { check: 'scheduled_interval_vs_ttl', reason: 'not_available' }],
    };
    return admitUsageCoachRemedies(result, input.admittedRemedies ?? []);
}
