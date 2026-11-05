import * as React from 'react';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';
import { materializeHappierRenderableImage } from '@happier-dev/plugin-ui/advanced';

import {
    createPluginContextualResourceReadClient,
} from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    acquirePluginSelectedPackageAssetLease,
    type PluginProtectedAccountPackageAssetSource,
} from '@/sync/domains/plugins/availability/packageAssetLease';
import { getActivePluginAccountPackageAssetSource } from '@/sync/api/plugins/availability/activePluginAccountPackageAssetRead';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { BUNDLED_PLUGIN_BRAND_MARKS } from '@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts';
import { getAgentUiConfig } from '@/agents/registry/registryUi';
import { resolveBundledAgentIdFromPluginId } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';

/** A host-safe packaged brand fact: name is always projection-owned; bytes are optional. */
export type InstalledPluginBrandPresentation = HostCatalogMark;

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
    signal: AbortSignal;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
    /** An already-admitted routed credential binding; its view lifetime is not Account custody. */
    credentialAccountScope?: ServerAccountScope;
    isCurrent: () => boolean;
    /** Present only for portable releases; local installed packages retain daemon Resource reads. */
    packageAssets?: InstalledPluginBrandPackageAssets | null;
}>;

function readRequiredString(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
}

function isCurrent(input: InstalledPluginBrandPresentationInput): boolean {
    if (input.signal.aborted || !input.accountLifetime) return false;
    try {
        return input.accountLifetime.isCurrent() && input.isCurrent();
    } catch {
        return false;
    }
}

/**
 * Admit acquired mark bytes for rendering, off the render path.
 *
 * The shared image owner decides the renderable type and the product size and
 * decode ceilings, and records the platform source for exactly these bytes.
 * Presentation can only read what an owner admitted, so bytes that never reach
 * this call — or that a ceiling refuses — become the neutral text identity
 * rather than a render that pays to convert them or a mark that silently fails
 * to appear.
 *
 * A refusal here is not an author-reportable event: the canonical brand
 * Resource owner already decodes the mark and enforces stricter type, square,
 * pixel and byte bounds before any projection can call it `available`. Host
 * chrome therefore falls back to the neutral text identity instead of naming a
 * surface it does not have.
 */
function admittedBrandPresentation(
    displayName: string,
    bytes: Uint8Array | null | undefined,
    monochrome?: boolean,
): InstalledPluginBrandPresentation | null {
    if (!bytes || bytes.byteLength === 0) return null;
    return materializeHappierRenderableImage(bytes).admitted
        ? Object.freeze({ displayName, bytes, ...(monochrome ? { monochrome: true } : {}) })
        : null;
}

/** Exact first-party package identity, using only bytes emitted by the app byte publisher. */
function readBundledAgentArtwork(pluginId: string | null | undefined, displayName?: string, iconAgentId?: string | null): InstalledPluginBrandPresentation | null {
    const agentId = iconAgentId ?? resolveBundledAgentIdFromPluginId(pluginId);
    const artwork = agentId ? getAgentUiConfig(agentId).brandArtwork : undefined;
    return artwork && displayName ? Object.freeze({ displayName, ...artwork }) : null;
}

export function readBundledPluginBrandPresentation(pluginId: string | null | undefined, displayName?: string, iconAgentId?: string | null): InstalledPluginBrandPresentation | null {
    const matches = BUNDLED_PLUGIN_BRAND_MARKS.filter((mark) => mark.pluginId === pluginId);
    const mark = matches.length === 1 ? matches[0] : null;
    return (mark ? admittedBrandPresentation(mark.displayName, mark.bytes, mark.monochrome) : null)
        ?? readBundledAgentArtwork(pluginId, displayName, iconAgentId);
}

const admittedBundledBrands = new Map<string, InstalledPluginBrandPresentation>();
const bundledBrandKey = (pluginId: string | null | undefined, displayName?: string, iconAgentId?: string | null) =>
    JSON.stringify([pluginId ?? null, displayName ?? null, iconAgentId ?? null]);

