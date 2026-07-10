import { z } from 'zod';

import { ModelOverrideV1Schema } from '../../metadata/metadataOverridesV1.js';
import { SessionModelSelectionIntentV1Schema } from '../../../providers/selection/v1.js';

/** Canonical value emitted by all new `intent.model` publishers. */
export const SessionStateModelWriteValueSchema = SessionModelSelectionIntentV1Schema;

/**
 * Bounded compatibility input for durable state/metadata written by deployed clients.
 * It is intentionally not a normalized model selection because the generic state layer
 * does not know the session's canonical agent target.
 */
export const SessionStateModelReadCompatValueSchema = z.union([
  SessionModelSelectionIntentV1Schema,
  ModelOverrideV1Schema,
]);

// Existing generic session-state ingress is a read/replay boundary. Keep its public name,
// while new TypeScript publishers are restricted by SessionStateFieldWriteValue.
export const SessionStateModelValueSchema = SessionStateModelReadCompatValueSchema;
