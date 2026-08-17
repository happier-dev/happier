import { decryptString, encryptString } from "@/modules/encrypt";

export type PluginWebhookCredentialIdentityV1 = Readonly<{
    routeId: string;
    verifierKind: "github_hmac_sha256_v1";
    credentialVersionId: string;
}>;

export function pluginWebhookCredentialEncryptionPathV1(identity: PluginWebhookCredentialIdentityV1): string[] {
    return [
        "storage",
        "plugin_webhook_ingress",
        "server_cluster_credential",
        identity.routeId,
        identity.verifierKind,
        identity.credentialVersionId,
        "v1",
    ];
}

export function encryptPluginWebhookCredentialSecretV1(params: PluginWebhookCredentialIdentityV1 & Readonly<{
    secret: string;
}>): Uint8Array<ArrayBuffer> {
    return encryptString(pluginWebhookCredentialEncryptionPathV1(params), params.secret);
}

export function decryptPluginWebhookCredentialSecretV1(params: PluginWebhookCredentialIdentityV1 & Readonly<{
    encryptedSecret: Uint8Array<ArrayBuffer>;
}>): string {
    return decryptString(pluginWebhookCredentialEncryptionPathV1(params), params.encryptedSecret);
}