/**
 * Admission stays off the render path, including chrome without a machine projection. A mark already admitted
 * for these facts is drawn on the first render: a mark that mounts again (a list returning, a second page) never
 * flashes its neutral text identity before its artwork.
 */
export function useBundledPluginBrandPresentation(pluginId: string | null | undefined, displayName?: string, iconAgentId?: string | null): InstalledPluginBrandPresentation | null {
    const [state, setState] = React.useState<Readonly<{ pluginId: typeof pluginId; displayName: typeof displayName; iconAgentId: typeof iconAgentId; presentation: InstalledPluginBrandPresentation | null }> | null>(null);
    const cached = admittedBundledBrands.get(bundledBrandKey(pluginId, displayName, iconAgentId)) ?? null;
    React.useEffect(() => {
        const key = bundledBrandKey(pluginId, displayName, iconAgentId);
        // Already admitted: the render drew that same mark, so a remount neither re-admits nor re-renders.
        if (cached) return;
        // A sibling may have admitted it since this consumer rendered without the mark.
        const presentation = admittedBundledBrands.get(key) ?? readBundledPluginBrandPresentation(pluginId, displayName, iconAgentId);
        if (!presentation) return;
        admittedBundledBrands.set(key, presentation);
        setState({ pluginId, displayName, iconAgentId, presentation });
    }, [pluginId, displayName, iconAgentId, cached]);
    const held = state && state.pluginId === pluginId && state.displayName === displayName && state.iconAgentId === iconAgentId ? state.presentation : null;
    return held ?? cached;
}

function readInstalledBundledBrandPresentation(installedPackage: PluginProjectionInstalledPackageV2): InstalledPluginBrandPresentation | null {
    const mark = BUNDLED_PLUGIN_BRAND_MARKS.find((entry) => entry.pluginId === installedPackage.id);
    const artwork = readBundledAgentArtwork(installedPackage.id, installedPackage.displayName);
    if (!mark || installedPackage.version !== mark.releaseVersion) return artwork;
    const brand = installedPackage.brand;
    if (brand && (brand.state !== 'available'
        || brand.resource.pluginId !== mark.pluginId
        || brand.resource.localId !== mark.resourceId
      || brand.digest !== mark.digest)) return artwork;
    const presentation = readBundledPluginBrandPresentation(installedPackage.id);
    return presentation ? Object.freeze({ ...presentation, displayName: installedPackage.displayName }) : null;
}

function neutralFallback(input: InstalledPluginBrandPresentationInput): InstalledPluginBrandPresentation | null {
    const installedPackage = input.installedPackage;
    if (!installedPackage || installedPackage.enabled !== true || !isCurrent(input)) return null;
    return Object.freeze({ displayName: installedPackage.displayName });
}

/** Undefined alone means an admitted Resource still needs asynchronous acquisition. */
function readImmediateInstalledPluginBrandPresentation(
    input: InstalledPluginBrandPresentationInput,
): InstalledPluginBrandPresentation | null | undefined {
    const installedPackage = input.installedPackage;
    const fallback = neutralFallback(input);
    if (installedPackage && isCurrent(input)
        && (!fallback || installedPackage.source.kind === 'bundled' || installedPackage.brand?.state !== 'available')) {
        readAccountBrandRequests(input, false)?.requests.delete(requestSlot(input));
    }
    if (!installedPackage || !fallback) return null;
    if (installedPackage.source.kind === 'bundled') {
        return readInstalledBundledBrandPresentation(installedPackage) ?? fallback;
    }
    return installedPackage.brand?.state === 'available' ? undefined : fallback;
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
        brand?.state === 'available' ? brand.monochrome === true : null,
        readRequiredString(input.machineId),
        input.serverId ?? null,
        installedPackage?.occurrenceId ?? null,
        installedPackage?.version ?? null,
        installedPackage?.source ?? null,
        input.packageAssets === undefined ? 'daemon' : input.packageAssets === null ? 'unavailable' : 'account',
    ]);
}

