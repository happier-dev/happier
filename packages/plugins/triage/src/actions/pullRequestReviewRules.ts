import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { decodeBase64, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { SCM_OPERATION_ERROR_CODES, ScmFileAtRevisionResponseSchema } from '@happier-dev/plugin-sdk/scm';
import {
    PULL_REQUEST_REVIEW_BASE_FILE_RULE_MEMBERS_V1,
    PULL_REQUEST_REVIEW_STEP_RULE_MEMBERS_V1,
    PullRequestReviewAuthorKindV1Schema,
    PullRequestReviewResolvedRulesV1Schema,
    PullRequestReviewSkipReasonV1Schema,
    type PullRequestReviewResolvedRulesV1,
    type PullRequestReviewSkipReasonV1,
} from '@happier-dev/triage-protocol/v1';

/** The Account artifact shares these path and ref globs across browser and Node runtimes. */
function compileGlob(pattern: string): RegExp {
    let source = '';
    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index]!;
        if (char === '*' && pattern[index + 1] === '*') {
            index += 1;
            if (pattern[index + 1] === '/') {
                index += 1;
                source += '(?:.*/)?';
            } else {
                source += '.*';
            }
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

const nonempty = defineProtocolString({ minLength: 1 });
const bool = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);

export { PullRequestReviewResolvedRulesV1Schema, PullRequestReviewSkipReasonV1Schema };
export type { PullRequestReviewResolvedRulesV1 };

export const PullRequestReviewRuleOccurrenceV1Schema = defineProtocolObject({
    baseRef: nonempty.optional(),
    author: defineProtocolObject({ kind: PullRequestReviewAuthorKindV1Schema }, { policy: 'additive-open/drop' }).optional(),
    draft: bool.optional(),
}, { policy: 'additive-open/drop' });
export type PullRequestReviewRuleOccurrenceV1 = ReturnType<typeof PullRequestReviewRuleOccurrenceV1Schema.parse>;
type Occurrence = PullRequestReviewRuleOccurrenceV1;

// Project trigger filters use AutomationEventFilterV1. Only the review step's
// own options are carried here, alongside the optional base-commit fallback.
export const PullRequestReviewStepRulesV1Schema = defineProtocolObject(PULL_REQUEST_REVIEW_STEP_RULE_MEMBERS_V1, { policy: 'closed' });
export type PullRequestReviewStepRulesV1 = ReturnType<typeof PullRequestReviewStepRulesV1Schema.parse>;

const BaseFileRulesV1Schema = defineProtocolObject(PULL_REQUEST_REVIEW_BASE_FILE_RULE_MEMBERS_V1, { policy: 'closed' });
type SkipReason = PullRequestReviewSkipReasonV1;

export async function readPullRequestReviewRules(params: Readonly<{
    repositoryPath: string;
    baseRevision: string;
    occurrence: Occurrence;
    project: PullRequestReviewStepRulesV1 | undefined;
    context: PluginInvocationContext;
}>): Promise<
    | Readonly<{ kind: 'ready'; rules: PullRequestReviewResolvedRulesV1 }>
    | Readonly<{ kind: 'skipped'; rules: PullRequestReviewResolvedRulesV1; reason: SkipReason }>
    | Readonly<{ kind: 'unavailable' | 'invalid' }>
> {
    const { baseRevision, context, occurrence, project } = params;
    const read = ScmFileAtRevisionResponseSchema.safeParse(await context.services.actions.execute('scm.file.read', {
        cwd: params.repositoryPath, path: '.happier/review-rules.json', selector: { commit: baseRevision },
    }, { signal: context.signal }));
    if (!read.success || (!read.data.success && read.data.errorCode !== SCM_OPERATION_ERROR_CODES.NOT_FOUND)) {
        return { kind: 'unavailable' };
    }
    let base: ReturnType<typeof BaseFileRulesV1Schema.parse> = {};
    if (read.data.success) {
        try {
            const json = new TextDecoder().decode(decodeBase64(read.data.contentBase64));
            base = BaseFileRulesV1Schema.parse(JSON.parse(json));
        } catch {
            return { kind: 'invalid' };
        }
    }
    const ignorePaths = project?.ignorePaths ?? base.ignorePaths;
    const inlineThreshold = project?.inlineThreshold ?? base.inlineThreshold;
    const rules: PullRequestReviewResolvedRulesV1 = { ...base, baseRevision,
        ...(ignorePaths === undefined ? {} : { ignorePaths }),
        ...(inlineThreshold === undefined ? {} : { inlineThreshold }),
        provenance: {
            ...(ignorePaths === undefined ? {} : { ignorePaths: project?.ignorePaths === undefined ? 'baseCommit' : 'projectAutomation' }),
            ...(inlineThreshold === undefined ? {} : { inlineThreshold: project?.inlineThreshold === undefined ? 'baseCommit' : 'projectAutomation' }),
            ...(base.baseRefs === undefined ? {} : { baseRefs: 'baseCommit' }),
            ...(base.authorKinds === undefined ? {} : { authorKinds: 'baseCommit' }),
            ...(base.skipDrafts === undefined ? {} : { skipDrafts: 'baseCommit' }),
        },
    };
    const skip = (reason: SkipReason) => ({ kind: 'skipped' as const, reason, rules });
    if (base.baseRefs && !base.baseRefs.some(pattern => compileGlob(pattern).test(occurrence.baseRef ?? ''))) return skip('baseRef');
    if (base.authorKinds && !base.authorKinds.includes(occurrence.author?.kind ?? 'unsupported')) return skip('authorKind');
    if (base.skipDrafts && occurrence.draft === true) return skip('draft');
    return { kind: 'ready', rules };
}

export function selectPullRequestReviewPaths(paths: readonly string[], ignorePaths: readonly string[]): readonly string[] {
    const ignored = ignorePaths.map(compileGlob);
    return paths.filter(path => !ignored.some(pattern => pattern.test(path)));
}
