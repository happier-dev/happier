import type { Asset } from 'expo-asset';

/** The generator preserves all installed language aliases and embedded grammar closures. */
export const SHIKI_LANGUAGE_ASSETS: Readonly<Record<string, readonly Parameters<typeof Asset.fromModule>[0][]>>;
