import { z } from 'zod';

import {
  PluginDeclarativeNodeV2Schema,
  type PluginDeclarativeNodeV2,
} from './v2.js';

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
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  PluginDeclarativeDocumentContentTypeV1Schema,
  isPluginDeclarativeDocumentContentTypeV1,
  type PluginDeclarativeDocumentContentTypeV1,
} from './declarativeDocumentContentTypeV1.js';
