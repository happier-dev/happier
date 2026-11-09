import { z } from 'zod';

import { lazySchema } from '../lazySchema.js';
import { readSessionRoleV1 } from '../sessionMetadata/sessionRole.js';

/**
 * Account setting `standaloneSessionPromptV1`: the owner's personalized default for a roleless
 * standalone session. It replaces the Happier default sections the owner has disabled and never
 * assigns a role. Shipped empty.
 */
export const StandaloneSessionPromptV1Schema = lazySchema(() => z.object({
    v: z.literal(1).catch(1).default(1),
    text: z.string().catch('').default(''),
    updatedAt: z.number().int().nonnegative().optional().catch(undefined),
}).passthrough());
export type StandaloneSessionPromptV1 = z.infer<typeof StandaloneSessionPromptV1Schema>;
export const DEFAULT_STANDALONE_SESSION_PROMPT_V1: StandaloneSessionPromptV1 = Object.freeze({ v: 1, text: '' });

/**
 * Snapshot taken into a fresh roleless session's metadata at creation, like the role snapshot, so
 * the block survives provider resume and prompt resets that rebuild without settings. Settings
 * edits affect future sessions only.
 */
export const StandaloneSessionPromptSnapshotV1Schema = lazySchema(() => z.object({
    v: z.literal(1),
    text: z.string().trim().min(1),
    sourceUpdatedAt: z.number().int().nonnegative().optional(),
}).passthrough());
export type StandaloneSessionPromptSnapshotV1 = z.infer<typeof StandaloneSessionPromptSnapshotV1Schema>;

/** Child environment variable carrying the account text into a daemon-spawned runner. */
export const STANDALONE_SESSION_PROMPT_V1_ENV_KEY = 'HAPPIER_STANDALONE_SESSION_PROMPT_V1_JSON';

export function resolveStandaloneSessionPromptV1(settingsLike: unknown): StandaloneSessionPromptV1 {
    const raw = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
        ? (settingsLike as Record<string, unknown>).standaloneSessionPromptV1
        : undefined;
    const parsed = StandaloneSessionPromptV1Schema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : DEFAULT_STANDALONE_SESSION_PROMPT_V1;
}

/** The snapshot for a fresh session, or null when the text is blank or the session starts with a role. */
export function buildStandaloneSessionPromptSnapshotV1(params: Readonly<{
    /**
     * Account settings (terminal-started runners), or `{ standaloneSessionPromptV1: <env value> }`
     * for a daemon-spawned runner reading `HAPPIER_STANDALONE_SESSION_PROMPT_V1_JSON`.
     */
    settings: unknown;
    metadata: unknown;
}>): StandaloneSessionPromptSnapshotV1 | null {
    if (readSessionRoleV1(params.metadata) !== null) return null;
    const prompt = resolveStandaloneSessionPromptV1(params.settings);
    const text = prompt.text.trim();
    if (!text) return null;
    return { v: 1, text, ...(prompt.updatedAt !== undefined ? { sourceUpdatedAt: prompt.updatedAt } : {}) };
}

export function readStandaloneSessionPromptSnapshotV1(metadata: unknown): StandaloneSessionPromptSnapshotV1 | null {
    if (!metadata || typeof metadata !== 'object' || !('standaloneSessionPromptSnapshotV1' in metadata)) return null;
    const parsed = StandaloneSessionPromptSnapshotV1Schema.safeParse(
        (metadata as { standaloneSessionPromptSnapshotV1?: unknown }).standaloneSessionPromptSnapshotV1,
    );
    return parsed.success ? parsed.data : null;
}

export function applyStandaloneSessionPromptSnapshotV1ToMetadata<M extends Record<string, unknown>>(
    metadata: M,
    snapshot: StandaloneSessionPromptSnapshotV1,
): M {
    return { ...metadata, standaloneSessionPromptSnapshotV1: StandaloneSessionPromptSnapshotV1Schema.parse(snapshot) };
}

/** `coding.standalone_default` text: the retained snapshot, only while the session has no role. */
export function buildStandaloneSessionPromptBlockTextV1(metadata: unknown): string | null {
    if (readSessionRoleV1(metadata) !== null) return null;
    return readStandaloneSessionPromptSnapshotV1(metadata)?.text.trim() || null;
}
