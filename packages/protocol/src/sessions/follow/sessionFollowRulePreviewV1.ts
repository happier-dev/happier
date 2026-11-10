import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { FollowSourceRefV1Schema, followDeliveryMuteScopeKeyV1, type FollowSourceRefV1 } from './sessionDeliveryMuteV1.js';
import { SessionFollowRuleIdV1Schema, SessionFollowRuleDefinitionV1Schema, type SessionFollowRuleDefinitionV1 } from './sessionFollowRuleV1.js';
import { sessionWorkFilterFields, normalizeSessionListFilterV1, type SessionListFilterFactsV1, type SessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import { compileEntityListFilterV1 } from '../../collections/filter/entityListFilterV1.js';
import type { QualifiedProjectKeyV1 } from '../../workspaces/workspaceRefV1.js';

const QualifiedFollowPreviewSourceV1Schema = lazyZodSchema(() => z.strictObject({
    serverId: z.string().check(z.minLength(1)), source: FollowSourceRefV1Schema,
}));
export const FollowRulePreviewResultV1Schema = lazyZodSchema(() => z.strictObject({
    coverage: z.enum(['complete', 'partial', 'unavailable']),
    matchCount: z.number().check(z.int(), z.nonnegative()),
    matches: z.array(QualifiedFollowPreviewSourceV1Schema),
    unavailable: z.array(QualifiedFollowPreviewSourceV1Schema),
    overlaps: z.array(z.strictObject({ ruleId: SessionFollowRuleIdV1Schema, matches: z.array(QualifiedFollowPreviewSourceV1Schema) })),
    continuation: z.optional(z.string().check(z.minLength(1))),
}));
export type FollowRulePreviewResultV1 = z.infer<typeof FollowRulePreviewResultV1Schema>;

export type FollowRulePreviewCandidateV1 = Readonly<{ source: FollowSourceRefV1; facts: SessionListFilterFactsV1 }>;
export type EvaluateFollowRulePreviewV1Input = Readonly<{
    filter: SessionListFilterV1;
    /** Only current, already authorized candidates from the producer's corpus. */
    candidates: readonly FollowRulePreviewCandidateV1[];
    coverage: FollowRulePreviewResultV1['coverage'];
    continuation?: string;
    /** Already opened, authorized other rules; no reverse/private Account lookup. */
    otherRules?: readonly Readonly<{ ruleId: string; enabled: boolean; filter: SessionListFilterV1 }>[];
}>;

/** Preview is a projection, never enrollment or delivery history. Matching has one owner. */
export function evaluateFollowRulePreviewV1(input: EvaluateFollowRulePreviewV1Input): FollowRulePreviewResultV1 {
    const matchFilter = compileEntityListFilterV1(sessionWorkFilterFields, input.filter, 'daemonRule');
    const matches: FollowRulePreviewResultV1['matches'] = [];
    const unavailable: FollowRulePreviewResultV1['unavailable'] = [];
    const overlaps = (input.otherRules ?? []).filter(rule => rule.enabled).map(rule => ({
        ruleId: rule.ruleId, match: compileEntityListFilterV1(sessionWorkFilterFields, rule.filter, 'daemonRule'),
        matches: [] as FollowRulePreviewResultV1['matches'],
    }));
    const seen = new Set<string>();
    let incomplete = input.coverage !== 'complete';
    for (const candidate of input.candidates) {
        const serverId = candidate.facts.workspaceContext?.normalizeServerId?.(candidate.facts.serverId) ?? candidate.facts.serverId;
        const key = JSON.stringify([serverId, followDeliveryMuteScopeKeyV1({ kind: 'source', source: candidate.source })]);
        if (seen.has(key)) continue;
        seen.add(key);
        const source = { serverId, source: candidate.source };
        const match = matchFilter(candidate.facts);
        if (match === 'unavailable') { unavailable.push(source); incomplete = true; }
        if (match !== 'match') continue;
        matches.push(source);
        for (const overlap of overlaps) {
            const otherMatch = overlap.match(candidate.facts);
            if (otherMatch === 'match') overlap.matches.push(source);
            else if (otherMatch === 'unavailable') incomplete = true;
        }
    }
    return {
        coverage: input.coverage === 'unavailable' ? 'unavailable' : incomplete ? 'partial' : 'complete',
        matchCount: matches.length, matches, unavailable,
        overlaps: overlaps.filter(overlap => overlap.matches.length > 0).map(overlap => ({ ruleId: overlap.ruleId, matches: overlap.matches })),
        ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
    };
}

/** "Leave them to this one" edits the other rule, with no rule-to-rule reference or arbitration. */
export function excludeProjectFromSessionFollowRuleV1(
    definition: SessionFollowRuleDefinitionV1,
    project: QualifiedProjectKeyV1,
): SessionFollowRuleDefinitionV1 {
    return SessionFollowRuleDefinitionV1Schema.parse({ ...definition, filter: normalizeSessionListFilterV1({
        ...definition.filter, projects: {
            include: definition.filter.projects?.include ?? [],
            exclude: [...(definition.filter.projects?.exclude ?? []), project],
        },
    }) });
}

/** Its way back: the rule follows that Project again; an emptied Project facet is removed, not left as `[]`. */
export function includeExcludedProjectInSessionFollowRuleV1(
    definition: SessionFollowRuleDefinitionV1,
    project: QualifiedProjectKeyV1,
): SessionFollowRuleDefinitionV1 {
    const include = definition.filter.projects?.include ?? [];
    const exclude = (definition.filter.projects?.exclude ?? [])
        .filter((excluded) => excluded.serverId !== project.serverId || excluded.projectKey !== project.projectKey);
    const { projects: _projects, ...filter } = definition.filter;
    return SessionFollowRuleDefinitionV1Schema.parse({ ...definition, filter: normalizeSessionListFilterV1(
        include.length + exclude.length > 0 ? { ...filter, projects: { include, exclude } } : filter,
    ) });
}
