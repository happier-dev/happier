import { ManagedAcquireInputV1Schema, isManagedPresetAcquireInputV1, unwrapManagedMachineReadV1, type ManagedMachineActionOutputV1, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetAcquireRoutingResultV1Schema, type ManagedMachinePresetAcquireRoutingInputV1, type ManagedMachinePresetAcquireOriginV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachinePoolErrorV1Schema, MachinePoolResolveResultV1Schema, type MachinePoolResolveInputV1 } from '@happier-dev/protocol/machines/pools';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { ExternalActionWorkflowPreparationV1Schema, isExternalActionRequestVersionAllowedForAccountModeV1,
    type ExternalActionSignedAuthenticationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import type { WorkflowRunStartRequestV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

export type ManagedPresetAcquireOriginV1 = Readonly<{
    kind: 'bound'; input: ManagedAcquireInputV1; controllerAccess?: ManagedControllerAccessV1;
}> | Readonly<{ kind: 'refused'; code: string }>;

/** Fresh origins select once; admission and later execution consume this exact input. */
export async function bindManagedPresetAcquireOriginV1(params: Readonly<{
    input: ManagedAcquireInputV1; preset: ManagedMachinePresetAcquireOriginV1; requestKey: string;
    resolvePool: (input: MachinePoolResolveInputV1) => Promise<unknown>;
    resolveExact: (input: ManagedMachinePresetAcquireRoutingInputV1) => Promise<unknown>;
}>): Promise<ManagedPresetAcquireOriginV1> {
    const { input, preset } = params;
    const refused = (code: string): ManagedPresetAcquireOriginV1 => ({ kind: 'refused', code });
    if (!isManagedPresetAcquireInputV1(input)) return refused('invalid_parameters');
    if (input.selection.id !== preset.id || input.selection.homeId !== preset.homeId) return refused('managed_response_invalid');
    if (input.selection.revision !== preset.revision) return refused('request_conflict');
    // Retention and wake are the only public preset acquisition choices. The
    // launch, setup, provider review, and Team authorization stay respectively
    // in the private content, the installed custodian, and Home admission.
    if (preset.retention !== undefined && input.retention !== undefined && !sameStrictJsonValue(input.retention, preset.retention)
        || preset.wakeOnAcceptedMessage !== undefined && input.wakeOnAcceptedMessage !== undefined && input.wakeOnAcceptedMessage !== preset.wakeOnAcceptedMessage) return refused('permission_denied');
    if (preset.controllerPoolId) {
        // An already-bound invocation must retain its original carrier, never select again.
        if (input.controller) return refused('controller_unavailable');
        const payload = await params.resolvePool({
            poolId: preset.controllerPoolId, requestKey: params.requestKey, purpose: 'managed-preset',
            preset: { homeId: preset.homeId, id: preset.id, revision: preset.revision },
        });
        const poolError = MachinePoolErrorV1Schema.safeParse(payload);
        if (poolError.success) return refused(poolError.data.code);
        const projected = MachinePoolResolveResultV1Schema.safeParse(payload);
        if (!projected.success || projected.data.poolId !== preset.controllerPoolId) return refused('managed_response_invalid');
        const placement = projected.data;
        if (placement.kind === 'unavailable') return refused(placement.code ?? placement.reason);
        const bound = placement.managedPreset;
        if (!bound || bound.controller.machineId !== placement.machineId) return refused('managed_response_invalid');
        return { kind: 'bound', controllerAccess: bound.controllerAccess,
            input: ManagedAcquireInputV1Schema.parse({ ...input, controller: bound.controller }) };
    }
    if (input.controller && !sameStrictJsonValue(preset.controller, input.controller)) return refused('controller_retired');
    if (!preset.controller) return { kind: 'bound', input };
    const payload = await params.resolveExact({ homeId: preset.homeId, id: preset.id,
        revision: preset.revision, controller: preset.controller });
    const resolved = ManagedMachinePresetAcquireRoutingResultV1Schema.safeParse(payload);
    if (!resolved.success) return refused('managed_response_invalid');
    if (resolved.data.kind === 'refused') return refused(resolved.data.code);
    if (!sameStrictJsonValue(resolved.data.controller, preset.controller)) return refused('controller_retired');
    return { kind: 'bound', input: ManagedAcquireInputV1Schema.parse({ ...input, controller: resolved.data.controller }),
        controllerAccess: resolved.data.controllerAccess };
}

/** Rejoin an existing creation before consulting mutable saved placement. */
export async function prepareManagedWorkflowPlacementV1(params: Readonly<{
    start: WorkflowRunStartRequestV1;
    project: WorkflowProjectTargetV1;
    accountId: string;
    authentication: ExternalActionSignedAuthenticationV1;
    accountEncryptionMode: 'plain' | 'e2ee';
    material?: Extract<AccountScopedCryptoMaterial, { type: 'dataKey' }>;
    readRetained: (input: { homeId: string; creationRequestId: string }) => Promise<ManagedMachineActionOutputV1<'machines.managed.get'> | null>;
    bindPreset: (input: { homeId: string; id: string }, requestId: string) => Promise<ManagedPresetAcquireOriginV1 | null>;
}>) {
    const placement = params.project.sessionPlacement;
    if (placement?.kind !== 'preset') return null;
    const retained = await params.readRetained({ homeId: placement.homeId, creationRequestId: params.start.runId });
    if (retained) {
        const root = retained.retainedWorkflowRoot;
        if (!root || root.binding.accountId !== params.accountId || root.binding.serverIdentityId !== placement.homeId
            || !('authentication' in root.binding) || !sameStrictJsonValue(root.binding.authentication, params.authentication)
            || !isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: params.accountEncryptionMode,
                envelopeVersion: root.envelope.v })) return { kind: 'refused' as const, code: 'currentness_conflict' };
        const opened = root.envelope.v === 1 ? root.envelope : params.material
            ? openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                envelope: root.envelope, binding: root.binding, material: params.material }) : null;
        const preparation = opened?.workflowPreparation;
        const machine = unwrapManagedMachineReadV1(retained);
        if (!preparation || !sameStrictJsonValue(opened?.input, params.start)
            || !sameStrictJsonValue(preparation.project, params.project)
            || preparation.acquisition.selection.homeId !== placement.homeId || preparation.acquisition.selection.id !== placement.presetId
            || root.binding.target.kind !== 'machine' || root.binding.target.machineId !== preparation.acquisition.controller.machineId
            || !sameStrictJsonValue(machine.controller, preparation.acquisition.controller)) {
            return { kind: 'refused' as const, code: 'currentness_conflict' };
        }
        return { kind: 'bound' as const, input: preparation.acquisition, workflowPreparation: preparation,
            retainedRoot: root, ...(machine.controllerAccess ? { controllerAccess: machine.controllerAccess } : {}) };
    }
    const bound = await params.bindPreset({ homeId: placement.homeId, id: placement.presetId }, params.start.runId);
    if (!bound || bound.kind === 'refused') return bound;
    const preparation = ExternalActionWorkflowPreparationV1Schema.safeParse({ project: params.project, acquisition: bound.input });
    if (!preparation.success) return { kind: 'refused' as const, code: 'managed_response_invalid' };
    return { ...bound, workflowPreparation: preparation.data, retainedRoot: undefined };
}
