import {
    PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 as canonicalContentType,
    preflightPluginDeclarativeDocumentV1,
    PluginDeclarativeDocumentV1Schema as canonicalDocumentSchema,
} from '@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring';
import type {
    PluginDeclarativeDocumentContentTypeV1,
    PluginDeclarativeDocumentV1,
} from './publicContract.js';

export type {
    PluginDeclarativeDocumentContentTypeV1,
    PluginDeclarativeDocumentV1,
} from './publicContract.js';

/**
 * The only content type a dynamic Resource may declare for a host-rendered
 * declarative document. Its runtime identity remains Protocol-owned.
 */
export const PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1: PluginDeclarativeDocumentContentTypeV1 =
    canonicalContentType;

/**
 * Validates author data through the canonical Protocol grammar before it is
 * serialized by a dynamic Resource. Manifest/resource ingestion and live
 * document normalization remain host-owned; this helper has no second reader
 * or renderer path.
 */
export function definePluginDeclarativeDocumentV1(
    document: PluginDeclarativeDocumentV1,
): PluginDeclarativeDocumentV1 {
    const preflight = preflightPluginDeclarativeDocumentV1(document);
    if (!preflight.ok) {
        throw new TypeError(preflight.message);
    }
    const parsed = canonicalDocumentSchema.safeParse(preflight.document);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
}