type InstalledPluginBrandPresentationState = Readonly<{
    key: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null | undefined;
    signal: AbortSignal;
    packageAssets: InstalledPluginBrandPackageAssets | null | undefined;
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
    monochrome?: boolean;
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
        return admittedBrandPresentation(input.displayName, bytes, input.monochrome)
            ?? neutralFallback(input.presentation);
    } finally {
        acquired.lease.dispose();
    }
}

/**
 * Resolve one admitted package brand through its source-class-specific owner.
 * Portable packages can only use the selected Account Package Asset lease;
 * local-path packages retain their mounted daemon Resource authority.
 */
async function resolveInstalledPluginBrandPresentation(
    input: InstalledPluginBrandPresentationInput,
): Promise<InstalledPluginBrandPresentation | null> {
    const fallback = neutralFallback(input);
    const installedPackage = input.installedPackage;
    if (!fallback || !installedPackage) return fallback;
    if (installedPackage.brand?.state !== 'available') return fallback;

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
                monochrome: brand.monochrome,
            });
        } catch {
            return neutralFallback(input);
        }
    }

    if (installedPackage.source.kind !== 'localPath') return fallback;

    const machineId = readRequiredString(input.machineId);
    const expectedCallerOccurrenceId = readRequiredString(installedPackage.occurrenceId);
    if (!machineId || !expectedCallerOccurrenceId) return fallback;

    try {
        const client = createPluginContextualResourceReadClient({
            pluginId: installedPackage.id,
            resource: {
                machineId,
                serverId: input.serverId ?? null,
                expectedCallerOccurrenceId,
            },
            isCurrent: () => isCurrent(input),
        });
        const resource = await client.readResource(brand.resource, { signal: input.signal });
        if (!isCurrent(input)) return null;
        if (resource.contentType !== 'image/png' || resource.digest !== brand.digest) {
            return fallback;
        }
        return admittedBrandPresentation(
            installedPackage.displayName,
            resource.bytes,
            brand.monochrome,
        ) ?? fallback;
    } catch {
        // The package remains current, but its optional visual Resource did not
        // arrive through the admitted owner. Preserve its canonical text-only
        // identity rather than retaining or inventing any bytes.
        return neutralFallback(input);
    }
}

type SharedBrandRequest = Readonly<{
    key: string;
    packageAssets: InstalledPluginBrandPackageAssets | null | undefined;
    result: Promise<InstalledPluginBrandPresentation | null>;
}>;

// One owner for pending and settled package marks. Account retirement releases
// every retained result; a view's abort only withdraws that view's observation.
type AccountBrandRequests = Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    requests: Map<string, SharedBrandRequest>;
}>;
const accountBrandRequests = new Map<ActiveServerAccountScopeLifetime | string, AccountBrandRequests>();

function requestSlot(input: InstalledPluginBrandPresentationInput): string {
    return JSON.stringify([input.installedPackage?.id, readRequiredString(input.machineId), input.serverId ?? null]);
}

