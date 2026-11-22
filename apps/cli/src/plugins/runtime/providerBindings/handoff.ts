import { AgentProviderBindingLaunchMaterializationV1Schema, PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1 } from '@happier-dev/protocol/providers/materialization/v1';
import { SessionProviderBindingMetadataV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import type { AgentProviderBindingLaunchMaterializationV1, SessionProviderBindingMetadataV1 } from '@happier-dev/protocol';
import { z } from 'zod/mini';
import { isDeepStrictEqual } from 'node:util';
import { AgentSessionProviderBindingV1Schema } from '@happier-dev/protocol/providers/sessions/agentSessionProviderBindingV1';
import { ConnectedAccountSessionModelRefV2Schema, type ConnectedAccountSessionModelRefV2 } from '@happier-dev/protocol/providers/selection/v2';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

export const HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY =
    'HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export type ProviderBindingLaunchHandoffV1 = Readonly<{
    v: 1;
    materialization: AgentProviderBindingLaunchMaterializationV1;
}> & (
    | Readonly<{ sessionBindingMetadata: SessionProviderBindingMetadataV1; providerBinding?: never; selection?: never }>
    | Readonly<{ providerBinding: AgentSessionProviderBinding; selection: ConnectedAccountSessionModelRefV2; sessionBindingMetadata?: never }>
);

const ProviderBindingLaunchHandoffV1Schema: z.ZodMiniType<ProviderBindingLaunchHandoffV1> = z.union([
    z.strictObject({
        v: z.literal(1),
        materialization: AgentProviderBindingLaunchMaterializationV1Schema,
        sessionBindingMetadata: SessionProviderBindingMetadataV1Schema,
    }),
    z.strictObject({
        v: z.literal(1),
        materialization: AgentProviderBindingLaunchMaterializationV1Schema,
        providerBinding: AgentSessionProviderBindingV1Schema,
        selection: ConnectedAccountSessionModelRefV2Schema,
    }).check(z.refine(value => 'source' in value.providerBinding && value.providerBinding.source.kind === 'connected_account'
        && qualifiedPurposeKey(value.selection.purpose) === qualifiedPurposeKey(value.providerBinding.source.purpose)
        && isDeepStrictEqual(value.materialization, value.providerBinding.materialization))),
]);

export function serializeProviderBindingLaunchHandoffForEnv(input: ProviderBindingLaunchHandoffV1): string;
export function serializeProviderBindingLaunchHandoffForEnv(
    input: AgentProviderBindingLaunchMaterializationV1,
    sessionBindingMetadata: SessionProviderBindingMetadataV1,
): string;
export function serializeProviderBindingLaunchHandoffForEnv(
    input: AgentProviderBindingLaunchMaterializationV1 | ProviderBindingLaunchHandoffV1,
    sessionBindingMetadata?: SessionProviderBindingMetadataV1,
): string {
    const parsed = ProviderBindingLaunchHandoffV1Schema.parse('materialization' in input
        ? input : { v: 1, materialization: input, sessionBindingMetadata });
    const json = JSON.stringify(parsed);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.launch.maxEncodedBytes) {
        throw new Error('Provider binding launch materialization exceeds its byte limit');
    }
    return Buffer.from(json, 'utf8').toString('base64url');
}

export function consumeProviderBindingLaunchHandoffFromEnvironments(
    environments: readonly NodeJS.ProcessEnv[],
): ProviderBindingLaunchHandoffV1 | undefined {
    const encodedValues = environments.flatMap((environment) => {
        const encoded = environment[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
        delete environment[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
        return encoded === undefined ? [] : [encoded];
    });
    if (encodedValues.length === 0) return undefined;
    if (encodedValues.length !== 1) {
        throw new Error('Invalid provider binding launch materialization handoff');
    }
    const encoded = encodedValues[0];
    const maxEncodedChars = Math.ceil(
        PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.launch.maxEncodedBytes * 4 / 3,
    ) + 4;
    if (encoded.length === 0 || encoded.length > maxEncodedChars || !BASE64URL_PATTERN.test(encoded)) {
        throw new Error('Invalid provider binding launch materialization handoff');
    }
    let json: string;
    try {
        const decoded = Buffer.from(encoded, 'base64url');
        if (decoded.byteLength > PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1.launch.maxEncodedBytes) {
            throw new Error('too large');
        }
        json = decoded.toString('utf8');
    } catch {
        throw new Error('Invalid provider binding launch materialization handoff');
    }
    try {
        const value = JSON.parse(json);
        return ProviderBindingLaunchHandoffV1Schema.parse(value);
    } catch {
        throw new Error('Invalid provider binding launch materialization handoff');
    }
}
