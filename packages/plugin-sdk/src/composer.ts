import type { JsonValue } from './identity.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 as canonicalComposerMediaContentCapabilityV1,
    MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 as canonicalMaxComposerContentInspectBytesV1,
} from '@happier-dev/protocol/plugins/ui/client';
export type {
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectWireResultV1,
    ComposerContentMediaKindV1,
    ComposerContentMimeTypeV1,
    ComposerContentPickMediaRequestV1,
    ComposerMediaContentCapabilityV1,
    ComposerSessionMediaContentV1,
    ComposerStagedMediaContentV1,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    PluginComposerAttachmentDefinition,
    PluginComposerControlDefinition,
    PluginComposerReferenceDefinition,
    PluginComposerRegionDefinition,
} from './definePlugin.js';

/** The one negotiated operation required before media selection, staging, or submission. */
export const COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 = canonicalComposerMediaContentCapabilityV1;
export const MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 = canonicalMaxComposerContentInspectBytesV1;

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
