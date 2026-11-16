import { isActionFamilyId } from '../actionFamilies.js';
import { MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1 } from '../../../machines/managed/actionIdsV1.js';
import { ManagedDeleteOutputV1Schema, ManagedMachineActionIdV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '../../../machines/managed/actionsV1.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { MachineReferenceCensusV1Schema, type MachineReferenceCensusV1 } from '../../../machines/machineReferenceCensusV1.js';
import { readRecord } from '../../../inputs/inputRecords.js';
import { normalizeId } from '../inputReading.js';
import { ManagedBootstrapFailureDetailsV1Schema, ManagedControllerRequestFailureDetailsV1Schema, ManagedNativeFailureDetailsV1Schema } from '../../operations/v1.js';
import { normalizeActionExecutorThrownError } from '../resultProjection.js';
import { ManagedRefusalCodeV1Schema } from '../../../machines/managed/providerFactsV1.js';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1, MachinePresetHttpActionIdV1Schema, type MachinePresetActionInputSchemasV1, type MachinePresetActionInputV1 } from '../../../machines/managed/machinePresetActionsV1.js';
import type { ActionExecuteResult, ActionExecutorContext } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecutorDeps } from '../types.js';
import type { z } from '../../../zodRuntimePolicy.js';



export async function dispatchMachineManaged(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'admittedInput' | 'ctx'> & Readonly<{
  isDeferredApprovalResult: (result: ActionExecuteResult) => boolean;
  retireOpenManagedDeleteApprovals: (input: Readonly<{ homeId: string; managedId: string }>, ctx: ActionExecutorContext) => Promise<void>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, admittedInput, ctx, isDeferredApprovalResult, retireOpenManagedDeleteApprovals } = inv;

      const managedMachineActionId = isActionFamilyId(actionId, ManagedMachineActionIdV1Schema) ? actionId : null;
      if (managedMachineActionId !== null) {
        if (managedMachineActionId === 'machines.setup.plan') {
          if (!deps.machineSetupPlan) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.machineSetupPlan({ input: admittedInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.setup.plan']>,
            context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return readActionFailureEnvelope(result) ?? { ok: true, result: ManagedMachineActionOutputSchemasV1['machines.setup.plan'].parse(result) };
        }
        if (managedMachineActionId === 'machines.setup.apply') {
          if (!deps.machineSetupApply) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.machineSetupApply({ input: admittedInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.setup.apply']>,
            context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return readActionFailureEnvelope(result) ?? { ok: true, result };
        }
        if (managedMachineActionId === MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1) {
          if (!deps.machineSetupUpdatesRollout) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.machineSetupUpdatesRollout({
            input: admittedInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.setup.updates.rollout']>,
            context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return readActionFailureEnvelope(result) ?? { ok: true, result };
        }
        if (managedMachineActionId === 'machines.setup.updates.apply') {
          if (!deps.machineSetupUpdatesApply) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.machineSetupUpdatesApply({
            input: admittedInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.setup.updates.apply']>,
            context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return readActionFailureEnvelope(result) ?? { ok: true, result };
        }
        if (managedMachineActionId === 'machines.setup.remove') {
          if (!deps.machineSetupRemove) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.machineSetupRemove({
            input: admittedInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.setup.remove']>,
            context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return readActionFailureEnvelope(result) ?? { ok: true, result };
        }
        if (managedMachineActionId === 'machines.managed.references.get') {
          const input = admittedInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.managed.references.get']>;
          const result = MachineReferenceCensusV1Schema.parse(deps.managedMachineReferences
            ? await deps.managedMachineReferences({ input, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) })
            : { homeId: input.homeId, machineId: null, coverage: 'partial', references: [], unavailable: ['requester_authority'] });
          return { ok: true, result };
        }
        if (!deps.managedMachineAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        try {
          // Acquire can stamp an Agent start after core schema admission.
          const nativeInput = managedMachineActionId === 'machines.managed.acquire'
            ? ManagedMachineActionInputSchemasV1[managedMachineActionId].parse(admittedInput)
            : admittedInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)[typeof managedMachineActionId]>;
          let machineReferences: MachineReferenceCensusV1 | undefined;
          let nativeContext = ctx;
          if (managedMachineActionId === 'machines.managed.delete') {
            const deleteInput = nativeInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.managed.delete']>;
            const reviewedMachineReferences = ctx.reviewedMachineReferences?.homeId === deleteInput.homeId
              ? MachineReferenceCensusV1Schema.parse(ctx.reviewedMachineReferences)
              : undefined;
            machineReferences = reviewedMachineReferences ?? MachineReferenceCensusV1Schema.parse(deps.managedMachineReferences
              ? await deps.managedMachineReferences({ input: deleteInput, context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) })
              : { homeId: deleteInput.homeId, machineId: null, coverage: 'partial', references: [], unavailable: ['requester_authority'] });
            const census = machineReferences;
            const acceptance = ctx.operationAcceptance;
            if (acceptance) nativeContext = { ...ctx, operationAcceptance: { ...acceptance,
              accept: receipt => acceptance.accept(ManagedDeleteOutputV1Schema.parse({ ...readRecord(receipt), machineReferences: census })),
            } };
          }
          const result = await deps.managedMachineAction({
            actionId: managedMachineActionId,
            input: nativeInput,
            context: nativeContext,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          const failure = readActionFailureEnvelope(result);
          if (failure) return failure;
          const projectedResult = machineReferences ? { ...readRecord(result), machineReferences } : result;
          if (managedMachineActionId === 'machines.managed.delete') {
            const deferred = { ok: true as const, result: projectedResult };
            if (isDeferredApprovalResult(deferred)) return deferred;
            const deleteResult = ManagedDeleteOutputV1Schema.parse(projectedResult);
            if (deleteResult.kind === 'accepted') {
              const deleteInput = nativeInput as z.infer<(typeof ManagedMachineActionInputSchemasV1)['machines.managed.delete']>;
              try {
                await retireOpenManagedDeleteApprovals(deleteInput, ctx);
              } catch (error) {
                try {
                  await deps.recordApprovalRetirementWarning?.({
                    code: normalizeId(readRecord(error).code) || 'retirement_failed',
                  });
                } catch {
                  // Retirement and its diagnostics are both post-effect best effort.
                }
              }
            }
            return { ok: true, result: deleteResult };
          }
          return { ok: true, result: projectedResult };
        } catch (error) {
          if (readRecord(error).code === 'action_outcome_unknown') {
            // The managed effect owner could not confirm a dispatched effect.
            // Preserve that existing Action outcome across thrown host errors.
            return { ok: false, ...normalizeActionExecutorThrownError(error, managedMachineActionId),
              errorCode: 'action_outcome_unknown' };
          }
          if (ManagedControllerRequestFailureDetailsV1Schema.safeParse(readRecord(error).details).success
            || ManagedNativeFailureDetailsV1Schema.safeParse(readRecord(error).details).success
            || ManagedBootstrapFailureDetailsV1Schema.safeParse(readRecord(error).details).success) {
            return { ok: false, ...normalizeActionExecutorThrownError(error, managedMachineActionId) };
          }
          const refusal = ManagedRefusalCodeV1Schema.safeParse(readRecord(error).code);
          if (refusal.success) return { ok: false, ...normalizeActionExecutorThrownError(error, managedMachineActionId), errorCode: refusal.data };
          return { ok: false, ...normalizeActionExecutorThrownError(error, managedMachineActionId) };
        }
      }

      const machinePresetActionId = isActionFamilyId(actionId, MachinePresetHttpActionIdV1Schema) ? actionId : null;
      if (actionId === MACHINE_PRESET_PREPARE_ACTION_ID_V1) {
        if (!deps.machinePresetPrepare) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.machinePresetPrepare({
          input: admittedInput as z.infer<(typeof MachinePresetActionInputSchemasV1)[typeof MACHINE_PRESET_PREPARE_ACTION_ID_V1]>,
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
      if (machinePresetActionId !== null) {
        if (machinePresetActionId === 'machines.presets.archive' && deps.machinePresetArchive) {
          const result = await deps.machinePresetArchive({
            input: admittedInput as MachinePresetActionInputV1<'machines.presets.archive'>,
            context: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          return readActionFailureEnvelope(result) ?? { ok: true, result };
        }
        if (!deps.machinePresetAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        const result = await deps.machinePresetAction({
          actionId: machinePresetActionId,
          input: admittedInput as z.infer<(typeof MachinePresetActionInputSchemasV1)[typeof machinePresetActionId]>,
          context: ctx,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return readActionFailureEnvelope(result) ?? { ok: true, result };
      }
  return null;
}
