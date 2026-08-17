import { z } from 'zod';

import { SessionAgentActivityHeadlineV1Schema } from './agentActivity/agentActivityHeadlineV1.js';
import { SessionWorkflowActivityHeadlineV1Schema } from './workflow/sessionWorkflowActivityHeadlineV1.js';

/**
 * Both session-activity headline keys for one publish, carried together.
 *
 * They describe the SAME committed run snapshots in two vocabularies — the workflow key in runs and
 * counts, the agent-activity key in per-entry rows. Handing them to the transport as one value is
 * what makes "the two keys never disagree about what exists" structural rather than a convention: a
 * producer with two separate publish calls writes session metadata twice per drain (double the write
 * traffic on every progress tick) and leaves a window in which the two keys describe different
 * worlds.
 *
 * `workflow` keeps its exact released shape and key. This bundle is the expand step only — an older
 * client reading `sessionWorkflowActivityHeadlineV1` sees precisely what it saw before.
 */
export const SessionActivityHeadlineBundleV1Schema = z
  .object({
    workflow: SessionWorkflowActivityHeadlineV1Schema,
    agentActivity: SessionAgentActivityHeadlineV1Schema,
  })
  .strip();
export type SessionActivityHeadlineBundleV1 = z.infer<typeof SessionActivityHeadlineBundleV1Schema>;
