import {
    PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1,
} from "@happier-dev/protocol";
import {
    readPluginsFeatureEnv,
    type WebhookIngressPolicyV1,
} from "@/app/features/catalog/readFeatureEnv";

export type { WebhookIngressPolicyV1 } from "@/app/features/catalog/readFeatureEnv";

/** Public ingress deadline through durable admission or a bounded rejection. */
export const PLUGIN_WEBHOOK_INGRESS_DEADLINE_MS_V1 = 8_000;

/** The feature/config owner is the sole source of adjustable ingress limits. */
export function resolvePluginWebhookIngressPolicyV1(env: NodeJS.ProcessEnv): WebhookIngressPolicyV1 {
    return readPluginsFeatureEnv(env).webhookIngressPolicy;
}

/**
 * The process admission owner reserves the fixed-size raw `Uint8Array` that
 * `readWebhookRawBodyV1` allocates before ingress can authenticate or route a
 * request. Later content/envelope representations have their own protocol
 * ceilings; this policy does not invent a V8 peak from those unrelated limits.
 */
export function resolvePluginWebhookIngressWorkingBytesV1(declaredRawBytes: number): number {
    if (
        !Number.isSafeInteger(declaredRawBytes)
        || declaredRawBytes < 0
        || declaredRawBytes > PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1
    ) {
        throw new TypeError("Plugin webhook working-byte charge requires a bounded declared raw body length");
    }
    return declaredRawBytes;
}

export const PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_ROWS_V1 = 10_000;
export const PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_ROWS_V1 = 50_000;
export const PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_BYTES_V1 = 512n * 1_024n * 1_024n;
export const PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_BYTES_V1 = 2n * 1_024n * 1_024n * 1_024n;
export const PLUGIN_WEBHOOK_ACCOUNT_TERMINAL_ROWS_V1 = 100_000;

export function resolvePluginWebhookDeliveryQuotaRejectionV1(params: Readonly<{
    endpointPayloadRows: number;
    accountPayloadRows: number;
    endpointPayloadBytes: bigint;
    accountPayloadBytes: bigint;
    accountTerminalRows: number;
    candidatePayloadBytes: bigint;
}>): "endpointPayloadRows" | "accountPayloadRows" | "endpointPayloadBytes" | "accountPayloadBytes" | "accountTerminalRows" | null {
    if (
        !Number.isInteger(params.endpointPayloadRows)
        || !Number.isInteger(params.accountPayloadRows)
        || !Number.isInteger(params.accountTerminalRows)
        || params.endpointPayloadRows < 0
        || params.accountPayloadRows < 0
        || params.accountTerminalRows < 0
        || params.endpointPayloadBytes < 0n
        || params.accountPayloadBytes < 0n
        || params.candidatePayloadBytes <= 0n
    ) {
        throw new TypeError("Plugin webhook quota facts must be nonnegative integers with positive candidate bytes");
    }
    if (params.endpointPayloadRows + 1 > PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_ROWS_V1) return "endpointPayloadRows";
    if (params.accountPayloadRows + 1 > PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_ROWS_V1) return "accountPayloadRows";
    if (
        params.endpointPayloadBytes + params.candidatePayloadBytes
        > PLUGIN_WEBHOOK_ENDPOINT_PAYLOAD_BYTES_V1
    ) return "endpointPayloadBytes";
    if (
        params.accountPayloadBytes + params.candidatePayloadBytes
        > PLUGIN_WEBHOOK_ACCOUNT_PAYLOAD_BYTES_V1
    ) return "accountPayloadBytes";
    if (params.accountTerminalRows >= PLUGIN_WEBHOOK_ACCOUNT_TERMINAL_ROWS_V1) return "accountTerminalRows";
    return null;
}
