import axios from 'axios';
import { readManagedMachineRead } from '@/machines/managed/readManagedMachine';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ExternalActionWorkflowPreparationV1Schema, isExternalActionRequestVersionAllowedForAccountModeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { bindManagedPresetAcquireOriginV1 } from '@happier-dev/cli-common/machines/managed';
import { ManagedAcquireInputV1Schema, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1, ManagedMachinePresetGetResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import type { StoredCredentials } from '@/persistence';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** The host reads the public preset; it never enumerates the pool's private Machines. */
export async function prepareOriginalAccountManagedPresetAcquire(params: Readonly<{
    input: ManagedAcquireInputV1 | Readonly<{ selection: Omit<Extract<ManagedAcquireInputV1['selection'], { kind: 'preset' }>, 'revision'> }>;
    requestId: string; credentials: StoredCredentials;
    serverHttpBaseUrl: string; signal?: AbortSignal;
}>) {
    if (params.input.selection.kind !== 'preset') return null;
    const homeUrl = normalizeServerHttpBaseUrl(params.serverHttpBaseUrl);
    const config = { headers: { Authorization: `Bearer ${params.credentials.token}` },
        ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true };
    const response = await axios.post<unknown>(`${homeUrl}${machinePresetActionEndpointPathV1('machines.presets.get')}`,
        { homeId: params.input.selection.homeId, id: params.input.selection.id }, config);
    const projected = ManagedMachinePresetGetResultV1Schema.safeParse(response.data);
    if (!projected.success) return { kind: 'refused' as const, code: 'managed_response_invalid' };
    if (projected.data.kind === 'refused') return projected.data;
    if (response.status < 200 || response.status >= 300) return { kind: 'refused' as const, code: 'admission_unavailable' };
    const input = ManagedAcquireInputV1Schema.parse({
        ...params.input, selection: { ...params.input.selection,
            revision: 'revision' in params.input.selection ? params.input.selection.revision : projected.data.preset.revision },
    });
    return bindManagedPresetAcquireOriginV1({ input, preset: projected.data.preset, requestKey: params.requestId,
        resolveExact: async input => (await axios.post<unknown>(`${homeUrl}${MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1}`, input, config)).data,
        resolvePool: async input => (await axios.post<unknown>(
            `${homeUrl}${machinePoolActionEndpointPathV1('machines.pools.resolve')}`, input, config)).data });
}

/** Rejoin the existing creation before consulting mutable saved routing again. */
export async function prepareOriginalAccountWorkflowPlacement(params: Readonly<{
    start: import('@happier-dev/protocol/workflows/actionsV1').WorkflowRunStartRequestV1;
    project: import('@happier-dev/protocol/workflows/workflowWorkspaceV1').WorkflowProjectTargetV1;
    accountId: string; authentication: import('@happier-dev/protocol/actions/externalActionApi').ExternalActionSignedAuthenticationV1;
    accountEncryptionMode: 'plain' | 'e2ee';
    material?: Extract<import('@happier-dev/protocol/crypto/accountScopedCipher').AccountScopedCryptoMaterial, { type: 'dataKey' }>;
    credentials: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
}>) {
    const placement = params.project.sessionPlacement;
    if (placement?.kind !== 'preset') return null;
    let retained: Awaited<ReturnType<typeof readManagedMachineRead>> | undefined;
    try {
        retained = await readManagedMachineRead({ credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl,
            homeId: placement.homeId, creationRequestId: params.start.runId, ...(params.signal ? { signal: params.signal } : {}) });
    } catch (error) {
        if (!(error instanceof ManagedMachineControllerError) || error.code !== 'managed_not_found') throw error;
    }
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
    const bound = await prepareOriginalAccountManagedPresetAcquire({ input: { selection: {
        kind: 'preset', homeId: placement.homeId, id: placement.presetId } }, requestId: params.start.runId,
        credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl, ...(params.signal ? { signal: params.signal } : {}) });
    if (!bound || bound.kind === 'refused') return bound;
    const preparation = ExternalActionWorkflowPreparationV1Schema.parse({ project: params.project, acquisition: bound.input });
    return { ...bound, workflowPreparation: preparation, retainedRoot: undefined };
}
