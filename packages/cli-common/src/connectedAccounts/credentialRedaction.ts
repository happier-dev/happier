import type { JsonValue, PluginConnectedAccountAuthenticationModeV2, QualifiedConnectedAccountCredentialPayloadV1 } from '@happier-dev/protocol';
import { listConnectedAccountSecretCredentialKeysV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { readCredentialRedactionValues } from '../plugins/http/credentialRedactionValues.js';
import { projectConnectedAccountConfiguredEndpoints } from './configuredOrigins.js';

type ConnectedAccountCredentialRedaction = Readonly<{
    observeSecret(value: string | null): string | null;
    readCredentialRedactionValue(key: string, value: string | null): string | null;
    readPublicValues(): readonly string[];
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
    const secrets = new Set<string>();
    const observeSecret = (value: string | null): string | null => {
        if (value !== null) {
            for (const variant of readCredentialRedactionValues({ rawCredential: value, authorizationValue: value })) secrets.add(variant);
        }
        return value;
    };
    const readCredentialRedactionValue = (key: string, value: string | null): string | null => {
        // Endpoint attestations are public only by the descriptor's configured
        // facts. Held and declared secret fields retain their secret provenance.
        if (value !== null && endpointValues.has(value) && !secretKeys.has(key)
            && !Object.hasOwn(input.credential.secretRefs ?? {}, key)) return null;
        return observeSecret(value);
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
    return Object.freeze({ observeSecret, readCredentialRedactionValue, readPublicValues });
}
