import type { FeatureDecision } from '@happier-dev/protocol';

import {
    BUILT_IN_PET_IDS,
    DEFAULT_BUILT_IN_PET_ID,
    resolveBuiltInPetPackage,
} from '@/components/pets/builtIns/builtInPetRegistry';
import {
    resolveSelectedPetPackage,
    type SelectedPetPackageSource,
} from '@/components/pets/source/resolveSelectedPetPackage';
import type { AccountPetMetadata } from '@/sync/domains/pets/accountPetLibraryTypes';
import type { LocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceTypes';

import type { DesktopOverlayPolicy, DesktopOverlayVisibilityMode } from './resolveDesktopOverlayPolicy';

type PetEnabledOverride = 'inherit' | 'enabled' | 'disabled';
type PetDesktopOverlayVisibilityMode = 'attentionOrActive' | 'alwaysWhenEnabled' | 'attentionOnly';

export type DesktopActivityOverlayCompanionPolicy = Readonly<{
    enabled: boolean;
    visibilityMode: PetDesktopOverlayVisibilityMode;
    pet: Readonly<{
        source: SelectedPetPackageSource;
        displayName: string;
    }>;
}>;

const PET_ENABLED_OVERRIDES = ['inherit', 'enabled', 'disabled'] as const;
const PET_DESKTOP_VISIBILITY_MODES = ['attentionOrActive', 'alwaysWhenEnabled', 'attentionOnly'] as const;
const PET_DESKTOP_VISIBILITY_MODE_OVERRIDES = ['inherit', ...PET_DESKTOP_VISIBILITY_MODES] as const;
function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function readAccountPetRef(value: unknown): Readonly<{
    kind: 'builtIn';
    petId: string;
}> | Readonly<{
    kind: 'accountPet';
    accountPetId: string;
}> {
    const record = readRecord(value);
    if (record.kind === 'accountPet' && typeof record.accountPetId === 'string' && record.accountPetId.trim()) {
        return { kind: 'accountPet', accountPetId: record.accountPetId.trim() };
    }
    if (record.kind === 'builtIn' && typeof record.petId === 'string' && record.petId.trim()) {
        return { kind: 'builtIn', petId: record.petId.trim() };
    }
    return { kind: 'builtIn', petId: DEFAULT_BUILT_IN_PET_ID };
}

function readLocalPetOverride(value: unknown): Readonly<{
    kind: 'inherit';
}> | Readonly<{
    kind: 'detectedCodexHome' | 'happierManagedLocal';
    sourceKey: string;
}> {
    const record = readRecord(value);
    if (
        (record.kind === 'detectedCodexHome' || record.kind === 'happierManagedLocal')
        && typeof record.sourceKey === 'string'
        && record.sourceKey.trim()
    ) {
        return {
            kind: record.kind,
            sourceKey: record.sourceKey.trim(),
        };
    }
    return { kind: 'inherit' };
}

function accountPetSource(pet: AccountPetMetadata): SelectedPetPackageSource {
    return {
        kind: 'accountPet',
        accountPetId: pet.accountPetId,
        sourceKey: pet.accountPetId,
        mediaType: pet.spritesheetAssetRef.mediaType,
        digest: pet.spritesheetAssetRef.digest,
    };
}

function buildAccountPetSourcesById(
    accountPetsById: Readonly<Record<string, AccountPetMetadata>> | null | undefined,
): ReadonlyMap<string, SelectedPetPackageSource> {
    const sources = new Map<string, SelectedPetPackageSource>();
    for (const pet of Object.values(accountPetsById ?? {})) {
        sources.set(pet.accountPetId, accountPetSource(pet));
    }
    return sources;
}

function buildLocalPetSourceMaps(
    localPetSourcesBySourceKey: Readonly<Record<string, LocalPetSourceMetadata>> | null | undefined,
): Readonly<{
    detectedCodexHomeBySourceKey: ReadonlyMap<string, SelectedPetPackageSource>;
    happierManagedLocalBySourceKey: ReadonlyMap<string, SelectedPetPackageSource>;
}> {
    const detectedCodexHomeBySourceKey = new Map<string, SelectedPetPackageSource>();
    const happierManagedLocalBySourceKey = new Map<string, SelectedPetPackageSource>();
    for (const metadata of Object.values(localPetSourcesBySourceKey ?? {})) {
        const source = {
            kind: metadata.source.kind,
            sourceKey: metadata.sourceKey,
            mediaType: metadata.mediaType,
            digest: metadata.digest ?? undefined,
            daemonTarget: metadata.daemonTarget,
        } satisfies SelectedPetPackageSource;
        if (metadata.source.kind === 'detectedCodexHome') {
            detectedCodexHomeBySourceKey.set(metadata.sourceKey, source);
        } else {
            happierManagedLocalBySourceKey.set(metadata.sourceKey, source);
        }
    }
    return {
        detectedCodexHomeBySourceKey,
        happierManagedLocalBySourceKey,
    };
}

function readSourceKey(source: SelectedPetPackageSource): string | null {
    return 'sourceKey' in source && typeof source.sourceKey === 'string' ? source.sourceKey : null;
}

function resolveDisplayName(
    source: SelectedPetPackageSource,
    accountPetsById: Readonly<Record<string, AccountPetMetadata>> | null | undefined,
    localPetSourcesBySourceKey: Readonly<Record<string, LocalPetSourceMetadata>> | null | undefined,
): string {
    if (source.kind === 'builtIn') {
        return resolveBuiltInPetPackage(source.petId).manifest.displayName;
    }
    if (source.kind === 'accountPet') {
        return accountPetsById?.[source.accountPetId]?.manifest.displayName ?? source.accountPetId;
    }
    if ('sourceKey' in source) {
        return localPetSourcesBySourceKey?.[source.sourceKey]?.displayName ?? source.sourceKey;
    }
    return resolveBuiltInPetPackage(DEFAULT_BUILT_IN_PET_ID).manifest.displayName;
}

function readPetEnabledOverride(value: unknown): PetEnabledOverride {
    return readEnum(value, PET_ENABLED_OVERRIDES, 'inherit');
}

function readPetOverlayEnabled(
    accountSettings: Readonly<Record<string, unknown>>,
    localSettings: Readonly<Record<string, unknown>>,
): boolean {
    const accountEnabled = readBoolean(accountSettings.petsDesktopOverlayDefaultEnabled, true);
    const override = readPetEnabledOverride(localSettings.desktopPetOverlayEnabledOverride);
    if (override === 'enabled') {
        return true;
    }
    if (override === 'disabled') {
        return false;
    }
    return accountEnabled;
}

function readPetOverlayVisibilityMode(
    accountSettings: Readonly<Record<string, unknown>>,
    localSettings: Readonly<Record<string, unknown>>,
): PetDesktopOverlayVisibilityMode {
    const accountDefault = readEnum(
        accountSettings.petsDesktopOverlayDefaultVisibilityMode,
        PET_DESKTOP_VISIBILITY_MODES,
        'alwaysWhenEnabled',
    );
    const localOverride = readEnum(
        localSettings.desktopPetOverlayVisibilityModeOverride,
        PET_DESKTOP_VISIBILITY_MODE_OVERRIDES,
        'inherit',
    );
    if (localOverride !== 'inherit') {
        return localOverride;
    }
    return accountDefault === 'attentionOrActive' ? 'alwaysWhenEnabled' : accountDefault;
}

export function resolveDesktopActivityOverlayCompanionPolicy(input: Readonly<{
    companionDecision: Pick<FeatureDecision, 'state'> | null;
    syncDecision: Pick<FeatureDecision, 'state'> | null;
    accountSettings: Readonly<Record<string, unknown>>;
    localSettings: Readonly<Record<string, unknown>>;
    accountPetsById?: Readonly<Record<string, AccountPetMetadata>> | null;
    localPetSourcesBySourceKey?: Readonly<Record<string, LocalPetSourceMetadata>> | null;
}>): DesktopActivityOverlayCompanionPolicy {
    const localPetSourceMaps = buildLocalPetSourceMaps(input.localPetSourcesBySourceKey);
    const selected = resolveSelectedPetPackage({
        companionDecision: input.companionDecision,
        syncDecision: input.syncDecision,
        accountSettings: {
            petsEnabled: readBoolean(input.accountSettings.petsEnabled, false),
            petsSelectedPetRef: readAccountPetRef(input.accountSettings.petsSelectedPetRef),
        },
        localSettings: {
            petsEnabledOverride: readPetEnabledOverride(input.localSettings.petsEnabledOverride),
            petsSelectedPetOverride: readLocalPetOverride(input.localSettings.petsSelectedPetOverride),
        },
        sources: {
            accountPetsById: buildAccountPetSourcesById(input.accountPetsById),
            builtInFallbackPetId: DEFAULT_BUILT_IN_PET_ID,
            builtInPetIds: BUILT_IN_PET_IDS,
            detectedCodexHomeBySourceKey: localPetSourceMaps.detectedCodexHomeBySourceKey,
            happierManagedLocalBySourceKey: localPetSourceMaps.happierManagedLocalBySourceKey,
        },
    });
    const source = selected.source ?? { kind: 'builtIn', petId: DEFAULT_BUILT_IN_PET_ID };

    return {
        enabled: selected.enabled && readPetOverlayEnabled(input.accountSettings, input.localSettings),
        visibilityMode: readPetOverlayVisibilityMode(input.accountSettings, input.localSettings),
        pet: {
            source,
            displayName: resolveDisplayName(source, input.accountPetsById, input.localPetSourcesBySourceKey),
        },
    };
}

function mapPetVisibilityModeToDesktopPolicy(
    visibilityMode: PetDesktopOverlayVisibilityMode,
): Pick<DesktopOverlayPolicy, 'visibilityMode' | 'showWhenRunning' | 'showWhenAttentionRequired' | 'showWhenReady'> {
    if (visibilityMode === 'alwaysWhenEnabled') {
        return {
            visibilityMode: 'always_when_enabled',
            showWhenRunning: true,
            showWhenAttentionRequired: true,
            showWhenReady: true,
        };
    }
    if (visibilityMode === 'attentionOnly') {
        return {
            visibilityMode: 'attention_only',
            showWhenRunning: false,
            showWhenAttentionRequired: true,
            showWhenReady: true,
        };
    }
    return {
        visibilityMode: 'active_sessions',
        showWhenRunning: true,
        showWhenAttentionRequired: true,
        showWhenReady: true,
    };
}

function desktopVisibilityRank(visibilityMode: DesktopOverlayVisibilityMode): number {
    if (visibilityMode === 'always_when_enabled') {
        return 2;
    }
    if (visibilityMode === 'active_sessions') {
        return 1;
    }
    return 0;
}

export function resolveDesktopOverlayPolicyWithCompanion(
    policy: DesktopOverlayPolicy,
    companionPolicy: DesktopActivityOverlayCompanionPolicy,
): DesktopOverlayPolicy {
    if (!companionPolicy.enabled) {
        return policy;
    }

    const companionHostPolicy = mapPetVisibilityModeToDesktopPolicy(companionPolicy.visibilityMode);
    if (!policy.enabled || desktopVisibilityRank(companionHostPolicy.visibilityMode) > desktopVisibilityRank(policy.visibilityMode)) {
        return {
            ...policy,
            ...companionHostPolicy,
            enabled: true,
        };
    }

    return policy;
}
