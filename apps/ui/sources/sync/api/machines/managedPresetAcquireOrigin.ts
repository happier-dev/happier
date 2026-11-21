import { bindManagedPresetAcquireOriginV1, prepareManagedWorkflowPlacementV1 } from '@happier-dev/cli-common/machines/managed';
import { MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedAcquireInputV1Schema, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createManagedMachineActionClient, ManagedMachineActionError } from './managedMachineActions';
import { createMachinePresetActionClient } from './managedMachinePresets';

/** Same requester-bound Preset origin binder for native acquire and Session preparation. */
export function bindUiManagedPresetAcquireOriginV1(params: Omit<Parameters<typeof bindManagedPresetAcquireOriginV1>[0], 'resolveExact'> & Readonly<{
    account: LazyActionAccountContext; signal?: AbortSignal;
}>) {
    const { account, signal, ...binding } = params;
    return bindManagedPresetAcquireOriginV1({ ...binding, resolveExact: async input => {
        const response = await account.request(MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
            ...(signal ? { signal } : {}),
        }, { includeAuth: true, retry: 'none' });
        return await response.json();
    } });
}

/** Read the selected public Preset once, then use the native acquisition binder. */
export async function prepareUiManagedPresetAcquire(params: Readonly<{
    account: LazyActionAccountContext;
    selection: Omit<Extract<ManagedAcquireInputV1['selection'], { kind: 'preset' }>, 'revision'>;
    requestId: string;
    resolvePool: Parameters<typeof bindManagedPresetAcquireOriginV1>[0]['resolvePool'];
    signal?: AbortSignal;
}>) {
    const read = await createMachinePresetActionClient({ request: params.account.request }).execute('machines.presets.get', {
        homeId: params.selection.homeId, id: params.selection.id,
    }, { signal: params.signal });
    if (read.kind === 'refused') return read;
    const input = ManagedAcquireInputV1Schema.parse({ selection: { ...params.selection, revision: read.preset.revision } });
    return bindUiManagedPresetAcquireOriginV1({ account: params.account, signal: params.signal,
        input, preset: read.preset, requestKey: params.requestId, resolvePool: params.resolvePool });
}

/** Originate the Workflow on the exact Account and Home captured by the app. */
export function prepareUiManagedWorkflowPlacement(params: Omit<Parameters<typeof prepareManagedWorkflowPlacementV1>[0], 'readRetained' | 'bindPreset'> & Readonly<{
    account: LazyActionAccountContext; signal?: AbortSignal;
}>) {
    const { account, signal, ...request } = params;
    return prepareManagedWorkflowPlacementV1({
        ...request,
        readRetained: async input => {
            try {
                return await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', input, { signal });
            } catch (error) {
                if (!(error instanceof ManagedMachineActionError) || error.code !== 'managed_not_found') throw error;
                return null;
            }
        },
        bindPreset: (selection, requestId) => prepareUiManagedPresetAcquire({
            account, signal, selection: { kind: 'preset', ...selection }, requestId,
            resolvePool: async input => {
                const response = await account.request(machinePoolActionEndpointPathV1('machines.pools.resolve'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
                    ...(signal ? { signal } : {}),
                }, { includeAuth: true, retry: 'none' });
                return await response.json();
            },
        }),
    });
}
