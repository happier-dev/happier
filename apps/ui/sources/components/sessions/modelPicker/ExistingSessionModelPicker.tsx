import * as React from 'react';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { buildFavoriteBackendIdentity } from '@/sync/domains/models/favoriteModelBackendIdentity';
import { rememberFavoriteModelReasoningEffort, toggleFavoriteModelSelection } from '@/sync/domains/models/favoriteModelSelections';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useCurrentFavoriteModelSelectionsV1Mutable } from '@/sync/store/hooks';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { projectFavoriteModelEntries } from './favoriteModelEntries';
import { SessionModelPicker, type SessionModelPickerProps } from './SessionModelPicker';

/** Mount the Account favorite reader with the open Session picker. */
export function ExistingSessionModelPicker(props: SessionModelPickerProps & Readonly<{
    sessionAccountScope: ServerAccountScope | null;
    backend: ResolvedBackendCatalogEntry | null | undefined;
    canEditFavorites: boolean;
}>) {
    const { sessionAccountScope, backend, canEditFavorites, ...picker } = props;
    const { agentTargetKey, nativeModels, providerGroups } = picker;
    const [favorites, setFavorites] = useCurrentFavoriteModelSelectionsV1Mutable();
    const settingsScope = useAccountSettingsScope();
    const enabled = canEditFavorites && areServerAccountScopesEqual(settingsScope, sessionAccountScope);
    const backendIdentity = React.useMemo(() => backend?.backendTargetKey === agentTargetKey
        ? buildFavoriteBackendIdentity(backend)
        : { backendTargetKey: agentTargetKey }, [agentTargetKey, backend]);
    const entries = React.useMemo(() => enabled
        ? projectFavoriteModelEntries(favorites, backendIdentity)
        : undefined, [backendIdentity, enabled, favorites]);
    const toggleFavorite = React.useCallback((ref: ProviderBoundModelRef, reasoningEffort?: string) => {
        const group = providerGroups.find(candidate => candidate.connectionId === ref.providerConnectionId);
        const modelLabel = ref.providerConnectionId
            ? group?.rows.find(row => row.ref.modelId === ref.modelId)?.descriptor.name
            : nativeModels.find(model => model.value === ref.modelId)?.label;
        setFavorites(toggleFavoriteModelSelection({
            favorites,
            backend: backendIdentity,
            modelRef: ref,
            modelLabel,
            backendLabel: backend?.title,
            providerDisplaySnapshot: group ? {
                providerName: group.providerName,
                connectionName: group.connectionName,
                connectionRole: group.connectionRole,
                connectionDisplayNameMode: group.connectionDisplayNameMode,
            } : null,
            reasoningEffort,
            addedAtMs: Date.now(),
        }));
    }, [backend?.title, backendIdentity, favorites, nativeModels, providerGroups, setFavorites]);
    const rememberEffort = React.useCallback((ref: ProviderBoundModelRef, effort: string) => {
        const next = rememberFavoriteModelReasoningEffort(favorites, ref, effort);
        if (next) setFavorites(next);
    }, [favorites, setFavorites]);

    return <SessionModelPicker
        {...picker}
        favoriteEntries={entries}
        onSelectFavoriteModel={enabled ? picker.onSelectFavoriteModel : undefined}
        onToggleFavorite={enabled ? toggleFavorite : undefined}
        onUpdateFavoriteModelReasoningEffort={enabled ? rememberEffort : undefined}
    />;
}
