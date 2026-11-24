import type { JsonValue, PluginConnectedAccountAuthenticationModeV2, QualifiedConnectedAccountCredentialPayloadV1 } from '@happier-dev/protocol';
import { listConnectedAccountSecretCredentialKeysV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { CANONICAL_CONNECTED_ACCOUNT_SECRET_CREDENTIAL_KEYS_V1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { readCredentialRedactionValues } from '../plugins/http/credentialRedactionValues.js';
import { projectConnectedAccountConfiguredEndpoints } from './configuredOrigins.js';

type ConnectedAccountCredentialRedaction = Readonly<{
    observeSecret(value: string | null): string | null;
    readCredentialRedactionValue(key: string, value: string | null): string | null;
    readPublicValues(): readonly string[];
    /**
     * The real secret values of this admitted pair, with their rendered variants: credential keys the
     * descriptor marks secret or the canonical credential shape holds secrets in, values read through
     * Saved Secret custody, and configuration secrets. Never metadata (modes, ids, labels, expiry):
     * a Session transcript masks every occurrence of what it registers.
     */
    readSecretValues(): readonly string[];
}>;

/** Host-only classification over the exact admitted credential/configuration pair. */
export function createConnectedAccountCredentialRedaction(input: Readonly<{
    mode: PluginConnectedAccountAuthenticationModeV2;
    credential: QualifiedConnectedAccountCredentialPayloadV1;
    configuration: Readonly<Record<string, JsonValue>>;
    configurationSecrets?: Readonly<Record<string, string>>;
}>): ConnectedAccountCredentialRedaction {
    const endpoints = projectConnectedAccountConfiguredEndpoints({
        configuration: 'configuration' in input.mode ? input.mode.configuration : undefined,
        values: input.configuration,
    });
    const endpointValues = new Set(endpoints.flatMap(endpoint => [endpoint.origin, endpoint.base]));
    const secretKeys = listConnectedAccountSecretCredentialKeysV1(input.mode);
    const transcriptSecretKeys = new Set([...secretKeys.keys(), ...CANONICAL_CONNECTED_ACCOUNT_SECRET_CREDENTIAL_KEYS_V1]);
    // Log redaction keeps every credential value; the secret set keeps only real secrets.
    const secrets = new Set<string>();
    const realSecrets = new Set<string>();
    const addVariants = (target: Set<string>, value: string) => {
        for (const variant of readCredentialRedactionValues({ rawCredential: value, authorizationValue: value })) target.add(variant);
    };
    /** A value read through Saved Secret custody (credential secretRefs or configuration secrets). */
    const observeSecret = (value: string | null): string | null => {
        if (value !== null) {
            addVariants(secrets, value);
            addVariants(realSecrets, value);
        }
        return value;
    };
    const readCredentialRedactionValue = (key: string, value: string | null): string | null => {
        // Endpoint attestations are public only by the descriptor's configured
        // facts. Held and declared secret fields retain their secret provenance.
        if (value !== null && endpointValues.has(value) && !secretKeys.has(key)
            && !Object.hasOwn(input.credential.secretRefs ?? {}, key)) return null;
        if (value !== null) {
            addVariants(secrets, value);
            if (transcriptSecretKeys.has(key) || Object.hasOwn(input.credential.secretRefs ?? {}, key)) addVariants(realSecrets, value);
        }
        return value;
    };
    for (const [key, value] of Object.entries(input.credential.values)) readCredentialRedactionValue(key, value);
    for (const value of Object.values(input.configurationSecrets ?? {})) observeSecret(value);

    const readPublicValues = (): readonly string[] => {
        const values = new Set<string>();
        const collect = (value: JsonValue): void => {
            if (typeof value === 'string') {
                if (value.length === 0) return;
                for (const secret of secrets) if (value.includes(secret)) return;
                values.add(value);
            } else if (value !== null && typeof value === 'object') {
                for (const child of Object.values(value)) collect(child);
            }
        };
        for (const value of Object.values(input.configuration)) collect(value);
        for (const value of endpointValues) collect(value);
        return Object.freeze([...values]);
    };
    const readSecretValues = (): readonly string[] => Object.freeze([...realSecrets]);
    return Object.freeze({ observeSecret, readCredentialRedactionValue, readPublicValues, readSecretValues });
}
