import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { UsagePromptCompositionSchema } from './usagePromptComposition.js';
import { UsageCoachModelRequestSchema } from './usagePromptComposition.js';
import { UsageMcpBindingUsageSchema } from './usageMcpBindingUsage.js';
import { resolveUsageCostBasis } from '../usageCost.js';
import { UsageCoachPreferencesV1Schema, type UsageCoachPreferencesV1 } from '../../account/settings/usageCoachPreferencesV1.js';
import { USAGE_COACH_DETECTOR_IDS, USAGE_COACH_REQUIRED_EVIDENCE, UsageCoachEvaluationSchema, type UsageCoachCapability, type UsageCoachEvaluation,
    type UsageCoachEvaluationInput, type UsageCoachConceptEvaluation, type UsageCoachDetectorId, type UsageCoachFinding,
    type UsageCoachAdmittedRemedy } from './coachFinding.js';

export function applyUsageCoachPreferences(evaluation: UsageCoachEvaluation, preferences: UsageCoachPreferencesV1,
    nowMs: number): UsageCoachEvaluation {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Invalid usage preference observation time');
    const parsed = UsageCoachPreferencesV1Schema.parse(preferences);
    const suppressions = new Map(parsed.suppressions.map(row => [row.evidenceKey, row]));
    const evaluations = evaluation.evaluations.map(row => {
        if (row.status !== 'finding') return row;
        const suppression = suppressions.get(row.finding.evidenceKey);
        return { ...row, finding: { ...row.finding, state: { ...row.finding.state,
            dismissed: suppression?.kind === 'dismissed',
            snoozedUntilMs: suppression?.kind === 'snoozed' && suppression.untilMs > nowMs ? suppression.untilMs : null,
        } } };
    });
    return UsageCoachEvaluationSchema.parse({ ...evaluation, evaluations,
        findings: evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []) });
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
    return UsageCoachEvaluationSchema.parse({ ...evaluation, evaluations,
        findings: evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []) });
}

