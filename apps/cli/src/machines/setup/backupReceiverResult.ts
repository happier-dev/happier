import { posix } from 'node:path';
import { z } from 'zod/mini';
import { BackupReceiverEndpointV1Schema, MachineSetupSshHostKeyEvidenceV1Schema, type MachineSetupBackupReceiverResultV1,
  type MachineSetupSshHostKeyEvidenceV1, type MachineSetupNativeSshHostKeyV1 } from '@happier-dev/protocol/machines/setup/backupReceiverV1';
import { BACKUP_RECEIVER_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import type { MachineRecipeSelectionV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

export function isBackupReceiverSelection(selection: MachineRecipeSelectionV1): boolean {
  const ref = selection.ref;
  return ref.pluginId === BACKUP_RECEIVER_RECIPE_REF_V1.pluginId && ref.recipeId === BACKUP_RECEIVER_RECIPE_REF_V1.recipeId
    && ref.revision === BACKUP_RECEIVER_RECIPE_REF_V1.revision;
}
const inputsSchema = z.object({ endpoint: BackupReceiverEndpointV1Schema,
  username: z.string().check(z.minLength(1)), chrootPath: z.string().check(z.minLength(1)), repositoryPath: z.string().check(z.minLength(1)),
});

/** Projection only: the existing native SSH probe owns the public-key witness. */
export function projectBackupReceiverResults(input: Readonly<{
  machineId: string; installationId: string;
  recipes: readonly Readonly<{ sourceIndex: number; itemIndex: number; selection: MachineRecipeSelectionV1;
    evidence?: MachineSetupSshHostKeyEvidenceV1 }>[];
}>): MachineSetupBackupReceiverResultV1[] {
  return input.recipes.flatMap((recipe): MachineSetupBackupReceiverResultV1[] => {
    if (!isBackupReceiverSelection(recipe.selection)) return [];
    const identity = { sourceIndex: recipe.sourceIndex, itemIndex: recipe.itemIndex,
      machineId: input.machineId, installationId: input.installationId };
    const parsed = inputsSchema.safeParse(recipe.selection.inputs);
    if (!parsed.success) return [{ ...identity, status: 'unavailable', reason: 'receiver_inputs_unavailable' }];
    const selected = parsed.data;
    const relative = posix.relative(selected.chrootPath, selected.repositoryPath);
    if (!posix.isAbsolute(selected.chrootPath) || !posix.isAbsolute(selected.repositoryPath)
      || !relative || relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
      return [{ ...identity, endpoint: selected.endpoint, status: 'unavailable', reason: 'receiver_inputs_unavailable' }];
    }
    if (recipe.evidence?.status !== 'ready') return [{ ...identity, endpoint: selected.endpoint, status: 'unavailable',
      reason: recipe.evidence?.reason ?? 'ssh_configuration_unavailable' }];
    const token = selected.endpoint.port === 22 ? selected.endpoint.host : `[${selected.endpoint.host}]:${selected.endpoint.port}`;
    return [{ ...identity, status: 'ready', endpoint: selected.endpoint, username: selected.username,
      path: `/${relative}`, hostKey: `${token} ${recipe.evidence.publicKey}`, fingerprint: recipe.evidence.fingerprint }];
  });
}

/** Apply passes settled native witnesses explicitly; it never reuses Plan evidence. */
export function projectBackupReceiverPlanResults(input: Readonly<{
  machineId: string; installationId: string;
  entries: NonNullable<MachineSetupPlanResultV1['recipePlans']>;
  nativeHostKeys?: readonly MachineSetupNativeSshHostKeyV1[];
  planIndexOffset?: number;
}>): MachineSetupBackupReceiverResultV1[] {
  return projectBackupReceiverResults({ machineId: input.machineId, installationId: input.installationId,
    recipes: input.entries.flatMap((entry, planIndex) => {
      const plan = entry.plan;
      if (plan.basis.kind !== 'setup' || !plan.basis.selection) return [];
      const stepIndex = plan.steps.findIndex(step => step.kind === 'file' && step.probe?.kind === 'sshd' && step.probe.publicHostKeyEvidence);
      const step = plan.steps[stepIndex];
      const observed = input.nativeHostKeys === undefined
        ? plan.nativeFacts[stepIndex]?.facts.sshHostKeyEvidence
        : input.nativeHostKeys.find(key => key.planIndex === planIndex + (input.planIndexOffset ?? 0) && key.stepId === step?.id)?.evidence;
      const evidence = MachineSetupSshHostKeyEvidenceV1Schema.safeParse(observed);
      return [{ sourceIndex: entry.sourceIndex, itemIndex: entry.itemIndex, selection: plan.basis.selection,
        ...(evidence.success ? { evidence: evidence.data } : {}) }];
    }) });
}
