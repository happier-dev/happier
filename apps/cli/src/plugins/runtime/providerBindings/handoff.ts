import {
    AgentProviderBindingLaunchMaterializationV1Schema,
    PROVIDER_BINDING_MATERIALIZATION_LIMITS_V1,
    SessionProviderBindingMetadataV1Schema,
    type AgentProviderBindingLaunchMaterializationV1,
    type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

export const HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY =
    'HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export type ProviderBindingLaunchHandoffV1 = Readonly<{
    v: 1;
    materialization: AgentProviderBindingLaunchMaterializationV1;
    sessionBindingMetadata: SessionProviderBindingMetadataV1;
}>;

const ProviderBindingLaunchHandoffV1Schema: z.ZodType<ProviderBindingLaunchHandoffV1> = z.object({
    v: z.literal(1),
    materialization: AgentProviderBindingLaunchMaterializationV1Schema,
    sessionBindingMetadata: SessionProviderBindingMetadataV1Schema,
}).strict();

export function serializeProviderBindingLaunchHandoffForEnv(
    input: AgentProviderBindingLaunchMaterializationV1,
    sessionBindingMetadata: SessionProviderBindingMetadataV1,
): string {
    const materialization = AgentProviderBindingLaunchMaterializationV1Schema.parse(input);
    const parsed = ProviderBindingLaunchHandoffV1Schema.parse({
        v: 1,
        materialization,
        sessionBindingMetadata,
    });
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
