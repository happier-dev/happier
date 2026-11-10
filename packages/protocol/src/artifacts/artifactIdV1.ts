import { z } from '../zodRuntimePolicy.js';

/** New Artifact identities share the HTTP creation grammar; retained addresses stay tolerant. */
export const ArtifactCreateIdV1Schema = z.string().check(z.uuid());
