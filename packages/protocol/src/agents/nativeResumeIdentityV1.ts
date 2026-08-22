import { z } from 'zod';

/**
 * Provider-native resume identity: the Agent's own conversation id, in its
 * catalog's terms.
 *
 * It is a wrapper around one string rather than the bare string because the
 * value travels through generic session-state writers that also carry released
 * bare-string forms, and a versioned object is what lets a reader tell "this
 * producer published an identity" from "this producer published nothing".
 *
 * There is deliberately NO continuity proof here (`AM-24`). Resuming is what
 * answers whether a recorded id is still usable: a failed native resume is loud
 * in both Agents that support it — Claude raises
 * `ClaudeAgentSdkResumeIdentityMismatchError` and Codex's `thread/resume` throws
 * with no fresh-start fallback — so a pre-check was a second decision-maker for
 * a question the ordinary resume path already answers, and it was never general
 * (15 Agents declare vendor resume; exactly one declared a proof field). Storing
 * the id and resuming from it is the same contract every other Happier resume
 * already has.
 *
 * The Agent's own session-log PATH is a separate, still-live concept: it is the
 * pointer a successor Agent is handed so it can read the predecessor's log. It
 * is catalog-declared on the Agent's `resume` config and published into session
 * metadata by the Agent's runtime; it never gates a resume.
 */
export const AgentNativeResumeIdentityV1Schema = z
  .object({
    v: z.literal(1),
    vendorResumeId: z.string().trim().min(1).max(512),
  })
  .strict();
export type AgentNativeResumeIdentityV1 = z.infer<typeof AgentNativeResumeIdentityV1Schema>;
