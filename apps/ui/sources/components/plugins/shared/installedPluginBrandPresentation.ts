import * as React from 'react';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';

import {
    createPluginContextualResourceReadClient,
} from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    acquirePluginSelectedPackageAssetLease,
    type PluginProtectedAccountPackageAssetSource,
} from '@/sync/domains/plugins/availability/packageAssetLease';
import { getActivePluginAccountPackageAssetSource } from '@/sync/api/plugins/availability/activePluginAccountPackageAssetRead';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';

/** A host-safe packaged brand fact: name is always projection-owned; bytes are optional. */
export type InstalledPluginBrandPresentation = Readonly<{
    displayName: string;
    bytes?: Uint8Array;
}>;

/**
 * The portable branch receives only Availability currentness and the one
 * protected Account Artifact source. It cannot select a second byte source.
 */
export type InstalledPluginBrandPackageAssets = Readonly<{
    reader: Pick<PluginAccountAvailabilityReader, 'readCurrentPackageAsset' | 'subscribe'>;
    source: PluginProtectedAccountPackageAssetSource;
}>;

/**
 * Exact host binding captured by an already-admitted placement. This accepts no
 * raw plugin id, file path, URL, or custom Resource authority: the package
 * projection supplies the only Resource identity. Portable packages use the
 * protected Account Artifact source; local-path packages use the contextual
 * daemon Resource owner.
 */
export type InstalledPluginBrandPresentationInput = Readonly<{
    installedPackage: PluginProjectionInstalledPackageV2 | null | undefined;
    machineId: string | null | undefined;
    serverId?: string | null;
    expectedGeneration: string | number | null | undefined;
    signal: AbortSignal;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
    isCurrent: () => boolean;
    /** Present only for portable releases; local installed packages retain daemon Resource reads. */
    packageAssets?: InstalledPluginBrandPackageAssets | null;
}>;

function readRequiredString(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function readExpectedGeneration(value: string | number | null | undefined): string | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : null;
    }
    return readRequiredString(value);
}

function isCurrent(input: InstalledPluginBrandPresentationInput): boolean {
    if (input.signal.aborted || !input.accountLifetime) return false;
    try {
        return input.accountLifetime.isCurrent() && input.isCurrent();
    } catch {
        return false;
    }
}

function neutralFallback(input: InstalledPluginBrandPresentationInput): InstalledPluginBrandPresentation | null {
    const installedPackage = input.installedPackage;
    if (!installedPackage || installedPackage.enabled !== true || !isCurrent(input)) return null;
    return Object.freeze({ displayName: installedPackage.displayName });
}

function presentationKey(input: InstalledPluginBrandPresentationInput): string {
    const installedPackage = input.installedPackage;
    const brand = installedPackage?.brand;
    return JSON.stringify([
        installedPackage?.id ?? null,
        installedPackage?.displayName ?? null,
        installedPackage?.enabled ?? null,
        brand?.state ?? null,
        brand?.state === 'available' ? brand.resource.pluginId : null,
        brand?.state === 'available' ? brand.resource.localId : null,
        brand?.state === 'available' ? brand.digest : null,
        readRequiredString(input.machineId),
        input.serverId ?? null,
        readExpectedGeneration(input.expectedGeneration),
        input.packageAssets?.reader ?? null,
        input.packageAssets?.source ?? null,
    ]);
}

type InstalledPluginBrandPresentationState = Readonly<{
    key: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
    signal: AbortSignal;
    presentation: InstalledPluginBrandPresentation | null;
}>;

function readDeclaredPortableBrandPath(input: Readonly<{
    packageAssets: InstalledPluginBrandPackageAssets;
    pluginId: string;
    resourceId: string;
    digest: string;
}>): string | null {
    const admission = input.packageAssets.reader.readCurrentPackageAsset({ pluginId: input.pluginId });
    if (admission.kind !== 'available') return null;
    const matches = admission.packageAsset.descriptor.resources.filter((resource) => (
        resource.resourceId === input.resourceId
        && resource.mimeType === 'image/png'
        && resource.digestSha256 === input.digest
    ));
    return matches.length === 1 ? matches[0]!.path : null;
}

async function readPortableBrandPresentation(input: Readonly<{
    presentation: InstalledPluginBrandPresentationInput;
    packageAssets: InstalledPluginBrandPackageAssets;
    pluginId: string;
    displayName: string;
    resourceId: string;
    digest: string;
}>): Promise<InstalledPluginBrandPresentation | null> {
    const path = readDeclaredPortableBrandPath({
        packageAssets: input.packageAssets,
        pluginId: input.pluginId,
        resourceId: input.resourceId,
        digest: input.digest,
    });
    if (!path) return neutralFallback(input.presentation);
    const acquired = await acquirePluginSelectedPackageAssetLease({
        reader: input.packageAssets.reader,
        pluginId: input.pluginId,
        source: input.packageAssets.source,
    });
    if (acquired.kind !== 'available') return neutralFallback(input.presentation);
    try {
        const bytes = await acquired.lease.readDeclaredAsset(path);
        if (!isCurrent(input.presentation)) return null;
        return bytes && bytes.byteLength > 0
            ? Object.freeze({ displayName: input.displayName, bytes })
            : neutralFallback(input.presentation);
    } finally {
        acquired.lease.dispose();
    }
}

/**
 * Resolve one admitted package brand through its source-class-specific owner.
 * Portable packages can only use the selected Account Package Asset lease;
 * local-path packages retain their mounted daemon Resource authority.
 */