export function evaluateUsageCoach(input: UsageCoachEvaluationInput): UsageCoachEvaluation {
    const inPeriod = (instant: number) => Number.isSafeInteger(instant) && instant >= input.period.startMs
        && instant < input.period.endMs && (input.asOfMs === null || instant <= input.asOfMs);
    const detail = input.detail?.coverage === 'unknown' ? undefined : input.detail;
    const complete = detail?.coverage === 'complete';
    const unique = <T extends { evidenceId: string; observedAtMs: number }>(values: readonly T[]) =>
        [...new Map(values.filter(row => inPeriod(row.observedAtMs)).map(row => [row.evidenceId, row])).values()];
    const insufficient = (detectorId: UsageCoachDetectorId, capability: UsageCoachCapability): UsageCoachConceptEvaluation =>
        ({ detectorId, requiredEvidence: [capability], status: 'insufficient_evidence', missingEvidence: [capability] });
    const negative = (detectorId: UsageCoachDetectorId, capability: UsageCoachCapability, covered: boolean): UsageCoachConceptEvaluation =>
        covered ? { detectorId, requiredEvidence: [capability], status: 'no_finding' } : insufficient(detectorId, capability);
    const finding = (detectorId: UsageCoachDetectorId, capability: UsageCoachCapability,
        summaryCode: UsageCoachFinding['summaryCode'], evidence: UsageCoachFinding['evidence'], measurements: UsageCoachFinding['measurements'],
        coverage: UsageCoachFinding['coverage'] = detail?.coverage ?? 'partial',
        modelComparison?: UsageCoachFinding['modelComparison']): UsageCoachConceptEvaluation => {
        evidence.sort((a, b) => a.id.localeCompare(b.id) || a.observedAtMs - b.observedAtMs);
        // The requested query key already identifies its range/calendar. An open
        // query's witnessed display end advances without changing these facts.
        const evidenceKey = computeCanonicalDomainSeparatedDigest('happier.usage.coach.finding.v1',
            [detectorId, input.queryKey, summaryCode, JSON.stringify(evidence), JSON.stringify(measurements),
                ...(modelComparison ? [JSON.stringify(modelComparison)] : [])]);
        const state = input.findingStates?.find(row => row.detectorId === detectorId && row.evidenceKey === evidenceKey)?.state
            ?? { dismissed: false, snoozedUntilMs: null, applied: null };
        return { detectorId, requiredEvidence: [capability], status: 'finding', finding: {
            detectorId, evidenceKey, queryKey: input.queryKey, period: input.period, asOfMs: input.asOfMs,
            currentness: input.currentness, coverage, severity: 'info', summaryCode, evidence, measurements, remedy: null,
            action: null, state, ...(modelComparison ? { modelComparison } : {}),
        } };
    };
    const ref = (kind: UsageCoachFinding['evidence'][number]['kind'], row: { evidenceId: string; observedAtMs: number }) =>
        ({ kind, id: row.evidenceId, observedAtMs: row.observedAtMs });
    const composition = input.composition === undefined ? undefined : unique(input.composition.map(row => UsagePromptCompositionSchema.parse(row)));
    const fullComposition = input.compositionCoverage === 'complete' && composition !== undefined
        && composition.every(row => row.coverage === 'complete_native');

    const evaluations = USAGE_COACH_DETECTOR_IDS.map((id): UsageCoachConceptEvaluation => {
        const capability = USAGE_COACH_REQUIRED_EVIDENCE[id][0];
        switch (id) {
            case 'duplicated_instructions': {
                if (!composition) return insufficient(id, capability);
                let duplicateCount = 0;
                let duplicateBytes = 0;
                const evidence: UsageCoachFinding['evidence'] = [];
                for (const row of composition) {
                    const seen = new Set<string>();
                    let duplicate = false;
                    for (const component of row.components) {
                        if (component.kind !== 'instructions' || component.overlap !== 'none' || component.byteLength === 0) continue;
                        const key = JSON.stringify([component.digest, component.location, component.byteLength]);
                        if (seen.has(key)) { duplicateCount += 1; duplicateBytes += component.byteLength; duplicate = true; }
                        seen.add(key);
                    }
                    if (duplicate) evidence.push(ref('composition', row));
                }
                if (duplicateCount) return finding(id, capability, 'duplicate_injection_observed', evidence,
                    [{ metric: 'duplicate_injections', value: duplicateCount, unit: 'count' },
                        { metric: 'duplicate_bytes', value: duplicateBytes, unit: 'bytes' }], fullComposition ? 'complete' : 'partial');
                return negative(id, capability, fullComposition && composition.every(row => row.components.every(component =>
                    component.kind !== 'instructions' || component.overlap === 'none')));
            }
            case 'model_misfit': {
                if (detail?.modelRequests && input.accounting?.contributions && input.accounting.coverage?.status === 'complete'
                    && input.accounting.coverage.range.complete && input.accounting.coverage.range.startMs === input.period.startMs
                    && input.accounting.coverage.range.endMs === input.period.endMs) {
                    const requests = unique(detail.modelRequests.flatMap(row => {
                        const parsed = UsageCoachModelRequestSchema.safeParse(row);
                        return parsed.success && inPeriod(parsed.data.startedAtMs) ? [parsed.data] : [];
                    }));
                    const priced = requests.flatMap(request => {
                        const selection = request.requestIdentity.selection;
                        if (selection.modelId === 'default' || selection.modelId === 'automatic') return [];
                        const contributions = [...new Map(input.accounting!.contributions!.filter(row =>
                            row.sessionId === request.sessionId && row.turnId === request.turnId).map(row => [row.id, row])).values()];
                        if (!contributions.length || contributions.some(row => !inPeriod(row.observedAtMs)
                            || row.observedAtMs < request.startedAtMs || row.observedAtMs > request.observedAtMs
                            || row.modelId !== selection.modelId || row.providerAttribution !== 'known'
                            || row.providerConnectionId !== selection.providerConnectionId)) return [];
                        const costs = contributions.map(row => resolveUsageCostBasis(row.cost, 'auto'));
                        const basis = costs[0];
                        if (!basis || costs.some(cost => !cost || cost.kind !== basis.kind || cost.currency !== basis.currency)) return [];
                        return [{ request, contributions, cost: { ...basis, amountUsd: costs.reduce((sum, cost) => sum + cost!.amountUsd, 0) } }];
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
                        });
                    }
                }
                if (!detail?.modelComparisons) return insufficient(id, capability);
                const rows = unique(detail.modelComparisons);
                const match = rows.find(row => row.modelId !== row.candidateModelId && row.modelOutcome === 'met'
                    && row.candidateOutcome === 'met' && row.modelCost > row.candidateCost);
                if (match) return finding(id, capability, 'compatible_model_cost_difference', [ref('model_comparison', match)],
                    [{ metric: 'observed_cost_difference', value: match.modelCost - match.candidateCost, unit: 'currency',
                        currency: match.currency, costKind: match.costKind }]);
                return negative(id, capability, complete && rows.every(row => row.modelOutcome !== 'unknown' && row.candidateOutcome !== 'unknown'));
            }
            case 'idle_recaching':
            case 'cache_busting_prompt_changes': {
                const rows = detail?.nativeCache ? unique(detail.nativeCache) : [];
                // Native request facts are evidence translators, not another cache policy.
                if (id === 'cache_busting_prompt_changes' && composition) {
                    const previous = new Map<string, typeof composition[number]>();
                    for (const row of [...composition].sort((a, b) => a.observedAtMs - b.observedAtMs)) {
                        if (row.boundary !== 'agent_native_request' || row.coverage !== 'complete_native' || !row.nativePrefix) continue;
                        const before = previous.get(row.sessionId);
                        if (before?.nativePrefix && row.nativePrefix.cacheOutcome === 'miss' && row.nativePrefix.missCause === 'prefix_change'
                            && row.nativePrefix.cacheWriteTokens !== null && row.nativePrefix.cacheWriteTokens > 0
                            && row.nativePrefix.digest !== before.nativePrefix.digest) {
                            return finding(id, capability, 'prefix_change_cache_miss_observed', [ref('composition', before), ref('composition', row)],
                                [{ metric: 'cache_write_tokens', value: row.nativePrefix.cacheWriteTokens, unit: 'tokens' }], fullComposition ? 'complete' : 'partial');
                        }
                        previous.set(row.sessionId, row);
                    }
                }
                if (!detail?.nativeCache) return insufficient(id, capability);
                const match = rows.find(row => row.cacheOutcome === 'miss' && row.cacheWriteTokens !== null && row.cacheWriteTokens > 0
                    && (id === 'idle_recaching' ? row.missCause === 'ttl_expired' && row.idleMs !== null && row.idleMs > 0
                        : row.missCause === 'prefix_change' && row.prefixDigest !== null && row.previousPrefixDigest !== null
                            && row.prefixDigest !== row.previousPrefixDigest));
                if (match) return finding(id, capability, id === 'idle_recaching' ? 'idle_cache_recreation_observed' : 'prefix_change_cache_miss_observed',
                    [ref('native_cache', match)], [{ metric: 'cache_write_tokens', value: match.cacheWriteTokens!, unit: 'tokens' }]);
                return negative(id, capability, complete && rows.every(row => row.cacheOutcome === 'hit'
                    || row.cacheOutcome === 'miss' && row.missCause !== 'unknown' && row.cacheWriteTokens !== null
                        && (id !== 'idle_recaching' || row.missCause !== 'ttl_expired' || row.idleMs !== null)
                        && (id !== 'cache_busting_prompt_changes' || row.missCause !== 'prefix_change'
                            || row.prefixDigest !== null && row.previousPrefixDigest !== null)));
            }
            case 'approval_friction': {
                if (!detail?.permissions) return insufficient(id, capability);
                const rows = [...new Map(detail.permissions.filter(row => row.requestedAtMs !== null && inPeriod(row.requestedAtMs)
                    || row.decidedAtMs !== null && inPeriod(row.decidedAtMs)).map(row => [JSON.stringify([row.workId, row.requestId]), row])).values()];
                const paired = rows.filter(row => row.requestedAtMs !== null && row.decidedAtMs !== null
                    && inPeriod(row.requestedAtMs) && inPeriod(row.decidedAtMs) && row.decidedAtMs > row.requestedAtMs);
                if (paired.length) return finding(id, capability, 'approval_wait_observed',
                    paired.map(row => ({ kind: 'permission', id: JSON.stringify([row.workId, row.requestId]), observedAtMs: row.decidedAtMs! })),
                    [{ metric: 'permission_wait', value: paired.reduce((sum, row) => sum + row.decidedAtMs! - row.requestedAtMs!, 0), unit: 'milliseconds' },
                        { metric: 'permission_requests', value: paired.length, unit: 'count' }]);
                return negative(id, capability, complete && rows.every(row => row.requestedAtMs !== null && row.decidedAtMs !== null
                    && row.decidedAtMs >= row.requestedAtMs));
            }
            case 'mcp_overhead': {
                const observed = unique((detail?.mcpUsage ?? []).flatMap(row => {
                    const parsed = UsageMcpBindingUsageSchema.safeParse(row);
                    return parsed.success && inPeriod(parsed.data.window.startMs) ? [parsed.data] : [];
                }));
                // A changed catalog configuration needs fresh native witnessing. Historical
                // windows never impersonate usage of a newly configured binding.
                const latestRevision = observed.reduce((latest, row) => row.bindings.reduce((revision, binding) =>
                    Math.max(revision, binding.catalogRevision), latest), -1);
                const rows = observed.filter(row => row.bindings.some(binding => binding.catalogRevision === latestRevision));
                if (!rows.length || rows.some(row => row.coverage !== 'complete')) return insufficient(id, capability);
                const bindings = new Map<string, { calls: number; identity: string; consistent: boolean }>();
                for (const row of rows) for (const binding of row.bindings) {
                    const identity = JSON.stringify([binding.serverId, binding.serverRevision, binding.bindingRevision, binding.catalogRevision]);
                    const previous = bindings.get(binding.bindingId);
                    bindings.set(binding.bindingId, { calls: (previous?.calls ?? 0) + binding.toolCallCount, identity,
                        consistent: (previous?.consistent ?? true) && (!previous || previous.identity === identity) });
                }
                if (!bindings.size || [...bindings.values()].some(binding => !binding.consistent)) return insufficient(id, capability);
                const unused = [...bindings.values()].filter(binding => binding.calls === 0).length;
                if (unused) return finding(id, capability, 'unused_mcp_binding_observed', rows.map(row => ref('mcp_usage', row)),
                    [{ metric: 'unused_mcp_bindings', value: unused, unit: 'count' }], 'partial');
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
                    else if (before && row.versionDigest === before.versionDigest) {
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
                const rows = unique(detail.compactions);
                const sessions = new Map<string, typeof rows>();
                for (const row of rows) {
                    const group = sessions.get(row.sessionId) ?? [];
                    group.push(row);
                    sessions.set(row.sessionId, group);
                }
                const repeated = [...sessions.values()].filter(rows => rows.length > 1).flat();
                if (repeated.length) return finding(id, capability, 'repeated_compaction_observed', repeated.map(row => ref('compaction', row)),
                    [{ metric: 'compactions', value: repeated.length, unit: 'count' }]);
                return negative(id, capability, complete);
            }
            case 'anomalous_looping_usage': {
                if (!detail?.loops) return insufficient(id, capability);
                const rows = unique(detail.loops).sort((a, b) => a.observedAtMs - b.observedAtMs);
                const runs = new Map<string, typeof rows>();
                const repeated = new Map<string, typeof rows[number]>();
                for (const row of rows) {
                    const key = JSON.stringify([row.turnId, row.operationKey]);
                    const run = row.outcome === 'failed' && row.progress === 'none' ? runs.get(key) ?? [] : [];
                    if (row.outcome === 'failed' && row.progress === 'none') run.push(row);
                    runs.set(key, run);
                    if (run.length === 2) repeated.set(run[0]!.evidenceId, run[0]!);
                    if (run.length > 1) repeated.set(row.evidenceId, row);
                }
                if (repeated.size) return finding(id, capability, 'failed_loop_observed', [...repeated.values()].map(row => ref('loop', row)),
                    [{ metric: 'failed_repetitions', value: repeated.size, unit: 'count' }]);
                return negative(id, capability, complete && rows.every(row => row.outcome !== 'unknown' && row.progress !== 'unknown'));
            }
            case 'context_bloat': {
                if (!composition) return insufficient(id, capability);
                const known = composition.filter(row => row.coverage === 'complete_native' && row.nativePrefix?.tokenCount !== null
                    && row.nativePrefix?.tokenCount !== undefined && row.nativePrefix.tokenizerId !== null
                    && row.contextWindowTokens !== null && row.contextWindowTokens > 0);
                const match = known.find(row => row.nativePrefix!.tokenCount! >= row.contextWindowTokens!);
                if (match) return finding(id, capability, 'context_capacity_reached', [ref('composition', match)],
                    [{ metric: 'composed_tokens', value: match.nativePrefix!.tokenCount!, unit: 'tokens' },
                        { metric: 'context_window_tokens', value: match.contextWindowTokens!, unit: 'tokens' }], fullComposition ? 'complete' : 'partial');
                return negative(id, capability, fullComposition && known.length === composition.length);
            }
            case 'outside_usage': {
                const accounting = input.accounting;
                if (!accounting?.contributions || !accounting.coverage) return insufficient(id, capability);
                const paths = new Map(accounting.coverage.sources.map(row => [row.source, row.path]));
                const rows = [...new Map(accounting.contributions.filter(row => inPeriod(row.observedAtMs))
                    .map(row => [row.id, row])).values()];
                const outside = rows.filter(row => row.sessionId === null && row.machineId !== null
                    && row.source !== null && paths.get(row.source) === 'native');
                if (outside.length) return finding(id, capability, 'outside_happier_usage_observed',
                    outside.map(row => ({ kind: 'accounting', id: row.id, observedAtMs: row.observedAtMs })),
                    [{ metric: 'outside_tokens', value: outside.reduce((sum, row) => sum + row.tokens.total, 0), unit: 'tokens' }], accounting.coverage.status);
                return negative(id, capability, accounting.coverage.status === 'complete' && accounting.coverage.range.complete
                    && accounting.coverage.range.startMs === input.period.startMs && accounting.coverage.range.endMs === input.period.endMs
                    && rows.every(row => row.sessionId !== null || row.source !== null && paths.has(row.source)
                        && paths.get(row.source) !== 'unknown' && row.machineId !== null));
            }
            default: return insufficient(id, capability);
        }
    });
    const result = UsageCoachEvaluationSchema.parse({ v: 1, queryKey: input.queryKey, period: input.period, asOfMs: input.asOfMs,
        currentness: input.currentness, evaluations,
        findings: evaluations.flatMap(row => row.status === 'finding' ? [row.finding] : []),
    });
    return admitUsageCoachRemedies(result, input.admittedRemedies ?? []);
}
