import {
    classifyVoiceProviderHttpFailure as canonicalClassifyVoiceProviderHttpFailure,
} from '@happier-dev/protocol/voice/providerOperations';
import {
    VoiceCredentialSlotIdSchema as canonicalVoiceCredentialSlotIdSchema,
    VoiceProviderContributionSchema as canonicalVoiceProviderContributionSchema,
} from '@happier-dev/protocol/plugins/contributions/voice';
import type {
    VoiceAvailabilityPlatform,
    VoiceCredentialAccessPhase,
    VoiceCredentialDeclaration,
    VoiceCredentialOperationProjection,
    VoiceCredentialSlotId,
    VoiceProviderContribution,
    VoiceProviderSettings,
    VoiceRawCredentialGrantDeclaration,
    VoiceSettingReadinessDeclaration,
} from '@happier-dev/protocol/plugins/contributions/voice';
import {
    VoiceModelPackContributionV1Schema as canonicalVoiceModelPackContributionV1Schema,
    VoiceModelPackDirectoryArtifactV1Schema as canonicalVoiceModelPackDirectoryArtifactV1Schema,
    VoiceModelPackExecutionHostV1Schema as canonicalVoiceModelPackExecutionHostV1Schema,
    VoiceModelPackFileArtifactV1Schema as canonicalVoiceModelPackFileArtifactV1Schema,
    VoiceModelPackKokoroArtifactsV1Schema as canonicalVoiceModelPackKokoroArtifactsV1Schema,
    VoiceModelPackLicenseV1Schema as canonicalVoiceModelPackLicenseV1Schema,
    VoiceModelPackLocalIdV1Schema as canonicalVoiceModelPackLocalIdV1Schema,
    VoiceModelPackManifestV1Schema as canonicalVoiceModelPackManifestV1Schema,
    VoiceModelPackRuntimeV1Schema as canonicalVoiceModelPackRuntimeV1Schema,
    VoiceModelPackSupportArtifactKindV1Schema as canonicalVoiceModelPackSupportArtifactKindV1Schema,
    VoiceModelPackSupportArtifactV1Schema as canonicalVoiceModelPackSupportArtifactV1Schema,
    VoiceModelPackTransducerArtifactsV1Schema as canonicalVoiceModelPackTransducerArtifactsV1Schema,
} from '@happier-dev/protocol/voice/modelPacks/contributionV1';
import type {
    VoiceModelPackContributionV1,
    VoiceModelPackDirectoryArtifactV1,
    VoiceModelPackExecutionHostV1,
    VoiceModelPackFileArtifactV1,
    VoiceModelPackKokoroArtifactsV1,
    VoiceModelPackLicenseV1,
    VoiceModelPackManifestV1,
    VoiceModelPackRuntimeV1,
    VoiceModelPackSupportArtifactKindV1,
    VoiceModelPackSupportArtifactV1,
    VoiceModelPackTransducerArtifactsV1,
} from '@happier-dev/protocol/voice/modelPacks/contributionV1';
import type {
    VoiceRealtimeJsonValue,
} from '@happier-dev/protocol/voice/realtime';

import type { PluginCancellationOptions } from '../lifecycle.js';
import type { InteractionsService } from '../interactions.js';
import type {
    ConnectedAccountMaterialization,
    ConnectedAccountMaterializationRequest,
} from '../connectedAccounts.js';
import type { PluginSettingsActionRuntime } from '../settingsActions.js';
import type { PluginContributionLocalId } from '../identity.js';
import type {
    RealtimeVoiceProviderRuntime,
    VoiceClientToolDefinition,
} from './client.js';
import type { SpeechProviderRuntime } from './speech.js';

export type { ConnectedAccountHttpHeadersRequest } from '../connectedAccounts.js';

export type VoiceSchema<TOutput> = Readonly<{
    parse(value: unknown): TOutput;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: TOutput }>
        | Readonly<{ success: false; error: unknown }>;
    optional(): VoiceSchema<TOutput | undefined>;
    array(): VoiceSchema<TOutput[]>;
}>;

