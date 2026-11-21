import axios from 'axios';
import { readManagedMachineRead } from '@/machines/managed/readManagedMachine';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { bindManagedPresetAcquireOriginV1, prepareManagedWorkflowPlacementV1 } from '@happier-dev/cli-common/machines/managed';
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

/** Supply the CLI's captured Account transport to the shared Workflow origination owner. */
export function prepareOriginalAccountWorkflowPlacement(params: Omit<Parameters<typeof prepareManagedWorkflowPlacementV1>[0], 'readRetained' | 'bindPreset'> & Readonly<{
    credentials: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
}>) {
    const { credentials, serverHttpBaseUrl, signal, ...request } = params;
    const account = { credentials, serverHttpBaseUrl, ...(signal ? { signal } : {}) };
    return prepareManagedWorkflowPlacementV1({
        ...request,
        readRetained: async input => {
            try { return await readManagedMachineRead({ ...account, ...input }); }
            catch (error) {
                if (!(error instanceof ManagedMachineControllerError) || error.code !== 'managed_not_found') throw error;
                return null;
            }
        },
        bindPreset: (selection, requestId) => prepareOriginalAccountManagedPresetAcquire({
            ...account, input: { selection: { kind: 'preset', ...selection } }, requestId,
        }),
    });
}
