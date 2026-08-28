import { getActionSpec } from '@happier-dev/protocol/actions';
import type {
    PluginPermissionGrantActionIdV1,
    PluginPermissionGrantDismissRequestActionInputV1,
    PluginPermissionGrantGrantActionInputV1,
    PluginPermissionGrantListActionInputV1,
    PluginPermissionGrantRequestActionInputV1,
    PluginPermissionGrantRevokeActionInputV1,
} from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

export type PluginPermissionGrantUiActionExecutor = (
    actionId: PluginPermissionGrantActionIdV1,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

export type CreatePluginPermissionGrantHttpActionExecutorParams = Readonly<{
    request?: typeof serverFetch;
}>;

function withJsonBody(body: unknown): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}

async function readPluginPermissionGrantJsonResponse(response: Response): Promise<unknown> {
    const payload = await response.json();
    if (response.ok) return payload;
    const parsed = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    const code = typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.errorCode === 'string'
            ? parsed.errorCode
            : null;
    const message = typeof parsed.message === 'string' ? parsed.message : null;
    throw new Error(code ?? message ?? 'plugin_permission_grant_request_failed');
}

async function requestPluginPermissionGrantJson(
    request: typeof serverFetch,
    path: string,
    body: unknown,
): Promise<unknown> {
    const response = await request(path, withJsonBody(body), { includeAuth: true });
    return await readPluginPermissionGrantJsonResponse(response);
}

function parsePluginPermissionGrantInput<TInput>(
    actionId: PluginPermissionGrantActionIdV1,
    input: unknown,
): TInput {
    return getActionSpec(actionId).inputSchema.parse(input) as TInput;
}

function parsePluginPermissionGrantOutput(
    actionId: PluginPermissionGrantActionIdV1,
    output: unknown,
): unknown {
    const outputSchema = getActionSpec(actionId).outputSchema;
    if (!outputSchema) {
        throw new Error('plugin_permission_grant_output_schema_missing');
    }
    return outputSchema.parse(output);
}

export function createPluginPermissionGrantHttpActionExecutor(
    params: CreatePluginPermissionGrantHttpActionExecutorParams = {},
): PluginPermissionGrantUiActionExecutor {
    const request = params.request ?? serverFetch;
    return async (actionId, input, options) => {
        const actionRequest: typeof serverFetch = options?.signal
            ? (path, init, requestOptions) => request(
                path,
                { ...init, signal: options.signal },
                requestOptions,
            )
            : request;
        switch (actionId) {
            case 'plugins.permissions.grants.list': {
                const parsed = parsePluginPermissionGrantInput<PluginPermissionGrantListActionInputV1>(actionId, input);
                const output = await requestPluginPermissionGrantJson(
                    actionRequest,
                    '/v1/plugins/permissions/grants/list',
                    parsed,
                );
                return parsePluginPermissionGrantOutput(actionId, output);
            }
            case 'plugins.permissions.grants.request': {
                const parsed = parsePluginPermissionGrantInput<PluginPermissionGrantRequestActionInputV1>(actionId, input);
                const output = await requestPluginPermissionGrantJson(
                    actionRequest,
                    '/v1/plugins/permissions/grants/request',
                    parsed,
                );
                return parsePluginPermissionGrantOutput(actionId, output);
            }
            case 'plugins.permissions.grants.grant': {
                const parsed = parsePluginPermissionGrantInput<PluginPermissionGrantGrantActionInputV1>(actionId, input);
                const output = await requestPluginPermissionGrantJson(
                    actionRequest,
                    '/v1/plugins/permissions/grants/grant',
                    parsed,
                );
                return parsePluginPermissionGrantOutput(actionId, output);
            }
            case 'plugins.permissions.grants.revoke': {
                const parsed = parsePluginPermissionGrantInput<PluginPermissionGrantRevokeActionInputV1>(actionId, input);
                const output = await requestPluginPermissionGrantJson(
                    actionRequest,
                    '/v1/plugins/permissions/grants/revoke',
                    parsed,
                );
                return parsePluginPermissionGrantOutput(actionId, output);
            }
            case 'plugins.permissions.grants.dismissRequest': {
                const parsed = parsePluginPermissionGrantInput<PluginPermissionGrantDismissRequestActionInputV1>(actionId, input);
                const output = await requestPluginPermissionGrantJson(
                    actionRequest,
                    '/v1/plugins/permissions/grants/dismissRequest',
                    parsed,
                );
                return parsePluginPermissionGrantOutput(actionId, output);
            }
        }
    };
}

export async function executePluginPermissionGrantProtocolAction<TActionId extends PluginPermissionGrantActionIdV1>(
    params: Readonly<{
        execute: PluginPermissionGrantUiActionExecutor;
        actionId: TActionId;
        input: unknown;
    }>,
): Promise<unknown> {
    const input = parsePluginPermissionGrantInput<unknown>(params.actionId, params.input);
    const output = await params.execute(params.actionId, input);
    return parsePluginPermissionGrantOutput(params.actionId, output);
}
