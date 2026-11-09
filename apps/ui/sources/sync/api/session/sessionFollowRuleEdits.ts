import { FollowRuleSetActionOutputV1Schema, OpenedSessionFollowRuleV1Schema, type OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { excludeProjectFromSessionFollowRuleV1, includeExcludedProjectInSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { executeUiSessionFollowAction } from './sessionFollowApi';

export type FollowRuleProjectEditUndo = Readonly<{
    serverId: string;
    previous: OpenedSessionFollowRuleV1;
    expectedVersion: number;
}>;

/** Writes a rule's whole opened definition (filter and policy) at the version it was read. */
export async function writeSessionFollowRuleDefinition(
    serverId: string,
    rule: OpenedSessionFollowRuleV1,
    expectedVersion: number,
    signal?: AbortSignal,
) {
    const { policy, ...ruleDefinition } = rule.definition;
    const result = await executeUiSessionFollowAction('follow.set', {
        receiver: rule.receiver, source: { kind: 'rule', ruleId: rule.ruleId },
        ruleDefinition, policy, expectedVersion,
    }, serverId, FollowRuleSetActionOutputV1Schema.parse, undefined, signal);
    if (result.kind === 'failed') return result;
    return { kind: 'ok' as const, value: result.value.rule };
}

/** One visible edit to the other rule; the original draft is kept for a version-bound Undo. */
export async function leaveProjectToFollowRule(input: Readonly<{
    serverId: string;
    rule: OpenedSessionFollowRuleV1;
    project: QualifiedProjectKeyV1;
    signal?: AbortSignal;
}>) {
    const previous = OpenedSessionFollowRuleV1Schema.parse(input.rule);
    const edited = { ...previous, definition: excludeProjectFromSessionFollowRuleV1(previous.definition, input.project) };
    const result = await writeSessionFollowRuleDefinition(input.serverId, edited, previous.version, input.signal);
    if (result.kind === 'failed') return result;
    return { kind: 'ok' as const, value: { rule: result.value, undo: {
        serverId: input.serverId, previous, expectedVersion: result.value.version,
    } satisfies FollowRuleProjectEditUndo } };
}

/** A left-out Project's way back: the rule follows it again, with the same version-bound Undo. */
export async function includeProjectInFollowRule(input: Readonly<{
    serverId: string;
    rule: OpenedSessionFollowRuleV1;
    project: QualifiedProjectKeyV1;
    signal?: AbortSignal;
}>) {
    const previous = OpenedSessionFollowRuleV1Schema.parse(input.rule);
    const edited = { ...previous, definition: includeExcludedProjectInSessionFollowRuleV1(previous.definition, input.project) };
    const result = await writeSessionFollowRuleDefinition(input.serverId, edited, previous.version, input.signal);
    if (result.kind === 'failed') return result;
    return { kind: 'ok' as const, value: { rule: result.value, undo: {
        serverId: input.serverId, previous, expectedVersion: result.value.version,
    } satisfies FollowRuleProjectEditUndo } };
}

/** A later edit causes a conflict; Undo never overwrites it or re-resolves another rule. */
export function undoFollowRuleProjectEdit(undo: FollowRuleProjectEditUndo, signal?: AbortSignal) {
    return writeSessionFollowRuleDefinition(undo.serverId, undo.previous, undo.expectedVersion, signal);
}
