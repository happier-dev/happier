import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { UsageCoachApplyInputSchema, UsageCoachApplyResultSchema, UsageCoachUndoInputSchema, UsageCoachUndoResultSchema,
    UsageCoachDismissInputSchema, UsageCoachSnoozeInputSchema, UsageCoachPreferenceResultSchema } from '../../usage/coach/coachActions.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';

export { USAGE_COACH_ACTION_IDS, type UsageCoachActionId } from '../../usage/usageActionIdsV1.js';
const common = { approvalPolicy: { uiConfirmation: 'direct' }, safety: 'danger', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { commands: [], acceptsServerId: true },
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
        { path: 'evidenceKey', title: 'Finding evidence', widget: 'text', required: true }] },
} satisfies Pick<PreNormalizedActionSpec, 'approvalPolicy' | 'safety' | 'sideEffectClass' | 'requiredAuthority' | 'executionPlacement' | 'placements' | 'surfaces' | 'cli' | 'inputHints'>;

type UsageCoachActionSchemas = {
    'usage.coach.apply': { inputSchema: typeof UsageCoachApplyInputSchema; outputSchema: typeof UsageCoachApplyResultSchema };
    'usage.coach.undo': { inputSchema: typeof UsageCoachUndoInputSchema; outputSchema: typeof UsageCoachUndoResultSchema };
    'usage.coach.dismiss': { inputSchema: typeof UsageCoachDismissInputSchema; outputSchema: typeof UsageCoachPreferenceResultSchema };
    'usage.coach.snooze': { inputSchema: typeof UsageCoachSnoozeInputSchema; outputSchema: typeof UsageCoachPreferenceResultSchema };
};
type UsageCoachActionSpec = {
    [Id in keyof UsageCoachActionSchemas]: ActionSpecProjectionMetadata & typeof common & Readonly<UsageCoachActionSchemas[Id]> & Readonly<{
        id: Id;
        approval: { result: 'required' };
    }>;
}[keyof UsageCoachActionSchemas];
export const USAGE_COACH_ACTION_SPECS: readonly UsageCoachActionSpec[] = lazyActionSpecArray(() => [
    { ...common, id: 'usage.coach.apply', approval: {result: 'required'}, title: 'Apply a Coach remedy',
        description: 'Re-read the exact authorized query and apply its current supported finding remedy through the canonical owner. Caller-supplied effects and confirmation flags are refused.',
        bindings: { mcpToolName: 'usage_coach_apply' }, inputSchema: UsageCoachApplyInputSchema, outputSchema: UsageCoachApplyResultSchema },
    { ...common, id: 'usage.coach.undo', approval: {result: 'required'}, title: 'Undo a Coach remedy',
        description: 'Restore an exact captured owner value under its atomic conditional mutation and captured Home/Account authority. Incompatible intervening writes refuse restoration even when the original finding is no longer reported.',
        bindings: { mcpToolName: 'usage_coach_undo' }, inputSchema: UsageCoachUndoInputSchema, outputSchema: UsageCoachUndoResultSchema },
    { ...common, id: 'usage.coach.dismiss', approval: {result: 'required'}, title: 'Dismiss or re-enable a Coach finding',
        description: 'Persist dismissal for this exact finding evidence in Account KV. Materially different evidence remains visible.',
        bindings: { mcpToolName: 'usage_coach_dismiss' }, inputSchema: UsageCoachDismissInputSchema, outputSchema: UsageCoachPreferenceResultSchema },
    { ...common, id: 'usage.coach.snooze', approval: {result: 'required'}, title: 'Snooze a Coach finding',
        description: 'Persist an explicit snooze deadline for this exact finding evidence in Account KV.',
        bindings: { mcpToolName: 'usage_coach_snooze' }, inputSchema: UsageCoachSnoozeInputSchema, outputSchema: UsageCoachPreferenceResultSchema },
] as const satisfies readonly PreNormalizedActionSpec[]);
