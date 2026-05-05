import * as React from 'react';

import {
    BUILT_IN_PET_IDS,
    DEFAULT_BUILT_IN_PET_ID,
} from '@/components/pets/builtIns/builtInPetRegistry';
import {
    resolveSelectedPetPackage,
    type ResolveSelectedPetPackageResult,
    type SelectedPetPackageSource,
} from '@/components/pets/source/resolveSelectedPetPackage';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { storage, useLocalSettings, useSettings } from '@/sync/domains/state/storage';

export function useSelectedPetPackage(): ResolveSelectedPetPackageResult {
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const accountPetsById = storage((state) => state.accountPetsById);
    const localPetSourcesBySourceKey = storage((state) => state.localPetSourcesBySourceKey);
    const companionDecision = useFeatureDecision('pets.companion');
    const syncDecision = useFeatureDecision('pets.sync');

    return React.useMemo(() => {
        const accountPetSources = new Map<string, SelectedPetPackageSource>(
            Object.values(accountPetsById ?? {}).map((pet) => [
                pet.accountPetId,
                {
                    kind: 'accountPet' as const,
                    accountPetId: pet.accountPetId,
                    sourceKey: pet.accountPetId,
                    mediaType: pet.spritesheetAssetRef.mediaType,
                    digest: pet.spritesheetAssetRef.digest,
                },
            ]),
        );
        const detectedCodexHomeBySourceKey = new Map<string, SelectedPetPackageSource>();
        const happierManagedLocalBySourceKey = new Map<string, SelectedPetPackageSource>();
        for (const source of Object.values(localPetSourcesBySourceKey ?? {})) {
            const entry = {
                kind: source.source.kind,
                sourceKey: source.sourceKey,
                mediaType: source.mediaType,
                digest: source.digest ?? undefined,
                daemonTarget: source.daemonTarget,
            };
            if (source.source.kind === 'detectedCodexHome') {
                detectedCodexHomeBySourceKey.set(source.sourceKey, entry);
            } else {
                happierManagedLocalBySourceKey.set(source.sourceKey, entry);
            }
        }

        return resolveSelectedPetPackage({
            companionDecision,
            syncDecision,
            accountSettings: {
                petsEnabled: settings.petsEnabled,
                petsSelectedPetRef: settings.petsSelectedPetRef,
            },
            localSettings: {
                petsEnabledOverride: localSettings.petsEnabledOverride,
                petsSelectedPetOverride: localSettings.petsSelectedPetOverride,
            },
            sources: {
                accountPetsById: accountPetSources,
                builtInFallbackPetId: DEFAULT_BUILT_IN_PET_ID,
                builtInPetIds: BUILT_IN_PET_IDS,
                detectedCodexHomeBySourceKey,
                happierManagedLocalBySourceKey,
            },
        });
    }, [
        accountPetsById,
        companionDecision,
        localPetSourcesBySourceKey,
        localSettings.petsEnabledOverride,
        localSettings.petsSelectedPetOverride,
        settings.petsEnabled,
        settings.petsSelectedPetRef,
        syncDecision,
    ]);
}
