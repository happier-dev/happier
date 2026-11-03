import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
    CapabilityDescriptor,
    CapabilityDetectRequest,
    CapabilityDetectResult,
    CapabilityId,
    ChecklistId,
} from './types';
import { CapabilityError, readCapabilityRefusalDetails } from './errors';
import { readCapabilityInvokeFailure } from '@happier-dev/protocol/capabilities';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { DetectCliSnapshot } from './snapshots/cliSnapshot';
import type { ManagedInstallationServerOriginV1 } from '@happier-dev/protocol/machines/managed/managedInstallationV1';
/** Host-private current Machine ingress, never a capability/Action operand. */
export type MachineSystemTaskResponseContext = Readonly<{
    admission: NonNullable<import('@/api/rpc/types').RpcHandlerContext['machineAdmission']>;
    callerAuthority: import('@/api/rpc/types').RpcHandlerContext['callerAuthority'];
    verifyCurrent: NonNullable<import('@/api/rpc/types').RpcHandlerContext['verifyMachineAdmissionCurrent']>;
    signal: AbortSignal;
}>;

/** Shared transient-input admission for an already owned Machine operation. */
export async function assertMachineSystemTaskResponseCurrent(authorization: unknown, expected: Readonly<{
    admission: MachineSystemTaskResponseContext['admission'];
    verifyCurrent(): Promise<boolean>;
}>): Promise<void> {
    // The capabilities ingress supplies this private value, never the operand.
    const response = authorization && typeof authorization === 'object'
        ? authorization as Partial<MachineSystemTaskResponseContext> : null;
    const admission = response?.admission;
    if (!admission || response?.callerAuthority !== 'present_user' || admission.role !== 'manage'
        || admission.actorAccountId !== expected.admission.actorAccountId
        || admission.custodianAccountId !== expected.admission.custodianAccountId
        || admission.machineId !== expected.admission.machineId
        || admission.installationId !== expected.admission.installationId
        || admission.encryptionMode !== expected.admission.encryptionMode
        || !response.signal || response.signal.aborted || typeof response.verifyCurrent !== 'function'
        || !await response.verifyCurrent() || !await expected.verifyCurrent() || response.signal.aborted) {
        throw new SystemTaskExecutionError('permission_denied', 'Current operation Machine admission is required');
    }
}
export type CapabilitiesInvokeContext = Readonly<{ signal?: AbortSignal; managedInstallationAuthorization?: ManagedInstallationServerOriginV1;
    machineSystemTaskResponse?: MachineSystemTaskResponseContext; executeEffects?: CapabilityEffectExecution }>;

/** Host-owned effect facts, not a wire descriptor or caller-selected permission. */
export type CapabilityEffects = readonly ('private_read' | 'file_write' | 'process' | 'machine_install')[];
export type CapabilityEffectExecution = <T>(effects: CapabilityEffects, execute: () => Promise<T>) => Promise<T>;
const UNCLASSIFIED_EFFECTS: CapabilityEffects = ['private_read', 'file_write', 'process'];

export type CapabilitiesDetectContext = {
    accountId?: string;
    cliSnapshot: DetectCliSnapshot | null;
};

export type CapabilitiesDetectContextBuilder = (requests: CapabilityDetectRequest[]) => Promise<CapabilitiesDetectContext>;

export type Capability = {
    descriptor: CapabilityDescriptor;
    /** Empty means public data only. Unclassified definitions fail closed. */
    effects?: Readonly<{
        detect: CapabilityEffects | ((request: CapabilityDetectRequest) => CapabilityEffects);
        invoke?: Readonly<Record<string, CapabilityEffects>>;
    }>;
    detect: (args: { request: CapabilityDetectRequest; context: CapabilitiesDetectContext }) => Promise<unknown>;
    invoke?: (args: {
        method: string;
        params?: Record<string, unknown>;
        signal?: AbortSignal;
        managedInstallationAuthorization?: ManagedInstallationServerOriginV1;
        machineSystemTaskResponse?: MachineSystemTaskResponseContext;
    }) => Promise<CapabilitiesInvokeResponse>;
};

export type CapabilitiesService = {
    describe: () => CapabilitiesDescribeResponse;
    detect: (data: CapabilitiesDetectRequest, custody?: Readonly<{ accountId?: string; executeEffects?: CapabilityEffectExecution }>) => Promise<CapabilitiesDetectResponse>;
    invoke: (
        data: CapabilitiesInvokeRequest,
        context?: CapabilitiesInvokeContext,
    ) => Promise<CapabilitiesInvokeResponse>;
};

function mergeOverrides(
    rawRequests: CapabilityDetectRequest[],
    overrides: CapabilitiesDetectRequest['overrides'] | undefined,
): CapabilityDetectRequest[] {
    const safeOverrides = overrides ?? {};
    return rawRequests.map((r) => {
        const overrideParams = safeOverrides[r.id]?.params;
        if (!overrideParams) return r;
        return { ...r, params: { ...(r.params ?? {}), ...overrideParams } };
    });
}

function applyTopLevelDetectParams(
    rawRequests: CapabilityDetectRequest[],
    params: Readonly<{ bypassCache?: boolean }>,
): CapabilityDetectRequest[] {
    if (params.bypassCache !== true) return rawRequests;
    return rawRequests.map((request) => ({
        ...request,
        params: {
            ...(request.params ?? {}),
            bypassCache: true,
        },
    }));
}

