import {
    LocalServiceActionRequestV1Schema,
    LocalServiceActionResultV1Schema,
    type LocalServiceActionRequestV1,
    type LocalServiceActionResultV1,
} from '@happier-dev/protocol';

export const LOCAL_SERVICE_ACTION_EXECUTE_ROUTE = '/local-services/actions/execute';

export type LocalServiceActionExecuteRequest = (
    path: string,
    init?: RequestInit,
) => Promise<Response>;

export type LocalServiceActionExecuteClientInput = Readonly<{
    request: LocalServiceActionRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
    executeRequest?: LocalServiceActionExecuteRequest;
}>;

export type LocalServiceActionExecuteClientResult =
    | Readonly<{ ok: true; result: LocalServiceActionResultV1 }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

export function isLocalServiceActionResultForRequest(
    result: LocalServiceActionResultV1,
    request: LocalServiceActionRequestV1,
): boolean {
    return result.requestId === request.requestId
        && result.action === request.action
        && result.auditEvents.length > 0
        && result.auditEvents.every((event) => (
            event.requestId === request.requestId
            && event.action === request.action
            && event.machineId === request.target.machineId
        ));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readResponseResultPayload(value: unknown): unknown {
    if (!isRecord(value)) {
        return null;
    }
    return value.ok === true ? value.result : value;
}

export async function executeLocalServiceActionViaRequest(
    input: LocalServiceActionExecuteClientInput,
): Promise<LocalServiceActionExecuteClientResult> {
    const executeRequest = input.executeRequest;
    if (!executeRequest) {
        return { ok: false, reason: 'unavailable' };
    }

    const request = LocalServiceActionRequestV1Schema.safeParse(input.request);
    if (!request.success) {
        return { ok: false, reason: 'invalid_response' };
    }

    try {
        const response = await executeRequest(LOCAL_SERVICE_ACTION_EXECUTE_ROUTE, {
            method: 'POST',
            signal: input.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.data),
        });
        if (response.status === 404 || response.status === 501) {
            return { ok: false, reason: 'unavailable' };
        }
        if (!response.ok) {
            return { ok: false, reason: 'request_failed' };
        }
        const parsed = LocalServiceActionResultV1Schema.safeParse(
            readResponseResultPayload(await response.json()),
        );
        return parsed.success && isLocalServiceActionResultForRequest(parsed.data, request.data)
            ? { ok: true, result: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
