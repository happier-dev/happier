import type { ConversationBindingV1, SessionPullRequestFixProgressV1, SessionPullRequestFixSubjectV1,
    SessionPullRequestWatchPolicyV1 } from '@happier-dev/channels-protocol/v1';
import { SESSION_PULL_REQUEST_WATCH_SETTINGS, SessionPullRequestWatchModeV1Schema, SessionPullRequestFixAttemptLimitV1Schema } from '@happier-dev/channels-protocol/v1';
import type { SessionPullRequestUpdateV1 } from '@happier-dev/channels-protocol/v1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export { SESSION_PULL_REQUEST_WATCH_SETTINGS } from '@happier-dev/channels-protocol/v1';
export const SESSION_PULL_REQUEST_WATCH_SETTINGS_DECLARATION = {
    title: { key: 'plugins.channels.prWatch.settings.title', fallback: 'Pull requests' },
    description: { key: 'plugins.channels.prWatch.settings.description',
        fallback: 'When a session opens or links a PR, it can keep watching it and act on CI and reviews.' },
    target: { kind: 'plugin' }, scope: 'account', fields: [
        { id: SESSION_PULL_REQUEST_WATCH_SETTINGS.defaultMode,
            title: { key: 'plugins.channels.prWatch.settings.defaultMode', fallback: 'Default mode' },
            description: { key: 'plugins.channels.prWatch.settings.defaultModeDescription',
                fallback: 'What the agent may do when a watched PR changes. Each session can change it. Analyse, Address and Auto-fix can resume an archived session.' },
            schema: { type: 'string', enum: ['off', 'notify', 'analyse', 'address', 'autoFix'] }, default: 'notify',
            presentation: { control: 'select', options: [
                { value: 'off', title: { key: 'plugins.channels.prWatch.mode.off', fallback: 'Off' },
                    description: { key: 'plugins.channels.prWatch.mode.offDescription', fallback: 'PRs stay linked; nothing is watched.' } },
                { value: 'notify', title: { key: 'plugins.channels.prWatch.mode.notify', fallback: 'Notify' },
                    description: { key: 'plugins.channels.prWatch.mode.notifyDescription', fallback: 'You’re notified; the agent isn’t woken.' } },
                { value: 'analyse', title: { key: 'plugins.channels.prWatch.mode.analyse', fallback: 'Analyse' },
                    description: { key: 'plugins.channels.prWatch.mode.analyseDescription', fallback: 'The agent investigates and reports in the session, read-only.' } },
                { value: 'address', title: { key: 'plugins.channels.prWatch.mode.address', fallback: 'Address' },
                    description: { key: 'plugins.channels.prWatch.mode.addressDescription', fallback: 'The agent fixes; you approve pushes and replies.' } },
                { value: 'autoFix', title: { key: 'plugins.channels.prWatch.mode.autoFix', fallback: 'Auto-fix' },
                    description: { key: 'plugins.channels.prWatch.mode.autoFixDescription', fallback: 'The agent fixes, pushes the PR’s branch and replies. Design questions come to you first.' } },
            ] } },
        { id: SESSION_PULL_REQUEST_WATCH_SETTINGS.fixAttemptLimit,
            title: { key: 'plugins.channels.prWatch.settings.fixAttempts', fallback: 'Fix attempts' },
            description: { key: 'plugins.channels.prWatch.settings.fixAttemptsDescription',
                fallback: 'After this many fixing rounds on one pull request, the agent stops fixing it and asks you. Leave it empty to never stop.' },
            schema: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            presentation: { control: 'number' }, default: 3 },
        { id: SESSION_PULL_REQUEST_WATCH_SETTINGS.archiveAfterMerge,
            title: { key: 'plugins.channels.prWatch.settings.archiveAfterMerge', fallback: 'Also archive the session' },
            description: { key: 'plugins.channels.prWatch.settings.archiveAfterMergeDescription',
                fallback: 'Only when it’s idle and nothing is waiting on you. Archiving can be undone.' },
            schema: { type: 'boolean' }, default: false },
    ],
} satisfies Omit<PluginSettingsContribution, 'id'>;