function selectRequestsFromChecklist(opts: {
    checklistId: ChecklistId | undefined;
    checklists: Record<ChecklistId, CapabilityDetectRequest[]>;
    requests: CapabilityDetectRequest[] | undefined;
}): CapabilityDetectRequest[] {
    if (opts.checklistId) return opts.checklists[opts.checklistId] ?? [];
    return Array.isArray(opts.requests) ? opts.requests : [];
}

export function createCapabilitiesService(opts: {
    capabilities: Capability[];
    checklists: Record<ChecklistId, CapabilityDetectRequest[]>;
    buildContext: CapabilitiesDetectContextBuilder;
}): CapabilitiesService {
    const capabilityMap = new Map<CapabilityId, Capability>();
    for (const cap of opts.capabilities) {
        capabilityMap.set(cap.descriptor.id, cap);
    }

    const describe = (): CapabilitiesDescribeResponse => ({
        protocolVersion: 1,
        capabilities: opts.capabilities.map((c) => c.descriptor),
        checklists: opts.checklists,
    });

    const detect: CapabilitiesService['detect'] = async (data, custody) => {
        const selectedChecklistId = data?.checklistId;
        const rawRequests = selectRequestsFromChecklist({
            checklistId: selectedChecklistId,
            checklists: opts.checklists,
            requests: data?.requests,
        });

        const requests = applyTopLevelDetectParams(
            mergeOverrides(rawRequests, data?.overrides),
            { bypassCache: data?.bypassCache === true },
        );
        // Select the complete effective request before shared discovery: a mixed
        // checklist must not run its public prefix before a protected refusal.
        const effects = [...new Set(requests.flatMap(request => {
            const cap = capabilityMap.get(request.id);
            if (!cap) return [];
            const definition = cap.effects?.detect;
            return typeof definition === 'function' ? definition(request) : definition ?? UNCLASSIFIED_EFFECTS;
        }))];
        const execute = async (): Promise<CapabilitiesDetectResponse> => {
            const checkedAt = Date.now();
            const context = { ...await opts.buildContext(requests.filter(request => capabilityMap.has(request.id))), accountId: custody?.accountId };

            const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {};
            for (const req of requests) {
                const cap = capabilityMap.get(req.id);
                if (!cap) {
                    results[req.id] = { ok: false, checkedAt, error: { message: `Unknown capability: ${req.id}`, code: 'unknown-capability' } };
                    continue;
                }

                try {
                    const dataOut = await cap.detect({ request: req, context });
                    results[req.id] = { ok: true, checkedAt, data: dataOut };
                } catch (e) {
                    const message = e instanceof Error ? e.message : 'Detect failed';
                    const code = e instanceof CapabilityError ? e.code : 'detect-failed';
                    results[req.id] = { ok: false, checkedAt, error: { message, code } };
                }
            }
            return { protocolVersion: 1, results };
        };
        return effects.length && custody?.executeEffects
            ? await custody.executeEffects(effects, execute) : await execute();
    };

    const invoke = async (
        data: CapabilitiesInvokeRequest,
        context: CapabilitiesInvokeContext = {},
    ): Promise<CapabilitiesInvokeResponse> => {
        const id = data?.id as CapabilityId | undefined;
        const method = typeof data?.method === 'string' ? data.method.trim() : '';
        if (!id || !method) {
            return { ok: false, error: { message: 'Invalid capabilities.invoke request', code: 'invalid-request' } };
        }

        const cap = capabilityMap.get(id);
        if (!cap || !cap.invoke) {
            return { ok: false, error: { message: `Unsupported capability: ${String(id)}`, code: 'unsupported-capability' } };
        }
        if (!Object.prototype.hasOwnProperty.call(cap.descriptor.methods ?? {}, method)) {
            return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
        }

        try {
            const effects = cap.effects?.invoke?.[method] ?? UNCLASSIFIED_EFFECTS;
            const execute = async () => await cap.invoke!({
                method,
                params: data?.params,
                ...(context.signal ? { signal: context.signal } : {}),
                ...(context.managedInstallationAuthorization ? { managedInstallationAuthorization: context.managedInstallationAuthorization } : {}),
                ...(context.machineSystemTaskResponse ? { machineSystemTaskResponse: context.machineSystemTaskResponse } : {}),
            });
            return effects.length && context.executeEffects
                ? await context.executeEffects(effects, execute) : await execute();
        } catch (e) {
            // Native Agent errors also carry a typed code without adopting the
            // SDK PluginError envelope. Admit only a code token, never prose.
            const failure = readCapabilityInvokeFailure(e) ?? (
                e instanceof Error && 'code' in e && typeof e.code === 'string'
                    && /^[A-Za-z][A-Za-z0-9_-]*(?![\s\S])/.test(e.code)
                    ? readCapabilityInvokeFailure({ errorCode: e.code,
                        ...('retryable' in e ? { retryable: e.retryable } : {}),
                        ...('details' in e ? { details: e.details } : {}),
                    }) : null
            );
            const details = readCapabilityRefusalDetails(e);
            if (failure) return { ok: false, error: { code: failure.errorCode, message: failure.errorCode,
                ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
                ...(details ? { details } : {}) } };
            return { ok: false, error: { message: 'invoke-failed', code: 'invoke-failed' } };
        }
    };

    return { describe, detect, invoke };
}
