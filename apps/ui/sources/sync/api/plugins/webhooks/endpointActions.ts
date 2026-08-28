import {
    PluginWebhookActionHttpPathsV1,
    PluginWebhookActionInputSchemasV1,
    PluginWebhookActionOutputSchemasV1,
    type PluginWebhookPresentUserActionIdV1,
    PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1,
    PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1,
    PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1,
    PluginWebhookAccountStatusRequestV1Schema,
    PluginWebhookAccountStatusResultV1Schema,
    PluginWebhookDeliveryDiscardInputV1Schema,
    PluginWebhookDeliveryDiscardResultV1Schema,
    PluginWebhookDeliveryReplayInputV1Schema,
    PluginWebhookDeliveryReplayResultV1Schema,
    type PluginWebhookAccountStatusRequestV1,
} from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

export type PluginWebhookEndpointUiActionExecutor = <TActionId extends PluginWebhookPresentUserActionIdV1>(
    actionId: TActionId,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

export function createPluginWebhookEndpointHttpActionExecutor(params: Readonly<{
    request?: typeof serverFetch;
}> = {}): PluginWebhookEndpointUiActionExecutor {
    const request = params.request ?? serverFetch;
    return async (actionId, input, options) => {
        const parsedInput = PluginWebhookActionInputSchemasV1[actionId].parse(input);
        const response = await request(PluginWebhookActionHttpPathsV1[actionId], {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsedInput),
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }, { includeAuth: true });
        const payload: unknown = await response.json();
        if (!response.ok) {
            const record = typeof payload === 'object' && payload !== null
                ? payload as Record<string, unknown>
                : {};
            throw new Error(typeof record.error === 'string'
                ? record.error
                : 'plugin_webhook_endpoint_request_failed');
        }
        return PluginWebhookActionOutputSchemasV1[actionId].parse(payload);
    };
}

async function requestWebhookJson(
    request: typeof serverFetch,
    path: string,
    input: unknown,
): Promise<unknown> {
    const response = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    }, { includeAuth: true });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error('plugin_webhook_status_request_failed');
    return payload;
}

export type PluginWebhookAdministrationHttpClient = Readonly<{
    executeAction: PluginWebhookEndpointUiActionExecutor;
    readStatus: (input: PluginWebhookAccountStatusRequestV1) => Promise<ReturnType<typeof PluginWebhookAccountStatusResultV1Schema.parse>>;
    replayDelivery: (input: unknown) => Promise<ReturnType<typeof PluginWebhookDeliveryReplayResultV1Schema.parse>>;
    discardDelivery: (input: unknown) => Promise<ReturnType<typeof PluginWebhookDeliveryDiscardResultV1Schema.parse>>;
}>;

export function createPluginWebhookAdministrationHttpClient(params: Readonly<{
    request?: typeof serverFetch;
    executeAction?: PluginWebhookEndpointUiActionExecutor;
}> = {}): PluginWebhookAdministrationHttpClient {
    const request = params.request ?? serverFetch;
    return Object.freeze({
        executeAction: params.executeAction ?? createPluginWebhookEndpointHttpActionExecutor({ request }),
        readStatus: async (input: PluginWebhookAccountStatusRequestV1) => {
            const parsed = PluginWebhookAccountStatusRequestV1Schema.parse(input);
            return PluginWebhookAccountStatusResultV1Schema.parse(await requestWebhookJson(
                request,
                PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1,
                parsed,
            ));
        },
        replayDelivery: async (input: unknown) => {
            const parsed = PluginWebhookDeliveryReplayInputV1Schema.parse(input);
            return PluginWebhookDeliveryReplayResultV1Schema.parse(await requestWebhookJson(
                request,
                PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1,
                parsed,
            ));
        },
        discardDelivery: async (input: unknown) => {
            const parsed = PluginWebhookDeliveryDiscardInputV1Schema.parse(input);
            return PluginWebhookDeliveryDiscardResultV1Schema.parse(await requestWebhookJson(
                request,
                PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1,
                parsed,
            ));
        },
    });
}

const activePluginWebhookAdministrationClient = createPluginWebhookAdministrationHttpClient();

export async function readActivePluginWebhookAccountStatus(
    input: PluginWebhookAccountStatusRequestV1,
) {
    return await activePluginWebhookAdministrationClient.readStatus(input);
}

export async function replayActivePluginWebhookDelivery(input: unknown) {
    return await activePluginWebhookAdministrationClient.replayDelivery(input);
}

export async function discardActivePluginWebhookDelivery(input: unknown) {
    return await activePluginWebhookAdministrationClient.discardDelivery(input);
}