function createVoiceSchema<TOutput>(
    parse: (value: unknown) => TOutput,
): VoiceSchema<TOutput> {
    return Object.freeze({
        parse,
        safeParse(value: unknown):
            | Readonly<{ success: true; data: TOutput }>
            | Readonly<{ success: false; error: unknown }> {
            try {
                return Object.freeze({ success: true as const, data: parse(value) });
            } catch (error) {
                return Object.freeze({ success: false as const, error });
            }
        },
        optional(): VoiceSchema<TOutput | undefined> {
            return createVoiceSchema((value) => value === undefined ? undefined : parse(value));
        },
        array(): VoiceSchema<TOutput[]> {
            return createVoiceSchema((value) => {
                if (!Array.isArray(value)) throw new Error('invalid_voice_schema_array');
                return value.map((item) => parse(item));
            });
        },
    });
}

function isVoiceRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function createVoiceRecordSchema<TOutput>(
    valueSchema: VoiceSchema<TOutput>,
): VoiceSchema<Readonly<Record<string, TOutput>>> {
    return createVoiceSchema((value) => {
        if (!isVoiceRecord(value)) throw new Error('invalid_voice_schema_record');
        return Object.freeze(Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, valueSchema.parse(entry)]),
        ));
    });
}

export function withVoiceSchemaField<
    TBase extends Readonly<Record<string, unknown>>,
    TFieldName extends string,
    TField,
>(
    baseSchema: VoiceSchema<TBase>,
    fieldName: TFieldName,
    fieldSchema: VoiceSchema<TField>,
): VoiceSchema<
    TBase extends unknown
        ? TFieldName extends keyof TBase
            ? [Exclude<TBase[TFieldName], undefined>] extends [never]
                ? TBase
                : {} extends Pick<TBase, TFieldName>
                    ? Omit<TBase, TFieldName> & Readonly<Partial<Record<TFieldName, TField>>>
                    : Omit<TBase, TFieldName> & Readonly<Record<TFieldName, TField>>
            : TBase
        : never
>;
export function withVoiceSchemaField(
    baseSchema: VoiceSchema<Readonly<Record<string, unknown>>>,
    fieldName: string,
    fieldSchema: VoiceSchema<unknown>,
): VoiceSchema<Readonly<Record<string, unknown>>> {
    return createVoiceSchema((value) => {
        const parsed = baseSchema.parse(value);
        if (!isVoiceRecord(parsed)) throw new Error('invalid_voice_schema_field_base');
        if (!Object.hasOwn(parsed, fieldName)) return parsed;
        return Object.freeze({
            ...parsed,
            [fieldName]: fieldSchema.parse(parsed[fieldName]),
        });
    });
}

export type {
    VoiceAvailabilityPlatform,
    VoiceCredentialAccessPhase,
    VoiceCredentialDeclaration,
    VoiceCredentialOperationProjection,
    VoiceCredentialSlotId,
    VoiceProviderContribution,
    VoiceProviderSettings,
    VoiceRawCredentialGrantDeclaration,
    VoiceSettingReadinessDeclaration,
} from '@happier-dev/protocol/plugins/contributions/voice';

