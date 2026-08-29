import { z } from 'zod';

import {
  PluginDeclarativeNodeV2Schema,
  type PluginDeclarativeNodeV2,
} from './v2.js';

export {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_DEPTH_V1,
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1,
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_PLAIN_VALUES_V1,
  parsePluginDeclarativeDocumentResourceBytesV1,
  preflightPluginDeclarativeDocumentV1,
  type PluginDeclarativeDocumentPreflightFailureV1,
  type PluginDeclarativeDocumentPreflightResultV1,
} from './declarativeDocumentPreflightV1.js';

/** The strict, browser-safe authored envelope for one declarative document. */
export type PluginDeclarativeDocumentV1 = Readonly<{
  version: 1;
  root: PluginDeclarativeNodeV2;
}>;

export const PluginDeclarativeDocumentV1Schema: z.ZodType<PluginDeclarativeDocumentV1> = z.object({
  version: z.literal(1),
  root: PluginDeclarativeNodeV2Schema,
}).strict();

/** The exact Resource media type and validator for the author-facing envelope. */
export {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  PluginDeclarativeDocumentContentTypeV1Schema,
  isPluginDeclarativeDocumentContentTypeV1,
  type PluginDeclarativeDocumentContentTypeV1,
} from './declarativeDocumentContentTypeV1.js';
