import {
    MachinePresetActionInputSchemasV1,
    MachinePresetActionOutputSchemasV1,
    machinePresetActionEndpointPathV1,
    type MachinePresetActionIdV1,
    type MachinePresetActionInputV1,
    type MachinePresetActionOutputV1,
} from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import type { ServerFetch } from '@/sync/http/client';

export class MachinePresetActionError extends Error {
    constructor(public readonly status: number) {
        super(`machine_preset_request_failed_${status}`);
        this.name = 'MachinePresetActionError';
        Object.setPrototypeOf(this, MachinePresetActionError.prototype);
    }
}

export type MachinePresetActionClient = Readonly<{
    execute<TActionId extends MachinePresetActionIdV1>(
        actionId: TActionId,
        input: MachinePresetActionInputV1<TActionId>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<MachinePresetActionOutputV1<TActionId>>;
}>;

/** The Action caller supplies its captured exact-Home request, including Account custody. */
export function createMachinePresetActionClient(params: Readonly<{ request: ServerFetch }>): MachinePresetActionClient {
    return Object.freeze({
        execute: async <TActionId extends MachinePresetActionIdV1>(
            actionId: TActionId,
            input: MachinePresetActionInputV1<TActionId>,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<MachinePresetActionOutputV1<TActionId>> => {
            const body = MachinePresetActionInputSchemasV1[actionId].parse(input);
            const response = await params.request(machinePresetActionEndpointPathV1(actionId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                ...(options?.signal ? { signal: options.signal } : {}),
            }, { includeAuth: true });
            const payload: unknown = await response.json();
            const output = MachinePresetActionOutputSchemasV1[actionId].safeParse(payload);
            if (!output.success) {
                if (!response.ok) throw new MachinePresetActionError(response.status);
                throw output.error;
            }
            if (!response.ok && output.data.kind !== 'conflict' && output.data.kind !== 'refused') {
                throw new MachinePresetActionError(response.status);
            }
            return output.data as MachinePresetActionOutputV1<TActionId>;
        },
    });
}
