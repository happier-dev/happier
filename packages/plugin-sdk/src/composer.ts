import type { JsonValue } from './identity.js';
import type { PluginContributionRef } from './identity.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 as canonicalComposerMediaContentCapabilityV1,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    PluginComposerAttachmentDefinition,
    PluginComposerControlDefinition,
    PluginComposerReferenceDefinition,
    PluginComposerRegionDefinition,
} from './definePlugin.js';

/** The one negotiated operation required before media selection, staging, or submission. */
export const COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 = canonicalComposerMediaContentCapabilityV1;
export type ComposerMediaContentCapabilityV1 = typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;

export type ComposerContentMediaKindV1 = 'image' | 'video';
export type ComposerContentMimeTypeV1 =
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'image/gif'
    | 'video/webm';

/** Public opaque claim for completed transfer-owned staged media. */
export type ComposerContentHandleV1 = Readonly<{
    v: 1;
    id: string;
    executionTarget: Readonly<{ serverId: string; machineId: string }>;
    owner: PluginContributionRef;
    mediaKind: ComposerContentMediaKindV1;
    mimeType: ComposerContentMimeTypeV1;
    name: string;
    sizeBytes: number;
    sha256: string;
}>;

export type ComposerStagedMediaContentV1 = Readonly<{
    kind: 'stagedMedia';
    handle: ComposerContentHandleV1;
}>;

export type ComposerSessionMediaContentV1 = Readonly<{
    kind: 'sessionMedia';
    mediaId: string;
}>;

export type ComposerContentPickMediaRequestV1 = Readonly<{
    attachmentLocalId: string;
    kinds: readonly ComposerContentMediaKindV1[];
}>;

export type ComposerContentInspectRequestV1 = Readonly<{
    offset: number;
    maxBytes: number;
}>;

/** A bounded inspection result; transfer/session implementation details remain host-private. */
export type ComposerContentInspectResultV1 = Readonly<{
    offset: number;
    bytes: Uint8Array;
    eof: boolean;
}>;

export function defineComposerReference(
    definition: PluginComposerReferenceDefinition,
): PluginComposerReferenceDefinition {
    return definition;
}

type ComposerSchemaValue<TSchema extends ProtocolComposableSchema<unknown, unknown>> =
    Extract<ReturnType<TSchema['parse']>, JsonValue>;

type ComposerPreparedSchemaValue<
    TDraft extends JsonValue,
    TSchema extends ProtocolComposableSchema<unknown, unknown> | undefined,
> = TSchema extends ProtocolComposableSchema<unknown, unknown>
    ? ComposerSchemaValue<TSchema>
    : TDraft;

function defineComposerAttachmentImplementation<
    const TValueSchema extends ProtocolComposableSchema<unknown, unknown>,
    const TPreparedSchema extends ProtocolComposableSchema<unknown, unknown> | undefined = undefined,
>(
    definition: Readonly<
        Omit<
            PluginComposerAttachmentDefinition<
                ComposerSchemaValue<TValueSchema>,
                ComposerPreparedSchemaValue<ComposerSchemaValue<TValueSchema>, TPreparedSchema>
            >,
            'value' | 'preparedValue'
        >
        & Readonly<{
            value: TValueSchema;
            preparedValue?: TPreparedSchema;
        }>
    >,
): PluginComposerAttachmentDefinition<
    ComposerSchemaValue<TValueSchema>,
    ComposerPreparedSchemaValue<ComposerSchemaValue<TValueSchema>, TPreparedSchema>
> {
    // The author helper preserves the exact schema objects at runtime while its
    // public result projects their parsed JSON outputs into the Composer types.
    return definition as PluginComposerAttachmentDefinition<
        ComposerSchemaValue<TValueSchema>,
        ComposerPreparedSchemaValue<ComposerSchemaValue<TValueSchema>, TPreparedSchema>
    >;
}

export const defineComposerAttachment = defineComposerAttachmentImplementation as <
    const TValueSchema extends ProtocolComposableSchema<unknown, unknown>,
    const TPreparedSchema extends ProtocolComposableSchema<unknown, unknown> | undefined = undefined,
>(
    definition: Readonly<
        Omit<
            PluginComposerAttachmentDefinition<
                Extract<ReturnType<TValueSchema['parse']>, JsonValue>,
                TPreparedSchema extends ProtocolComposableSchema<unknown, unknown>
                    ? Extract<ReturnType<TPreparedSchema['parse']>, JsonValue>
                    : Extract<ReturnType<TValueSchema['parse']>, JsonValue>
            >,
            'value' | 'preparedValue'
        >
        & Readonly<{
            value: TValueSchema;
            preparedValue?: TPreparedSchema;
        }>
    >,
) => PluginComposerAttachmentDefinition<
    Extract<ReturnType<TValueSchema['parse']>, JsonValue>,
    TPreparedSchema extends ProtocolComposableSchema<unknown, unknown>
        ? Extract<ReturnType<TPreparedSchema['parse']>, JsonValue>
        : Extract<ReturnType<TValueSchema['parse']>, JsonValue>
>;

export function defineComposerControl(
    definition: PluginComposerControlDefinition,
): PluginComposerControlDefinition {
    return definition;
}

export function defineComposerRegion(
    definition: PluginComposerRegionDefinition,
): PluginComposerRegionDefinition {
    return definition;
}