export type SessionPullRequestWatchDefaults = Readonly<{
    defaultMode: SessionPullRequestWatchPolicyV1['mode']; fixAttemptLimit: number | null;
    archiveAfterMerge: boolean;
}>;
export const SESSION_PULL_REQUEST_OFF_POLICY: SessionPullRequestWatchPolicyV1 = Object.freeze({
    mode: 'off', archiveAfterMerge: false,
});
export function resolveSessionPullRequestWatchDefaults(values: Readonly<Record<string, JsonValue>>): SessionPullRequestWatchDefaults {
    const boolean = (key: string, baseline: boolean) => {
        const value = values[key];
        if (value === undefined) return baseline;
        if (typeof value !== 'boolean') throw new Error(`Invalid PR watch setting ${key}`);
        return value;
    };
    return {
        defaultMode: SessionPullRequestWatchModeV1Schema.parse(values[SESSION_PULL_REQUEST_WATCH_SETTINGS.defaultMode] ?? 'notify'),
        fixAttemptLimit: SessionPullRequestFixAttemptLimitV1Schema.parse(Object.hasOwn(values, SESSION_PULL_REQUEST_WATCH_SETTINGS.fixAttemptLimit)
            ? values[SESSION_PULL_REQUEST_WATCH_SETTINGS.fixAttemptLimit] : 3),
        archiveAfterMerge: boolean(SESSION_PULL_REQUEST_WATCH_SETTINGS.archiveAfterMerge, false),
    };
}
export function readSessionPullRequestWatchPolicy(binding: ConversationBindingV1): SessionPullRequestWatchPolicyV1 {
    return binding.target.kind === 'session' ? binding.target.pullRequestWatch?.policy ?? SESSION_PULL_REQUEST_OFF_POLICY : SESSION_PULL_REQUEST_OFF_POLICY;
}
export function isSessionPullRequestFixSequenceExhausted(progress: SessionPullRequestFixProgressV1 | undefined, limit: number | null): boolean {
    return limit !== null && (progress?.roundsStarted ?? 0) >= limit + (progress?.continuationRounds ?? 0);
}
export type SessionPullRequestWatchAdmission =
    | Readonly<{ kind: 'observe' }>
    | Readonly<{ kind: 'notify' }>
    | Readonly<{ kind: 'held'; reason: 'paused' | 'terminal' | 'exhausted' }>
    | Readonly<{ kind: 'deliver'; permissionCeiling: 'read-only' | 'safe-yolo'; fixing: boolean; prepareRound: boolean }>;
/** The current retained binding is re-read by the dispatch owner before input effects. */
export function resolveSessionPullRequestWatchAdmission(input: Readonly<{
    binding: ConversationBindingV1; fixAttemptLimit: number | null;
}>): SessionPullRequestWatchAdmission {
    const { binding } = input;
    if (binding.deletionState !== 'none') return { kind: 'held', reason: 'paused' };
    if (binding.endpoint.kind === 'githubPullRequest' && (binding.endpoint.pullRequestState?.state === 'merged'
        || binding.endpoint.pullRequestState?.state === 'closed')) return { kind: 'held', reason: 'terminal' };
    const policy = readSessionPullRequestWatchPolicy(binding);
    if (policy.mode === 'off') return { kind: 'observe' };
    if (!binding.enabled) return { kind: 'held', reason: 'paused' };
    if (policy.mode === 'notify') return { kind: 'notify' };
    if (policy.mode === 'analyse') return { kind: 'deliver', permissionCeiling: 'read-only', fixing: false, prepareRound: false };
    if (isSessionPullRequestFixSequenceExhausted(binding.target.kind === 'session' ? binding.target.pullRequestWatch?.progress : undefined, input.fixAttemptLimit)) {
        return { kind: 'held', reason: 'exhausted' };
    }
    return { kind: 'deliver', permissionCeiling: 'safe-yolo', fixing: true, prepareRound: policy.mode === 'autoFix' };
}

