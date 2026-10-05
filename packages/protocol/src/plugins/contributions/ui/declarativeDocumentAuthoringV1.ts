import { z } from 'zod';
import { isPluginDeclarativeDataNodeV1, validatePluginDeclarativeDataNodeV1, type PluginDeclarativeDataSourceV1 } from './declarativeDataV1.js';

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
  // UI contribution schemas consume this document while their Action grammar
  // is still initializing. Defer the reverse edge until a document is parsed.
  root: z.lazy(() => PluginDeclarativeNodeV2Schema),
}).strict().superRefine((document, context) => {
  const pending = [document.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isPluginDeclarativeDataNodeV1(node)) {
      try { validatePluginDeclarativeDataNodeV1(node); }
      catch { context.addIssue({ code: 'custom', message: 'Declarative data input, output schema or field projection is invalid' }); }
    }
    if ('children' in node) pending.push(...node.children);
  }
});

/** Presentation tree traversal only; actual read admission remains Resource-owned. */
export function readPluginDeclarativeDataSourcesV1(document: PluginDeclarativeDocumentV1): readonly PluginDeclarativeDataSourceV1[] {
  const sources: PluginDeclarativeDataSourceV1[] = [];
  const pending = [document.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (isPluginDeclarativeDataNodeV1(node)) sources.push(node.data);
    if ('children' in node) pending.push(...node.children);
  }
  return sources;
}

/** The exact Resource media type and validator for the author-facing envelope. */
export {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  PluginDeclarativeDocumentContentTypeV1Schema,
  isPluginDeclarativeDocumentContentTypeV1,
  type PluginDeclarativeDocumentContentTypeV1,
} from './declarativeDocumentContentTypeV1.js';
