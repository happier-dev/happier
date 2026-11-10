import { createHash } from "node:crypto";

import type { PluginWebhookVerifierV1 } from '@happier-dev/protocol/plugins/contributions/webhooks';

function updateLengthPrefixedUtf8(hash: ReturnType<typeof createHash>, value: string): void {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength, 0);
    hash.update(length);
    hash.update(bytes);
}

export function createPluginWebhookDeliveryIdentityDigestV1(params: {
    verifierKind: PluginWebhookVerifierV1['kind'];
    routeId: string;
    providerDeliveryId: string;
}): string {
    const hash = createHash("sha256");
    updateLengthPrefixedUtf8(hash, params.verifierKind);
    updateLengthPrefixedUtf8(hash, params.routeId);
    updateLengthPrefixedUtf8(hash, params.providerDeliveryId);
    return hash.digest("hex");
}
