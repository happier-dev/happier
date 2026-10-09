import {
    ManagedErrorV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1,
    managedMachineActionEndpointPathV1, type ManagedMachineActionInputV1, type ManagedMachineActionOutputV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ServerFetch } from '@/sync/http/client';

export type ManagedMachineHttpActionId = 'machines.managed.list' | 'machines.managed.get' | 'machines.managed.cancel' | 'machines.managed.setup.skip';

export class ManagedMachineActionError extends Error {
    constructor(public readonly status: number, public readonly code: string) {
        super(code);
        this.name = 'ManagedMachineActionError';
    }
}

/** Public row reads, cancellation and setup skip. Native effects retain their signed target owner. */
export function createManagedMachineActionClient(params: Readonly<{ request: ServerFetch }>) {
    return Object.freeze({
        async execute<T extends ManagedMachineHttpActionId>(actionId: T, input: ManagedMachineActionInputV1<T>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ManagedMachineActionOutputV1<T>> {
            const body = ManagedMachineActionInputSchemasV1[actionId].parse(input);
            const response = await params.request(managedMachineActionEndpointPathV1(actionId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                ...(options?.signal ? { signal: options.signal } : {}),
            }, { includeAuth: true });
            let payload: unknown;
            try { payload = await response.json(); } catch {
                throw new ManagedMachineActionError(response.status, !response.ok && [404, 405, 501].includes(response.status)
                    ? 'unsupported_action' : response.ok ? 'managed_response_invalid' : 'managed_request_failed');
            }
            if (!response.ok) {
                const refusal = ManagedErrorV1Schema.safeParse(payload);
                throw new ManagedMachineActionError(response.status, refusal.success ? refusal.data.code
                    : [404, 405, 501].includes(response.status) ? 'unsupported_action' : 'managed_request_failed');
            }
            const result = ManagedMachineActionOutputSchemasV1[actionId].safeParse(payload);
            if (!result.success) throw new ManagedMachineActionError(response.status, 'managed_response_invalid');
            return result.data as ManagedMachineActionOutputV1<T>;
        },
    });
}
