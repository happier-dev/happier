import { UsageCoachApplyInputSchema, UsageCoachApplyResultSchema, UsageCoachUndoInputSchema, UsageCoachUndoResultSchema,
    UsageCoachDismissInputSchema, UsageCoachSnoozeInputSchema, UsageCoachPreferenceResultSchema } from '../../usage/coach/coachActions.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export { USAGE_COACH_ACTION_IDS, type UsageCoachActionId } from '../../usage/usageActionIdsV1.js';
const common = { safety: 'danger', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
    placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { commands: [], acceptsServerId: true },
    inputHints: { fields: [{ path: 'query', title: 'Usage query', widget: 'json', required: true, inputType: { hostType: 'usageQuery' } },
        { path: 'evidenceKey', title: 'Finding evidence', widget: 'text', required: true }] },
} satisfies Pick<PreNormalizedActionSpec, 'safety' | 'sideEffectClass' | 'requiredAuthority' | 'executionPlacement' | 'placements' | 'surfaces' | 'cli' | 'inputHints'>;

export const USAGE_COACH_ACTION_SPECS = [
    { ...common, id: 'usage.coach.apply', title: 'Apply a Coach remedy',
        description: 'Re-read the exact authorized query and apply its current supported finding remedy through the canonical owner. Caller-supplied effects and confirmation flags are refused.',
        bindings: { mcpToolName: 'usage_coach_apply' }, inputSchema: UsageCoachApplyInputSchema, outputSchema: UsageCoachApplyResultSchema },
    { ...common, id: 'usage.coach.undo', title: 'Undo a Coach remedy',
        description: 'Restore an exact captured owner value under its atomic conditional mutation and captured Home/Account authority. Incompatible intervening writes refuse restoration even when the original finding is no longer reported.',
        bindings: { mcpToolName: 'usage_coach_undo' }, inputSchema: UsageCoachUndoInputSchema, outputSchema: UsageCoachUndoResultSchema },
    { ...common, id: 'usage.coach.dismiss', title: 'Dismiss or re-enable a Coach finding',
        description: 'Persist dismissal for this exact finding evidence through Account settings. Materially different evidence remains visible.',
        bindings: { mcpToolName: 'usage_coach_dismiss' }, inputSchema: UsageCoachDismissInputSchema, outputSchema: UsageCoachPreferenceResultSchema },
    { ...common, id: 'usage.coach.snooze', title: 'Snooze a Coach finding',
        description: 'Persist an explicit snooze deadline for this exact finding evidence through Account settings.',
        bindings: { mcpToolName: 'usage_coach_snooze' }, inputSchema: UsageCoachSnoozeInputSchema, outputSchema: UsageCoachPreferenceResultSchema },
] as const satisfies readonly PreNormalizedActionSpec[];