export type {
    VoiceModelPackContributionV1,
    VoiceModelPackDirectoryArtifactV1,
    VoiceModelPackExecutionHostV1,
    VoiceModelPackFileArtifactV1,
    VoiceModelPackKokoroArtifactsV1,
    VoiceModelPackLicenseV1,
    VoiceModelPackManifestV1,
    VoiceModelPackRuntimeV1,
    VoiceModelPackSupportArtifactKindV1,
    VoiceModelPackSupportArtifactV1,
    VoiceModelPackTransducerArtifactsV1,
} from '@happier-dev/protocol/voice/modelPacks/contributionV1';
export const classifyVoiceProviderHttpFailure: (
    status: number,
) => 'credential_unavailable' | 'provider_response_invalid' | null = canonicalClassifyVoiceProviderHttpFailure;
export const VoiceCredentialSlotIdSchema: VoiceSchema<VoiceCredentialSlotId> = canonicalVoiceCredentialSlotIdSchema;
export const VoiceProviderContributionSchema: VoiceSchema<VoiceProviderContribution> = canonicalVoiceProviderContributionSchema;
export const VoiceModelPackContributionV1Schema: VoiceSchema<VoiceModelPackContributionV1> = canonicalVoiceModelPackContributionV1Schema;
export const VoiceModelPackDirectoryArtifactV1Schema: VoiceSchema<VoiceModelPackDirectoryArtifactV1> = canonicalVoiceModelPackDirectoryArtifactV1Schema;
export const VoiceModelPackExecutionHostV1Schema: VoiceSchema<VoiceModelPackExecutionHostV1> = canonicalVoiceModelPackExecutionHostV1Schema;
export const VoiceModelPackFileArtifactV1Schema: VoiceSchema<VoiceModelPackFileArtifactV1> = canonicalVoiceModelPackFileArtifactV1Schema;
export const VoiceModelPackKokoroArtifactsV1Schema: VoiceSchema<VoiceModelPackKokoroArtifactsV1> = canonicalVoiceModelPackKokoroArtifactsV1Schema;
export const VoiceModelPackLicenseV1Schema: VoiceSchema<VoiceModelPackLicenseV1> = canonicalVoiceModelPackLicenseV1Schema;
export const VoiceModelPackLocalIdV1Schema: VoiceSchema<string> = canonicalVoiceModelPackLocalIdV1Schema;
export const VoiceModelPackManifestV1Schema: VoiceSchema<VoiceModelPackManifestV1> = canonicalVoiceModelPackManifestV1Schema;
export const VoiceModelPackRuntimeV1Schema: VoiceSchema<VoiceModelPackRuntimeV1> = canonicalVoiceModelPackRuntimeV1Schema;
export const VoiceModelPackSupportArtifactKindV1Schema: VoiceSchema<VoiceModelPackSupportArtifactKindV1> = canonicalVoiceModelPackSupportArtifactKindV1Schema;
export const VoiceModelPackSupportArtifactV1Schema: VoiceSchema<VoiceModelPackSupportArtifactV1> = canonicalVoiceModelPackSupportArtifactV1Schema;
export const VoiceModelPackTransducerArtifactsV1Schema: VoiceSchema<VoiceModelPackTransducerArtifactsV1> = canonicalVoiceModelPackTransducerArtifactsV1Schema;

export type VoiceAccountOperationService = Readonly<{
    request(input: Readonly<{
        operationId: string;
        parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        status: number;
        finalUrl: string;
        headers: Readonly<Record<string, string>>;
        body: Uint8Array;
    }>>;
}>;

export type VoiceRawCredentialAccess = Readonly<{
    materialize(
        request: ConnectedAccountMaterializationRequest,
        options?: PluginCancellationOptions,
    ): Promise<ConnectedAccountMaterialization>;
}>;

export type VoiceCredentialAccess<P extends VoiceCredentialAccessPhase> = Readonly<{
    phase: P;
    mediated: VoiceAccountOperationService | null;
    raw: VoiceRawCredentialAccess | null;
}>;

export type VoiceSettingsActionContext = Readonly<{
    credentials: VoiceCredentialAccess<'settings'>;
    interactions: Pick<InteractionsService, 'askQuestions'>;
    signal: AbortSignal;
    tools: readonly VoiceClientToolDefinition[];
}>;

export type VoiceProvidersRegistrationApi = Readonly<{
    register(
        localId: PluginContributionLocalId,
        runtime: (
            | RealtimeVoiceProviderRuntime
            | SpeechProviderRuntime
        ) & Readonly<{
            settingsActions?: PluginSettingsActionRuntime<VoiceSettingsActionContext>;
        }>,
    ): void;
}>;