function readAccountBrandRequests(input: InstalledPluginBrandPresentationInput, create = true): AccountBrandRequests | null {
    let lifetime = input.accountLifetime;
    if (!lifetime) return null;
    const credentialScope = input.credentialAccountScope;
    if (credentialScope && (!areServerAccountScopesEqual(credentialScope, lifetime.scope)
        || !areServerProfileIdentifiersEquivalent(credentialScope.serverId, input.serverId))) return null;
    const activeLifetime = captureActiveServerAccountScopeLifetime();
    if (activeLifetime && areServerAccountScopesEqual(activeLifetime.scope, lifetime.scope)) lifetime = activeLifetime;
    const routed = credentialScope && lifetime !== activeLifetime;
    const key = routed ? serverAccountScopeKeySuffix(credentialScope) : lifetime;
    const retained = accountBrandRequests.get(key);
    if (retained) return retained;
    if (!create) return null;

    let subscribeRetirement: (retire: () => void) => void;
    if (routed) {
        // Routed bindings belong to views. The canonical credential writer's
        // exact-Home wake, not a view unmount, retires reconstructible marks.
        const controller = new AbortController();
        lifetime = {
            scope: credentialScope,
            isCurrent: () => !controller.signal.aborted,
            onRetire(retire) {
                if (controller.signal.aborted) retire();
                else controller.signal.addEventListener('abort', retire, { once: true });
                return { dispose: () => controller.signal.removeEventListener('abort', retire) };
            },
        };
        subscribeRetirement = (retire) => {
            const unsubscribe = subscribeHomeCredentialChange((event) => {
                if (!areServerProfileIdentifiersEquivalent(event.serverId, credentialScope.serverId)) return;
                controller.abort();
                retire();
                unsubscribe();
            });
        };
    } else {
        const accountLifetime = lifetime;
        subscribeRetirement = (retire) => { accountLifetime.onRetire(retire); };
    }
    const owned = { lifetime, requests: new Map<string, SharedBrandRequest>() };
    accountBrandRequests.set(key, owned);
    subscribeRetirement(() => {
        owned.requests.clear();
        accountBrandRequests.delete(key);
    });
    return owned;
}

export async function readInstalledPluginBrandPresentation(
    input: InstalledPluginBrandPresentationInput,
): Promise<InstalledPluginBrandPresentation | null> {
    const immediate = readImmediateInstalledPluginBrandPresentation(input);
    if (immediate !== undefined) return immediate;
    const fallback = neutralFallback(input);
    const brand = input.installedPackage?.brand;
    if (!fallback || brand?.state !== 'available') return fallback;
    if (input.packageAssets && !readDeclaredPortableBrandPath({
        packageAssets: input.packageAssets,
        pluginId: input.installedPackage!.id,
        resourceId: brand.resource.localId,
        digest: brand.digest,
    })) {
        readAccountBrandRequests(input, false)?.requests.delete(requestSlot(input));
        return fallback;
    }

    const owned = readAccountBrandRequests(input);
    if (!owned) return null;
    const { lifetime, requests } = owned;
    const key = presentationKey(input);
    const slot = requestSlot(input);
    let request = requests.get(slot);
    if (!request
        || request.key !== key
        || request.packageAssets?.reader !== input.packageAssets?.reader
        || request.packageAssets?.source !== input.packageAssets?.source) {
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        request = {
            key,
            packageAssets: input.packageAssets,
            result: resolveInstalledPluginBrandPresentation({
                ...input,
                signal: controller.signal,
                accountLifetime: lifetime,
                isCurrent: () => lifetime.isCurrent(),
            }).finally(() => retirement.dispose()),
        };
        // Replacement drops only the owner's retention. Captured pending callers
        // may still settle, and Account retirement still aborts every acquisition.
        requests.set(slot, request);
    }
    const presentation = await new Promise<InstalledPluginBrandPresentation | null>((resolve) => {
        const abort = () => {
            input.signal.removeEventListener('abort', abort);
            resolve(null);
        };
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) abort();
        void request.result.then((value) => {
            input.signal.removeEventListener('abort', abort);
            resolve(value);
        });
    });
    return isCurrent(input) ? presentation : null;
}

/**
 * The view-local observation of the shared Account/package presentation. Its
 * retirement and AbortSignal withdraw only this view, not the shared request.
 */
