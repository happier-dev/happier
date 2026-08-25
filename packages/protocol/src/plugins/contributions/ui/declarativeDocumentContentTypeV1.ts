import { z } from 'zod';

/** The exact Resource media type that can carry a V1 declarative document. */
export const PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 =
  'application/vnd.happier.declarative-document+json;version=1';
export const PluginDeclarativeDocumentContentTypeV1Schema = z.literal(
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
);
export type PluginDeclarativeDocumentContentTypeV1 = z.infer<
  typeof PluginDeclarativeDocumentContentTypeV1Schema
>;

/**
 * One encoded UTF-8 document boundary for static and dynamic declarative
 * authoring. It protects synchronous browser/Hermes decode, parse and model
 * adoption; it is deliberately distinct from both the generic 16 MiB Resource
 * transport ceiling and the retired aggregate-string/depth quotas.
 */
export const MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1 = 512 * 1024;

/** Whether one Resource metadata value is exactly the V1 document media type. */
export function isPluginDeclarativeDocumentContentTypeV1(
  contentType: unknown,
): contentType is PluginDeclarativeDocumentContentTypeV1 {
  return PluginDeclarativeDocumentContentTypeV1Schema.safeParse(contentType).success;
}
