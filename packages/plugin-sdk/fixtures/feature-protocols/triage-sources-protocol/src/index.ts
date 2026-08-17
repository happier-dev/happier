/**
 * Source-only feature-protocol fixture. It deliberately is not a workspace or
 * publishable package; source-mapped authoring checks consume its public-like
 * `/v1` subpath while publication remains a separate boundary.
 */
export {
  triageSourceDescriptorSchema,
  triageSourceDetailInputSchema,
  triageSourceInspectionInputSchema,
  triageSourceInspectionResultSchema,
  triageSourcesV1,
} from './v1.js';
