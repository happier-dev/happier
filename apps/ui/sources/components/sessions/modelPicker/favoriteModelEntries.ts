import { favoriteModelRefIdentityKey, type FavoriteModelRef } from '@happier-dev/protocol/providers/modelFavoritesV1';

import { t } from '@/text';
import {
  favoriteModelSelectionMatchesBackend,
  getFavoriteModelRef,
  isFavoriteModelRefSelectable,
  type FavoriteModelBackendIdentity,
  type FavoriteModelSelectionV1,
} from '@/sync/domains/models/favoriteModelSelections';

import { isTeamCredentialProviderModelPickerValue, sessionModelPickerValueFromRef, sessionModelSelectionKey, type SessionModelPickerOptionValue } from './sessionModelSelectionKey';

/** One saved favourite model for a backend, as the pickers and Search name it. */
export type FavoriteModelEntry = Readonly<{
  key: string;
  ref: FavoriteModelRef;
  label: string;
  description: string;
  accessibilityLabel: string;
  reasoningEffort?: string;
  /** The Provider connection a favourite saved ("OpenRouter — Work"); null for the Agent's own models. */
  sourceLabel: string | null;
}>;

export function favoriteModelRefFromPickerValue(value: SessionModelPickerOptionValue): FavoriteModelRef | null {
  if (!isTeamCredentialProviderModelPickerValue(value)) return value;
  if (value.deliveryMode !== 'brokered') return null;
  const { teamId, resourceId, agentTargetKey, modelId, expectedResourceRevision, deliveryMode } = value;
  return { source: 'team_resource', teamId, resourceId, agentTargetKey, modelId, expectedResourceRevision, deliveryMode };
}

/** Match the saved share across catalog revisions without changing the picker row's exact selection key. */
export function favoriteModelPickerKey(value: SessionModelPickerOptionValue): string {
  if (isTeamCredentialProviderModelPickerValue(value)) {
    const ref = favoriteModelRefFromPickerValue(value);
    if (ref) return favoriteModelRefIdentityKey(ref);
  }
  return sessionModelSelectionKey(value);
}

/** Assign the first nine saved identities their stable keyboard slots. */
export function assignFavoriteModelSlots(keys: Iterable<string>) {
  const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
  const slots = new Map<string, typeof digits[number]>();
  for (const key of keys) {
    const slot = digits[slots.size];
    if (slot === undefined) break;
    if (!slots.has(key)) slots.set(key, slot);
  }
  return slots;
}

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
    const key = favoriteModelPickerKey(sessionModelPickerValueFromRef(ref));
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