export function useInstalledPluginBrandPresentation(
    input: InstalledPluginBrandPresentationInput,
): InstalledPluginBrandPresentation | null {
    const availabilityReader = useActivePluginAccountAvailabilityReader(input.installedPackage?.id);
    const effectiveInput = React.useMemo<InstalledPluginBrandPresentationInput>(() => {
        if (input.packageAssets !== undefined || input.installedPackage?.source.kind === 'localPath' || input.installedPackage?.source.kind === 'bundled') {
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
        packageAssets: effectiveInput.packageAssets,
        presentation: fallback,
    }));

    React.useEffect(() => {
        let retired = false;
        const capturedInput = effectiveInput;
        const capturedFallback = neutralFallback(capturedInput);
        const immediate = readImmediateInstalledPluginBrandPresentation(capturedInput);
        // Bundled/neutral identity marks have no admitted package to resolve
        // or withdraw. Do not dispatch one empty state update per mounted row.
        if (capturedFallback === null) return;
        const capturedState = {
            key,
            accountLifetime: capturedInput.accountLifetime,
            signal: capturedInput.signal,
            packageAssets: capturedInput.packageAssets,
        };
        const isLatestCapturedIdentity = (): boolean => {
            const latest = inputRef.current;
            return latest.accountLifetime === capturedState.accountLifetime
                && latest.signal === capturedState.signal
                && latest.packageAssets?.reader === capturedState.packageAssets?.reader
                && latest.packageAssets?.source === capturedState.packageAssets?.source
                && presentationKey(latest) === capturedState.key;
        };
        const isCapturedCurrent = (): boolean => {
            return !retired
                && isLatestCapturedIdentity()
                && isCurrent(inputRef.current);
        };
        const publish = (presentation: InstalledPluginBrandPresentation | null) => {
            setState((current) => {
                if (!isCapturedCurrent()) return current;
                // Resolution may return the same neutral identity as the initial
                // state. Preserve it rather than scheduling a render per row.
                if (current.key === capturedState.key
                    && current.accountLifetime === capturedState.accountLifetime
                    && current.signal === capturedState.signal
                    && current.packageAssets?.reader === capturedState.packageAssets?.reader
                    && current.packageAssets?.source === capturedState.packageAssets?.source
                    && current.presentation?.displayName === presentation?.displayName
                    && current.presentation?.bytes === presentation?.bytes
                    && current.presentation?.light === presentation?.light
                    && current.presentation?.dark === presentation?.dark
                    && current.presentation?.monochrome === presentation?.monochrome) return current;
                return {
                    key: capturedState.key,
                    accountLifetime: capturedState.accountLifetime,
                    signal: capturedState.signal,
                    packageAssets: capturedState.packageAssets,
                    presentation,
                };
            });
        };
        const retire = () => {
            if (retired) return;
            retired = true;
            setState((current) => (
                current.key === capturedState.key
                && current.accountLifetime === capturedState.accountLifetime
                && current.signal === capturedState.signal
                && current.presentation !== null
                    ? {
                        key: capturedState.key,
                        accountLifetime: capturedState.accountLifetime,
                        signal: capturedState.signal,
                        packageAssets: capturedState.packageAssets,
                        presentation: null,
                    }
                    : current
            ));
        };

        // Bundled bytes and neutral identities have no asynchronous Resource
        // boundary. Admit them in this commit instead of scheduling one Promise
        // publication per newly mounted mark.
        publish(immediate === undefined ? capturedFallback : immediate);
        const retirement = capturedInput.accountLifetime?.onRetire(retire);
        capturedInput.signal.addEventListener('abort', retire, { once: true });
        if (capturedInput.signal.aborted) retire();

        if (immediate === undefined) {
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
    }, [effectiveInput.accountLifetime, effectiveInput.signal, effectiveInput.packageAssets?.reader, effectiveInput.packageAssets?.source, key]);

    return state.key === key
        && state.accountLifetime === effectiveInput.accountLifetime
        && state.signal === effectiveInput.signal
        && state.packageAssets?.reader === effectiveInput.packageAssets?.reader
        && state.packageAssets?.source === effectiveInput.packageAssets?.source
        && isCurrent(effectiveInput)
        ? state.presentation
        : fallback;
}
