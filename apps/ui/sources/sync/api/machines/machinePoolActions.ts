import { MachinePoolActionInputSchemasV1, MachinePoolActionOutputSchemasV1, machinePoolActionEndpointPathV1, type MachinePoolActionIdV1, type MachinePoolActionInputV1, type MachinePoolActionOutputV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePoolErrorV1Schema, type MachinePoolErrorV1 } from '@happier-dev/protocol/machines/pools/v1';
import type { ServerFetch } from '@/sync/http/client';

export class MachinePoolActionError extends Error {
    constructor(public readonly status: number, public readonly detail: MachinePoolErrorV1 | null) {
        super(detail?.code ?? `machine_pool_request_failed_${status}`);
        this.name = 'MachinePoolActionError';
        Object.setPrototypeOf(this, MachinePoolActionError.prototype);
    }
}

export type MachinePoolActionClient = Readonly<{
    execute<TActionId extends MachinePoolActionIdV1>(actionId: TActionId, input: MachinePoolActionInputV1<TActionId>, options: Readonly<{ serverId: string; signal?: AbortSignal }>): Promise<MachinePoolActionOutputV1<TActionId>>;
}>;

export function createMachinePoolActionClient(params: Readonly<{
    request: ServerFetch;
}>): MachinePoolActionClient {
    return Object.freeze({
        execute: async <TActionId extends MachinePoolActionIdV1>(actionId: TActionId, input: MachinePoolActionInputV1<TActionId>, options: Readonly<{ serverId: string; signal?: AbortSignal }>): Promise<MachinePoolActionOutputV1<TActionId>> => {
            const parsedInput = MachinePoolActionInputSchemasV1[actionId].parse(input);
            const response = await params.request(machinePoolActionEndpointPathV1(actionId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsedInput), ...(options.signal ? { signal: options.signal } : {}) }, { includeAuth: true });
            const payload: unknown = await response.json();
            if (!response.ok) {
                const parsedError = MachinePoolErrorV1Schema.safeParse(payload);
                throw new MachinePoolActionError(response.status, parsedError.success ? parsedError.data : null);
            }
            return MachinePoolActionOutputSchemasV1[actionId].parse(payload) as MachinePoolActionOutputV1<TActionId>;
        },
    });
}
