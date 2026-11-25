import { PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 as canonicalContentType } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDocumentContentTypeV1';
import type { PluginDeclarativeDocumentContentTypeV1 } from './publicContract.js';

/** Media type for a host-rendered declarative document. */
export const PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1: PluginDeclarativeDocumentContentTypeV1 =
    canonicalContentType;
