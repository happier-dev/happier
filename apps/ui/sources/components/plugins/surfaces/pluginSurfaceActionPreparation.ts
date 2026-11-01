import type { VoiceActionConfirmationBinding } from '@happier-dev/protocol/voice/actions';
import type { VoiceHostTextPlayback } from '@happier-dev/plugin-sdk/voice/client';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginUiActionProjection } from '@/sync/domains/plugins/ui/projection';
import { createFrontDoorActionExecute, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { executeSpokenAction } from '@/voice/tools/executeSpokenAction';
import { projectedActionToDefinition } from '@/components/appShell/currentUiContext/contributedActionDefinition';
import { preparePluginActionConfirmation } from './pluginSurfaceFeedback';
import { clientActionFailure, actionOutcomeUnknownFailure, type PluginSurfaceActionDispatchOutcome } from './actionFailure';
import type { DispatchPluginSurfaceActionInput, PluginSurfaceActionExecutorContext } from './pluginSurfaceActionDispatch';

/** Host-local evidence from the existing Voice attempt; never a tool-authored authority. */
export type PluginSurfaceSpokenActionRequest = Readonly<{
    actionRequestId?: string;
    confirmation?: VoiceActionConfirmationBinding;
    playHostText?: VoiceHostTextPlayback;
}>;

/** Expose the already prepared inner operation through the shared confirmation front door. */
export async function executePreparedPluginSurfaceAction(args: Readonly<{
    input: DispatchPluginSurfaceActionInput;
    identity: PluginContributionIdentityV1;
    action: PluginUiActionProjection;
    normalizedInput: unknown;
    run: (input: DispatchPluginSurfaceActionInput) => Promise<PluginSurfaceActionDispatchOutcome>;
}>): Promise<PluginSurfaceActionDispatchOutcome> {
    const { input, identity, action } = args;
    const spoken = input.spokenActionRequest!;
    const isCurrent = () => input.isCurrent?.() !== false && input.signal?.aborted !== true;
    const presentation = await preparePluginActionConfirmation({ pluginUiProjection: input.pluginUiProjection, isCurrent },
        { action, input: args.normalizedInput, signal: input.signal });
    if (!presentation) return clientActionFailure('plugin_action_generation_retired');
    const wrapper = projectNativeJsonValueForTransport({ action: identity, input: args.normalizedInput ?? null });
    const target = projectNativeJsonValueForTransport({ occurrenceId: action.occurrenceId, execution: action.execution,
        executionOrigin: action.executionOrigin, machineId: input.contributedAction?.machineId,
        serverId: input.hostAction?.context?.serverId ?? input.contributedAction?.serverId });
    const definition = projectedActionToDefinition(action, input.pluginUiProjection ?? null);
    let settledOutcome: PluginSurfaceActionDispatchOutcome | undefined;
    const context: PluginSurfaceActionExecutorContext = {
        ...input.hostAction?.context, surface: 'voice', signal: input.signal,
        // A wrapper's earlier review did not disclose this resolved effect.
        presentUserApproval: undefined, presentUserConfirmation: undefined,
        serverId: input.hostAction?.context?.serverId ?? input.contributedAction?.serverId ?? undefined,
        actionRequestId: spoken.actionRequestId,
        expectedContributedActionOccurrenceId: action.occurrenceId,
        contributedActionInvocation: {
            caller: {},
            listContributedActionDefinitions: () => isCurrent() ? [definition] : [],
            resume: async (request, hostAction): Promise<ActionExecuteResult> => {
                // The shared executor has consumed the exact .confirmed binding.
                // Ordinary execution has no admitted review and keeps the incumbent tap.
                const confirmed = request.context.presentUserApproval?.actionId === 'action.invoke';
                const outcome = settledOutcome = await args.run({ ...input, hostAction,
                    ...(confirmed ? { requestCurrentIntent: async request => ({ status: 'approved' as const, fingerprint: request.fingerprint }) } : {}),
                });
                return outcome.ok ? { ok: true, result: outcome.result }
                    : { ok: false, errorCode: outcome.reason, error: outcome.reason };
            },
        },
    };
    const shared = createFrontDoorActionExecute();
    // This envelope is host-local. It binds the read-back to placement and
    // occurrence as well as operands; only its strict Action input crosses admission.
    const exact = projectNativeJsonValueForTransport({ wrapper, target });
    const stale = (): ActionExecuteResult => ({ ok: false, errorCode: 'approval_stale', error: 'approval_stale' });
    const confirmed: FrontDoorActionExecute['confirmed'] = async (_actionId, value, confirmedContext) => sameStrictJsonValue(value, exact)
        ? shared.confirmed('action.invoke', wrapper, { ...context,
            actionRequestId: confirmedContext?.actionRequestId, defaultSessionId: confirmedContext?.defaultSessionId,
            sessionTargetsV1: confirmedContext?.sessionTargetsV1,
        }) : stale();
    const prepare: FrontDoorActionExecute['prepare'] = async () => {
        const prepared = await shared.prepare('action.invoke', wrapper, context, { reviewOnly: true });
        if (prepared.kind === 'settled' || !prepared.operation) return prepared;
        if (!sameStrictJsonValue(prepared.operation.normalizedInput, wrapper)) return { kind: 'settled' as const, result: stale() };
        return { ...prepared, operation: { ...prepared.operation, normalizedInput: exact,
            inputDigest: computeActionInputApprovalDigestV1('action.invoke', exact, prepared.operation.sessionTargetsV1),
            summary: presentation.message, safety: definition.safety, irreversible: action.irreversible === true,
        } };
    };
    const execute: FrontDoorActionExecute = Object.assign(async () => shared('action.invoke', wrapper, context), { confirmed, prepare });
    const result = await executeSpokenAction(execute, 'action.invoke', exact, context, spoken.confirmation, spoken.playHostText);
    if (settledOutcome) return settledOutcome;
    if (!result.ok) return actionOutcomeUnknownFailure(result.errorCode) ?? clientActionFailure(result.errorCode);
    const parsed = projectNativeJsonValueForTransport(result.result ?? null);
    return { ok: true, result: parsed };
}