/** Host-authored task instructions; provider bodies and labels belong only in the shared evidence block. */
export function buildSessionPullRequestWatchInstructions(input: Readonly<{
    binding: ConversationBindingV1; update: SessionPullRequestUpdateV1; publicationInstructions: string;
    roundPrepared?: boolean;
}>): string {
    const target = input.binding.target;
    if (target.kind !== 'session' || target.sessionId !== input.update.sessionId
        || input.binding.id !== input.update.bindingId || target.pullRequestLink?.repository !== input.update.pullRequest.repository
        || target.pullRequestLink.number !== input.update.pullRequest.number) {
        throw new Error('The PR update does not match its admitted Session binding.');
    }
    const mode = readSessionPullRequestWatchPolicy(input.binding).mode;
    const task = mode === 'analyse'
        ? 'Investigate the quoted pull request update and report your findings. Do not change files or publish a response.'
        : mode === 'address'
            ? 'Address the quoted pull request update. Ask before ambiguous or design-level work. Request approval for push, reply and thread resolution under the current Session policy.'
            : mode === 'autoFix'
                ? 'Apply and test routine fixes for the quoted pull request update. When current permissions allow, commit and push only the bound head branch. Ask before design or architecture decisions.'
                : null;
    if (task === null) throw new Error('This watch mode does not admit Session input.');
    return [task,
        ...(input.roundPrepared ? ['The quoted update is historical evidence. Preparation verified the current bound PR head and accepted checkout; do not assume the quoted SHA is current.'] : []),
        'This active watch mode may resume the selected archived Session to handle its pull request update.',
        'Work only on the bound pull request and its head branch identified in the quoted evidence. Never force-push, merge, enqueue, or enable auto-merge.',
        'For native git push, use only that bound head branch: no force, deletion, tags, all-ref or other-branch pushes. Never run gh pr merge or enable an auto-merge/merge queue. Do not use gh pr comment or mutating gh api as a reply bypass.',
        'Reply only through the canonical marked publication Action, and resolve only threads you actually fixed. Keep the draft and ask or await approval if that path is unavailable; do not fall back to shell comments or raw API writes.',
        input.publicationInstructions,
    ].filter(Boolean).join('\n\n');
}

type FixProgressFact =
    | Readonly<{ kind: 'fixingRoundStarted'; alreadyCounted: boolean; cause: SessionPullRequestFixSubjectV1; sourceHeadSha: string }>
    | Readonly<{ kind: 'ownPush' | 'unknownPush' | 'otherWriterPush' | 'outstandingWorkResolved' }>;
/** Pushes and subjects do not charge rounds; only the native-start/custody owner supplies that fact. */
export function advanceSessionPullRequestFixProgress(previous: SessionPullRequestFixProgressV1, fact: FixProgressFact): SessionPullRequestFixProgressV1 {
    if (fact.kind === 'ownPush' || fact.kind === 'unknownPush') return previous;
    if (fact.kind === 'otherWriterPush' || fact.kind === 'outstandingWorkResolved') {
        return previous.roundsStarted === 0 && previous.continuationRounds === 0
            ? previous : { roundsStarted: 0, continuationRounds: 0 };
    }
    if (fact.kind === 'fixingRoundStarted' && !fact.alreadyCounted) {
        return { ...previous, roundsStarted: previous.roundsStarted + 1, cause: fact.cause, sourceHeadSha: fact.sourceHeadSha };
    }
    return previous;
}
/** The Watch Action owns current policy and the binding revision CAS for this grant. */
export function continueSessionPullRequestFixProgress(previous: SessionPullRequestFixProgressV1, input: Readonly<{
    fixAttemptLimit: number | null;
}>): SessionPullRequestFixProgressV1 {
    if (input.fixAttemptLimit === null || !isSessionPullRequestFixSequenceExhausted(previous, input.fixAttemptLimit)) return previous;
    return { ...previous, continuationRounds: previous.continuationRounds + input.fixAttemptLimit };
}
