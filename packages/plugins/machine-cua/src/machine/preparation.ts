import { projectMachineProvisionerActionFailure, defineMachineProvisionerPreparationSchemas,
    createManagedMachinePresetPreparationBuildInputV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { CUA_PLUGIN_ID, createCuaLocalProvisioner, type CuaLocalProvisionerId } from './localProvisioner.js';
import { createCuaLocalSandbox, cuaLocalImageMatches } from './localSandbox.js';
import { createCuaLocalSpace } from './localSpace.js';
import { CuaLocalBaseLaunchV1Schema, CuaLocalLaunchV1Schema, CuaLocalNameSchema } from './schemas.js';
import { cuaPreparedNames, type CuaNativeClient } from './nativeClient.js';

const closed = { policy: 'closed' } as const;
// S1 supplies only credential-free CLI installation and bakeable setup. No guest/resource or enrollment input.
export const CuaPreparationInput = createManagedMachinePresetPreparationBuildInputV1Schema(CuaLocalBaseLaunchV1Schema);
export const CuaPreparationReference = defineProtocolObject({ operationId: CuaLocalNameSchema,
    launch: CuaLocalLaunchV1Schema }, closed);
export const CuaPreparationSchemas = defineMachineProvisionerPreparationSchemas({ input: CuaPreparationInput, launch: CuaLocalLaunchV1Schema,
    artifact: CuaPreparationReference, nativeOperation: CuaPreparationReference });
type Operation = ReturnType<typeof CuaPreparationReference.parse>;

export function createCuaPreparation(native: CuaNativeClient, localId: CuaLocalProvisionerId, observedAt: number, signal?: AbortSignal) {
    // Each existing owner preserves its native sizing and exact registration cleanup.
    const builder = createCuaLocalProvisioner(native, localId, observedAt, signal);
    const leaf = localId === 'local-space' ? createCuaLocalSpace(native) : createCuaLocalSandbox(native);
    const contributionRef = { pluginId: CUA_PLUGIN_ID, localId };
    const reference = (value: Operation) => ({ contributionRef, schemaVersion: 1, value });
    const unknown = (value: Operation) => ({ kind: 'unknown' as const, code: 'cua_preparation_unknown', nativeOperationRef: reference(value) });
    function resource(value: Operation) {
        const sandboxId = `local:${cuaPreparedNames(value.operationId).builder}`;
        return localId === 'local-space' ? { kind: 'space' as const, runtimeId: value.launch.runtimeId, sandboxId, spaceId: sandboxId }
            : { kind: 'sandbox' as const, namespace: 'local' as const, runtimeId: value.launch.runtimeId, sandboxId };
    }
    const ready = (value: Operation) => ({ kind: 'ready' as const, artifact: reference({ ...value,
        launch: { ...value.launch, preparedOperationId: value.operationId } }) });
    async function finishBuild(value: Operation) {
        return (await builder.destroy(resource(value), value.launch.imageId)).kind === 'confirmed' ? ready(value) : unknown(value);
    }
    async function inspect(value: Operation) {
        const checkpoint = await native.preparedCheckpoint(value.operationId, value.launch, signal);
        if (checkpoint.kind === 'unknown') return unknown(value);
        const observed = await leaf.inspect(resource(value), signal);
        if (checkpoint.kind === 'present') {
            if (!checkpoint.pinned || observed.existence === 'unknown'
                || (observed.existence === 'present' && !cuaLocalImageMatches(resource(value).kind, observed.imageId, value.launch.imageId))) return unknown(value);
            return observed.existence === 'absent' ? ready(value)
                : { kind: 'pending' as const, nativeOperationRef: reference(value) };
        }
        if (observed.existence === 'absent') return { kind: 'absent' as const };
        return unknown(value);
    }
    return {
        async build(operationId: string, input: ReturnType<typeof CuaPreparationInput.parse>) {
            const parsed = CuaPreparationReference.safeParse({ operationId, launch: input.launch.choices });
            if (!parsed.success) return { kind: 'refused' as const, code: 'invalid_request' };
            const value = parsed.data;
            try {
                const checkpoint = await native.preparedCheckpoint(operationId, value.launch, signal);
                if (checkpoint.kind === 'unknown') return unknown(value);
                if (checkpoint.kind === 'present') {
                    return checkpoint.pinned ? await finishBuild(value) : unknown(value);
                }
                // An earlier ambiguous create is reconciled, never blindly repeated or reconfigured.
                if ((await leaf.inspect(resource(value), signal)).existence !== 'absent') return unknown(value);
                const created = await builder.acquire(value.launch, `prepared-build-${operationId}`);
                if (created.kind === 'rejected') return { kind: 'refused' as const, code: created.code };
                if (created.kind !== 'bound') return unknown(value);
                const ran = await native.prepareGuest(created.resource.value.sandboxId, input.cli, input.setupScript, signal);
                if (ran.termination.observed.kind !== 'exit' || ran.termination.observed.exitCode !== 0
                    || ran.termination.requestedBy.kind !== 'none') return unknown(value);
                const names = cuaPreparedNames(operationId);
                const saved = await native.effect(['--embedded', 'sandbox', 'checkpoint', `local:${names.builder}`, names.checkpoint, '--pin'], signal);
                if (saved.kind !== 'success') return unknown(value);
                const completed = await native.preparedCheckpoint(operationId, value.launch, signal);
                return completed.kind === 'present' && completed.pinned ? await finishBuild(value) : unknown(value);
            } catch (error) { return projectMachineProvisionerActionFailure(error, () => unknown(value)); }
        },
        async inspect(value: Operation) {
            try { return await inspect(value); }
            catch (error) { return projectMachineProvisionerActionFailure(error, () => unknown(value)); }
        },
        async destroy(value: Operation) {
            try {
                const checkpoint = await native.preparedCheckpoint(value.operationId, value.launch, signal);
                if (checkpoint.kind === 'unknown') return unknown(value);
                if (checkpoint.kind === 'present') {
                    const name = cuaPreparedNames(value.operationId).checkpoint;
                    if (checkpoint.pinned && (await native.effect(['--embedded', 'sandbox', 'checkpoints', 'unpin', name], signal)).kind !== 'success') return unknown(value);
                    if ((await native.effect(['--embedded', 'sandbox', 'checkpoints', 'rm', name], signal)).kind !== 'success'
                        || (await native.preparedCheckpoint(value.operationId, value.launch, signal)).kind !== 'absent') return unknown(value);
                }
                return (await builder.destroy(resource(value), value.launch.imageId)).kind === 'confirmed'
                    ? { kind: 'confirmed' as const } : unknown(value);
            } catch (error) { return projectMachineProvisionerActionFailure(error, () => unknown(value)); }
        },
    };
}
