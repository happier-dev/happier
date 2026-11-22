import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';
import { MachineSetupApplyInputV1Schema, MachineSetupApplyResultV1Schema } from '../machines/managed/actionsV1.js';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema } from '../projects/openProjectV1.js';
import { deriveActionChildRequestIdV1 } from '../workflows/workflowInvocationIdentityV1.js';
import { TEAM_SETUP_RUN_ACTION_ID_V1, TEAM_SETUP_RUN_CHILD_ACTION_IDS_V1 } from './actionIdsV1.js';

export const TeamSetupBatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)),
  homeId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
  clientId: z.optional(z.string().check(z.minLength(1))),
  machine: z.optional(MachineSetupApplyInputV1Schema),
  repositories: z.array(z.strictObject({
    id: z.string().check(z.minLength(1)),
    input: OpenProjectInputV1Schema,
  })),
}).check(z.superRefine((batch, ctx) => {
  if (batch.machine) {
    const atTarget = (target: { homeId: string; machineId: string }) =>
      target.homeId === batch.homeId && target.machineId === batch.machineId;
    if (!atTarget(batch.machine) || batch.machine.targets.length !== 1 || !atTarget(batch.machine.targets[0]!)) {
      ctx.addIssue({ code: 'custom', path: ['machine'], message: 'Machine Setup must use the selected Home and Machine.' });
    }
  } else if (batch.repositories.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['repositories'], message: 'Select setup work to run.' });
  }
  const seen = new Set<string>();
  for (const [index, repository] of batch.repositories.entries()) {
    if (seen.has(repository.id) || repository.input.serverId !== batch.serverId || repository.input.machineId !== batch.machineId) {
      ctx.addIssue({ code: 'custom', path: ['repositories', index], message: 'Select distinct checkouts on the selected Home and Machine.' });
    }
    seen.add(repository.id);
  }
})));
export type TeamSetupBatchInputV1 = z.infer<typeof TeamSetupBatchInputV1Schema>;

export const TeamSetupBatchResultV1Schema = lazyZodSchema(() => {
  const effect = <T extends z.ZodMiniType>(schema: T) => z.union([
    ActionExecuteFailureSchema,
    z.strictObject({ ok: z.literal(true), result: z.union([schema, ActionApprovalRequestCreatedResultSchema]) }),
  ]);
  return z.strictObject({
    completed: z.boolean(),
    machine: z.nullable(effect(MachineSetupApplyResultV1Schema)),
    machineSettlement: z.nullable(ActionExecuteFailureSchema),
    repositories: z.array(z.strictObject({ id: z.string(), result: effect(OpenProjectResultV1Schema) })),
  });
});
export type TeamSetupBatchResultV1 = z.infer<typeof TeamSetupBatchResultV1Schema>;
export type TeamSetupBatchProgressV1 =
  | Readonly<{ kind: 'machineApplied'; result: NonNullable<TeamSetupBatchResultV1['machine']> }>
  | Readonly<{ kind: 'repositoryOpening'; id: string }>;

/** Observe the existing Project operation slot for each reviewed checkout. */
export function teamSetupRepositoryRequestIdV1(parentRequestId: string, position: number): string {
  return deriveActionChildRequestIdV1({ parentRequestId, parentActionId: TEAM_SETUP_RUN_ACTION_ID_V1,
    childActionId: TEAM_SETUP_RUN_CHILD_ACTION_IDS_V1.repository, position });
}
