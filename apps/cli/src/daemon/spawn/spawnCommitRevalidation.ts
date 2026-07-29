import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';

/** Returns null when launch may commit, otherwise the exact refusal to return without creating a child. */
export type SpawnCommitRevalidation = () => Promise<SpawnSessionResult | null>;
