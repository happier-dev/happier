import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';

import { t } from '@/text';
import {
  favoriteModelSelectionMatchesBackend,
  getFavoriteModelRef,
  isFavoriteModelRefSelectable,
  type FavoriteModelBackendIdentity,
  type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';

import { sessionModelSelectionKey } from './sessionModelSelectionKey';

/** One saved favourite model for a backend, as the pickers and Search name it. */
export type FavoriteModelEntry = Readonly<{
  key: string;
  ref: ProviderBoundModelRef;
  label: string;
  description: string;
  accessibilityLabel: string;
  reasoningEffort?: string;
  /** The Provider connection a favourite saved ("OpenRouter — Work"); null for the Agent's own models. */
  sourceLabel: string | null;
}>;

/**
 * The account's favourite models that apply to one backend, in saved order, once each. The New Session picker and
 * an open Session's composer (which offers them to Search by name) read the same entries.
 */
export function projectFavoriteModelEntries(
  favorites: readonly FavoriteModelSelectionV1[],
  backend: FavoriteModelBackendIdentity,
): readonly FavoriteModelEntry[] {
  const seen = new Set<string>();
  return favorites.flatMap((favorite) => {
    if (!favoriteModelSelectionMatchesBackend(favorite, backend)) return [];
    const ref = getFavoriteModelRef(favorite);
    const key = sessionModelSelectionKey(ref);
    if (!isFavoriteModelRefSelectable(ref) || seen.has(key)) return [];
    seen.add(key);
    const provider = favorite.providerDisplaySnapshot;
    const label = favorite.modelLabel || ref.modelId;
    return [
      {
        key,
        ref,
        label,
        description:
          favorite.backendLabel || t('agentInput.model.configureInCli'),
        accessibilityLabel:
          [provider?.providerName, provider?.connectionName, label]
            .filter(Boolean)
            .join(', ') || label,
        ...(favorite.reasoningEffort
          ? { reasoningEffort: favorite.reasoningEffort }
          : {}),
        sourceLabel:
          [provider?.providerName, provider?.connectionName]
            .filter(Boolean)
            .join(' — ') || null,
      },
    ];
  });
}
