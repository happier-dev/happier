import { MachineSetupApplyInputV1Schema, MachineSetupPlanResultV1Schema, type MachineSetupApplyInputV1,
  type MachineSetupPlanInputV1, type MachineSetupSourceApplyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { matchesMachineSetupCreationSourcesV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Prepare the same reviewed creation operand for signed and local dispatch. */
export async function prepareManagedMachineSetupApplyInput(input: Readonly<{
    target: Pick<MachineSetupPlanInputV1, 'homeId' | 'machineId'>;
    creation: Parameters<typeof matchesMachineSetupCreationSourcesV1>[1];
    readPlan: (input: MachineSetupPlanInputV1) => Promise<ActionExecuteResult>;
}>): Promise<MachineSetupApplyInputV1 | Extract<ActionExecuteResult, { ok: false }>> {
    const fail = (code: 'invalid_action_output' | 'plan_changed') =>
        ({ ok: false as const, errorCode: code, error: code });
    const planned = await input.readPlan(input.target);
    if (!planned.ok) return planned;
    const current = MachineSetupPlanResultV1Schema.safeParse(planned.result);
    if (!current.success) return fail('invalid_action_output');
    const { preset, setup } = input.creation;
    // The exact opened copy remains local only, where the creation snapshot
    // comparison belongs. Actions/Home carry the persisted author mode and
    // address, never its private setup body.
    const localSource = { kind: 'accountPreset' as const, presetId: preset.id, presetRevision: preset.revision,
      contentEncryptionMode: preset.contentEncryptionMode, setup };
    const opaqueSource = { kind: 'accountPresetOpaque' as const, presetId: preset.id, presetRevision: preset.revision,
      contentEncryptionMode: preset.contentEncryptionMode };
    const direct = current.data.sources.find(copy => copy.kind === 'direct');
    // A creation proof cannot absorb unrelated current setup intent.
    if (!direct || current.data.sources.some(copy => copy.kind !== 'direct'
        && !sameStrictJsonValue(copy, opaqueSource)))
        return fail('plan_changed');
    if (!matchesMachineSetupCreationSourcesV1([localSource, direct], input.creation)) return fail('plan_changed');
    const sources: MachineSetupSourceApplyV1 = [opaqueSource, direct];

    const effects = await input.readPlan({ ...input.target, sources, mode: 'effects' });
    if (!effects.ok) return effects;
    const prepared = MachineSetupPlanResultV1Schema.safeParse(effects.result);
    if (!prepared.success || prepared.data.recipePlans === undefined) return fail('invalid_action_output');
    if (prepared.data.desiredRevision !== current.data.desiredRevision || !sameStrictJsonValue(prepared.data.sources, sources))
        return fail('plan_changed');
    return MachineSetupApplyInputV1Schema.parse({
        ...input.target,
        targets: [{ ...input.target, sources: prepared.data.sources,
            desiredRevision: prepared.data.desiredRevision, recipePlans: prepared.data.recipePlans,
            exclusions: prepared.data.exclusions,
            ...(prepared.data.removeItemKeys === undefined ? {} : { removeItemKeys: prepared.data.removeItemKeys }) }],
    });
}