export async function readInstalledPluginBrandPresentation(
    input: InstalledPluginBrandPresentationInput,
): Promise<InstalledPluginBrandPresentation | null> {
    const fallback = neutralFallback(input);
    const installedPackage = input.installedPackage;
    if (!fallback || !installedPackage || installedPackage.brand?.state !== 'available') return fallback;

    const brand = installedPackage.brand;
    // The daemon independently rejects this too. Keeping the local bind makes
    // an invalid projection a neutral fallback without ever starting a read.
    if (brand.resource.pluginId !== installedPackage.id) return fallback;

    if (input.packageAssets !== undefined) {
        if (!input.packageAssets) return fallback;
        try {
            return await readPortableBrandPresentation({
                presentation: input,
                packageAssets: input.packageAssets,
                pluginId: installedPackage.id,
                displayName: installedPackage.displayName,
                resourceId: brand.resource.localId,
                digest: brand.digest,
            });
        } catch {
            return neutralFallback(input);
        }
    }

    if (installedPackage.source.kind !== 'localPath') return fallback;

    const machineId = readRequiredString(input.machineId);
    const expectedGeneration = readExpectedGeneration(input.expectedGeneration);
    if (!machineId || !expectedGeneration) return fallback;

    try {
        const client = createPluginContextualResourceReadClient({
            pluginId: installedPackage.id,
            resource: {
                machineId,
                serverId: input.serverId ?? null,
                expectedGeneration,
            },
            isCurrent: () => isCurrent(input),
        });
        const resource = await client.readResource(brand.resource, { signal: input.signal });
        if (!isCurrent(input)) return null;
        if (
            resource.contentType !== 'image/png'
            || resource.digest !== brand.digest
            || resource.bytes.byteLength === 0
        ) {
            return fallback;
        }
        return Object.freeze({ displayName: installedPackage.displayName, bytes: resource.bytes });
    } catch {
        // The package remains current, but its optional visual Resource did not
        // arrive through the admitted owner. Preserve its canonical text-only
        // identity rather than retaining or inventing any bytes.
        return neutralFallback(input);
    }
}

/**
 * The view-local projection for host chrome. It begins with its safe textual
 * fallback and makes one packaged-Resource snapshot request. The hook retains
 * neither a cross-view cache nor a subscription: `onRetire` and the caller's
 * AbortSignal only withdraw its own current view state.
 */
export function useInstalledPluginBrandPresentation(
    input: InstalledPluginBrandPresentationInput,
): InstalledPluginBrandPresentation | null {
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    const effectiveInput = React.useMemo<InstalledPluginBrandPresentationInput>(() => {
        if (input.packageAssets !== undefined || input.installedPackage?.source.kind === 'localPath') {
            return input;
        }
        return {
            ...input,
            packageAssets: availabilityReader
                ? Object.freeze({
                    reader: availabilityReader,
                    source: getActivePluginAccountPackageAssetSource(),
                })
                : null,
        };
    }, [availabilityReader, input]);
    const key = presentationKey(effectiveInput);
    const fallback = neutralFallback(effectiveInput);
    const inputRef = React.useRef(effectiveInput);
    inputRef.current = effectiveInput;
    const [state, setState] = React.useState<InstalledPluginBrandPresentationState>(() => ({
        key,
        accountLifetime: effectiveInput.accountLifetime,
        signal: effectiveInput.signal,
        presentation: fallback,
    }));

    React.useEffect(() => {
        let retired = false;
        const capturedInput = effectiveInput;
        const capturedFallback = neutralFallback(capturedInput);
        const capturedState = {
            key,
            accountLifetime: capturedInput.accountLifetime,
            signal: capturedInput.signal,
        };
        const isLatestCapturedIdentity = (): boolean => {
            const latest = inputRef.current;
            return latest.accountLifetime === capturedState.accountLifetime
                && latest.signal === capturedState.signal
                && presentationKey(latest) === capturedState.key;
        };
        const isCapturedCurrent = (): boolean => {
            return !retired
                && isLatestCapturedIdentity()
                && isCurrent(inputRef.current);
        };
        const publish = (presentation: InstalledPluginBrandPresentation | null) => {
            setState((current) => isCapturedCurrent()
                ? {
                    key: capturedState.key,
                    accountLifetime: capturedState.accountLifetime,
                    signal: capturedState.signal,
                    presentation,
                }
                : current);
        };
        const retire = () => {
            retired = true;
            setState((current) => (
                current.key === capturedState.key
                && current.accountLifetime === capturedState.accountLifetime
                && current.signal === capturedState.signal
                    ? {
                        key: capturedState.key,
                        accountLifetime: capturedState.accountLifetime,
                        signal: capturedState.signal,
                        presentation: null,
                    }
                    : current
            ));
        };

        publish(capturedFallback);
        const retirement = capturedInput.accountLifetime?.onRetire(retire);
        capturedInput.signal.addEventListener('abort', retire, { once: true });
        if (capturedInput.signal.aborted) retire();

        if (capturedFallback) {
            void readInstalledPluginBrandPresentation({
                ...capturedInput,
                isCurrent: isCapturedCurrent,
            }).then((presentation) => {
                if (isCapturedCurrent()) publish(presentation);
            });
        }

        return () => {
            retired = true;
            retirement?.dispose();
            capturedInput.signal.removeEventListener('abort', retire);
        };
    }, [effectiveInput.accountLifetime, effectiveInput.signal, key]);

    return state.key === key
        && state.accountLifetime === effectiveInput.accountLifetime
        && state.signal === effectiveInput.signal
        && isCurrent(effectiveInput)
        ? state.presentation
        : fallback;
}
