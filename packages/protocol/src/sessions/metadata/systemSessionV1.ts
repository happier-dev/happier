import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/**
 * Factory form (accepts a caller-provided `z`) for nohoist/multi-zod-instance repos.
 * Consumers that need to embed the schema into their own Zod objects should use this
 * instead of importing `SessionSystemSessionV1Schema` directly.
 */
export function createSessionSystemSessionV1Schema(zod: typeof z) {
  return zod.looseObject({
    v: zod.literal(1),
    key: zod.string(),
    hidden: zod.optional(zod.boolean()),
  });
}

export const SessionSystemSessionV1Schema = lazyZodSchema(() => createSessionSystemSessionV1Schema(z));
export type SessionSystemSessionV1 = z.infer<typeof SessionSystemSessionV1Schema>;

export function readSystemSessionMetadataFromMetadata(params: Readonly<{ metadata: unknown }>): SessionSystemSessionV1 | null {
  // Hot path: this runs inside per-session loops on store notifications (session list
  // filtering, voice lookups, CLI row building). Parse only the marker field itself —
  // validating the whole metadata blob here is both wasteful and wrong (a malformed
  // sibling field must not hide a system session).
  const metadata = params.metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const marker = (metadata as Record<string, unknown>).systemSessionV1;
  if (typeof marker !== 'object' || marker === null) return null;
  const parsed = SessionSystemSessionV1Schema.safeParse(marker);
  return parsed.success ? parsed.data : null;
}

export function isHiddenSystemSession(params: Readonly<{ metadata: unknown }>): boolean {
  const systemSession = readSystemSessionMetadataFromMetadata(params);
  return Boolean(systemSession && systemSession.hidden === true);
}

export function buildSystemSessionMetadataV1(params: Readonly<{ key: string; hidden?: boolean }>): { systemSessionV1: SessionSystemSessionV1 } {
  const hidden = params.hidden;
  return {
    systemSessionV1: {
      v: 1,
      key: params.key,
      ...(typeof hidden === 'boolean' ? { hidden } : {}),
    },
  };
}
