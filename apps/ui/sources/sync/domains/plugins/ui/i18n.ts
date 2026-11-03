import * as React from 'react';
import { shallow } from 'zustand/shallow';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { getPreferredLanguage, usePreferredLanguage } from '@/text';

import type { PluginUiProjectionModel } from './projection';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

const EMPTY_TRANSLATION_BUNDLE: Readonly<Record<string, string>> = Object.freeze({});
type TranslationBundle = Readonly<Record<string, string>>;

function readStringBundle(value: unknown): TranslationBundle | null {
    const record = readRecord(value);
    if (!record || Object.values(record).some(value => typeof value !== 'string')) return null;
    return Object.freeze(Object.fromEntries(Object.entries(record).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
    )));
}

function parseTranslationBytes(bytes: Uint8Array | null): TranslationBundle | null {
    if (!bytes) return null;
    try {
        return readStringBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
        return null;
    }
}

// I18NRES step 4 removes this producer transition after all inline declarations
// have migrated. Each Resource reference takes authority for its own locale.
function readInlineLocaleBundle(
    projection: Pick<PluginUiProjectionModel, 'translationsByPluginId'> | null | undefined,
    pluginId: string,
    locale: string,
): TranslationBundle | null {
    const entry = projection?.translationsByPluginId[pluginId];
    if (readRecord(entry?.resourceIdsByLocale)?.[locale] !== undefined) return null;
    return readStringBundle(readRecord(entry?.bundles)?.[locale]);
}

function readInlineTranslationBundle(
    projection: Pick<PluginUiProjectionModel, 'translationsByPluginId'> | null | undefined,
    pluginId: string,
    locale: string,
): TranslationBundle {
    const english = readInlineLocaleBundle(projection, pluginId, 'en');
    const preferred = locale === 'en' ? null : readInlineLocaleBundle(projection, pluginId, locale);
    return english || preferred ? Object.freeze({ ...english, ...preferred }) : EMPTY_TRANSLATION_BUNDLE;
}

function readTranslationValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readInlineTranslationText(
    projection: Pick<PluginUiProjectionModel, 'translationsByPluginId'> | null | undefined,
    pluginId: string,
    key: string,
    locale: string,
): string | null {
    const entry = projection?.translationsByPluginId[pluginId];
    const refs = readRecord(entry?.resourceIdsByLocale);
    const bundles = readRecord(entry?.bundles);
    const preferred = refs?.[locale] === undefined ? readRecord(bundles?.[locale])?.[key] : undefined;
    const english = locale !== 'en' && refs?.en === undefined ? readRecord(bundles?.en)?.[key] : undefined;
    return readTranslationValue(preferred ?? english);
}

export type PluginUiTranslationResourceReader = (
    projection: PluginUiProjectionModel,
    pluginId: string,
    resourceId: string,
    signal: AbortSignal,
) => Promise<Uint8Array | null>;

export type PluginUiTranslationResourceReaderFactory = (
    readCurrentProjection: () => PluginUiProjectionModel | null,
) => PluginUiTranslationResourceReader;

type TranslationProjection = Pick<PluginUiProjectionModel, 'translationsByPluginId'>
    & Partial<Pick<PluginUiProjectionModel, 'installedPackagesById' | 'resourcesById'>>;

export type PluginUiTranslationRuntime = Readonly<{
    setProjection: (projection: PluginUiProjectionModel) => void;
    demand: (pluginId: string, locale: string, options?: Readonly<{ retryUnavailable: boolean }>) => Promise<void>;
    getBundle: (pluginId: string, locale: string) => TranslationBundle;
    getText: (pluginId: string, key: string, locale: string) => string | null;
    getRevision: (pluginId: string) => number;
    matchesSource: (projection: TranslationProjection | null | undefined, pluginId: string) => boolean;
    createScopedRuntime: (projection: PluginUiProjectionModel) => PluginUiTranslationRuntime;
    subscribe: (listener: (pluginId: string) => void) => () => void;
    dispose: () => void;
}>;

/**
 * Decoded copy and in-flight reads belong to the admitted projection lifetime.
 * Byte acquisition stays with existing Resource/Package Asset adapters. Nothing
 * is read until a visible keyed string or mounted surface demands its plugin.
 */
export function createPluginUiTranslationRuntime(params: Readonly<{
    projection: PluginUiProjectionModel;
    readResourceBytes: PluginUiTranslationResourceReader;
    createResourceReader?: PluginUiTranslationResourceReaderFactory;
}>): PluginUiTranslationRuntime {
    type ResourceRead = {
        pending: Promise<TranslationBundle | null>;
        unavailable: boolean;
    };
    type PluginCopy = {
        projection: PluginUiProjectionModel;
        controller: AbortController;
        reads: Map<string, ResourceRead>;
        desiredLocale: string;
        committedLocale: string | null;
        bundle: TranslationBundle;
    };
    let projection = params.projection;
    let disposed = false;
    const readResourceBytes = params.createResourceReader?.(() => disposed ? null : projection) ?? params.readResourceBytes;
    const copies = new Map<string, PluginCopy>();
    const revisions = new Map<string, number>();
    const listeners = new Set<(pluginId: string) => void>();
    const publish = (pluginId: string) => {
        revisions.set(pluginId, (revisions.get(pluginId) ?? 0) + 1);
        for (const listener of listeners) listener(pluginId);
    };
    const sameSource = (previous: PluginUiProjectionModel, next: TranslationProjection, pluginId: string) => {
        const resources = next.resourcesById;
        if (!next.installedPackagesById || !resources) return false;
        const entry = previous.translationsByPluginId[pluginId];
        if (entry !== next.translationsByPluginId[pluginId]
            || previous.installedPackagesById[pluginId] !== next.installedPackagesById[pluginId]) return false;
        return Object.values(readRecord(entry?.resourceIdsByLocale) ?? {}).every(resourceId => {
            if (typeof resourceId !== 'string') return false;
            const key = buildQualifiedPluginContributionKey({ pluginId, localId: resourceId });
            return previous.resourcesById[key] === resources[key];
        });
    };
    const runtime: PluginUiTranslationRuntime = {
        setProjection(next) {
            if (disposed || projection === next) return;
            projection = next;
            for (const [pluginId, copy] of copies) {
                if (sameSource(copy.projection, next, pluginId)) {
                    copy.projection = next;
                    continue;
                }
                copy.controller.abort();
                copies.delete(pluginId);
                publish(pluginId);
            }
        },
        async demand(pluginId, requestedLocale, options) {
            if (disposed || !projection.translationsByPluginId[pluginId]) return;
            if (projection.translationsByPluginId[pluginId]?.resourceIdsByLocale === undefined) return;
            const locale = requestedLocale.trim() || 'en';
            let copy = copies.get(pluginId);
            if (!copy) {
                copy = {
                    projection, controller: new AbortController(), reads: new Map(),
                    desiredLocale: locale, committedLocale: null, bundle: readInlineTranslationBundle(projection, pluginId, locale),
                };
                copies.set(pluginId, copy);
            }
            copy.desiredLocale = locale;
            const active = copy;
            const refs = readRecord(active.projection.translationsByPluginId[pluginId]?.resourceIdsByLocale);
            const retryUnavailable = options?.retryUnavailable !== false;
            if (active.committedLocale === locale) {
                if (!retryUnavailable || ![refs?.en, refs?.[locale]].some(resourceId =>
                    typeof resourceId === 'string' && active.reads.get(resourceId)?.unavailable)) return;
                active.committedLocale = null;
            }
            const read = (language: string): Promise<TranslationBundle | null> => {
                const resourceId = refs?.[language];
                if (typeof resourceId !== 'string') return Promise.resolve(readInlineLocaleBundle(active.projection, pluginId, language));
                const existing = active.reads.get(resourceId);
                if (existing && (!existing.unavailable || !retryUnavailable)) return existing.pending;
                const entry: ResourceRead = {
                    unavailable: false,
                    pending: (async () => readResourceBytes(
                        active.projection, pluginId, resourceId, active.controller.signal,
                    ))().then(bytes => {
                        // Immutable malformed JSON stays settled. Missing bytes
                        // are an acquisition failure, retryable on explicit demand.
                        entry.unavailable = bytes === null;
                        return parseTranslationBytes(bytes);
                    }, () => {
                        entry.unavailable = true;
                        return null;
                    }),
                };
                active.reads.set(resourceId, entry);
                return entry.pending;
            };
            const [english, preferred] = await Promise.all([read('en'), locale === 'en' ? Promise.resolve(null) : read(locale)]);
            if (disposed || active.controller.signal.aborted || copies.get(pluginId) !== active
                || active.desiredLocale !== locale || active.committedLocale === locale) return;
            const bundle = english || preferred ? Object.freeze({ ...english, ...preferred }) : EMPTY_TRANSLATION_BUNDLE;
            const copyChanged = !shallow(active.bundle, bundle);
            if (copyChanged) active.bundle = bundle;
            active.committedLocale = locale;
            // Keep only active copy plus English; previous locale survives solely
            // in the committed bundle while its replacement is loading.
            const retainedResources = new Set([refs?.en, refs?.[locale]]);
            for (const resourceId of active.reads.keys()) {
                if (!retainedResources.has(resourceId)) active.reads.delete(resourceId);
            }
            // A failed explicit retry still settles, but identical visible copy
            // must not trigger another render and another demand for those bytes.
            if (copyChanged) publish(pluginId);
        },
        getBundle(pluginId, locale) {
            if (disposed) return EMPTY_TRANSLATION_BUNDLE;
            return copies.get(pluginId)?.bundle ?? readInlineTranslationBundle(projection, pluginId, locale);
        },
        getText(pluginId, key, locale) {
            if (disposed) return null;
            const copy = copies.get(pluginId);
            return copy ? readTranslationValue(copy.bundle[key]) : readInlineTranslationText(projection, pluginId, key, locale);
        },
        getRevision(pluginId) {
            return revisions.get(pluginId) ?? 0;
        },
        matchesSource(source, pluginId) {
            return !disposed && Boolean(source && sameSource(projection, source, pluginId));
        },
        createScopedRuntime(source) {
            return createPluginUiTranslationRuntime({ ...params, projection: source });
        },
        subscribe(listener) {
            if (disposed) return () => {};
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        dispose() {
            disposed = true;
            for (const copy of copies.values()) copy.controller.abort();
            copies.clear();
            revisions.clear();
            listeners.clear();
        },
    };
    return runtime;
}

const PluginUiTranslationRuntimeContext = React.createContext<PluginUiTranslationRuntime | null>(null);

export function PluginUiTranslationRuntimeProvider(props: Readonly<{
    runtime: PluginUiTranslationRuntime | null;
    children?: React.ReactNode;
}>): React.ReactElement {
    return React.createElement(PluginUiTranslationRuntimeContext.Provider, { value: props.runtime }, props.children);
}

type TranslationBinding = Readonly<{
    projection: TranslationProjection | null | undefined;
    runtime?: PluginUiTranslationRuntime | null;
    locale?: string | null;
}>;

export function resolvePluginUiText(params: TranslationBinding & Readonly<{
    pluginId: string;
    key: string | null | undefined;
    fallback?: string | null;
}>): string {
    return resolvePluginUiTranslationText(params) || params.fallback?.trim() || params.key?.trim() || '';
}

/** A synchronous map for native/CJS and hosted surfaces. Target keys win. */
export function resolvePluginUiTranslationBundle(params: TranslationBinding & Readonly<{
    pluginId: string;
    contributorPluginIds?: readonly string[];
}>): TranslationBundle {
    const locale = params.locale?.trim() || 'en';
    const read = (pluginId: string) => params.runtime?.matchesSource(params.projection, pluginId)
        ? params.runtime.getBundle(pluginId, locale)
        : readInlineTranslationBundle(params.projection, pluginId, locale);
    const own = read(params.pluginId);
    if (!params.contributorPluginIds?.length) return own;
    return Object.freeze(Object.assign({}, ...[...new Set(params.contributorPluginIds)].map(pluginId =>
        read(pluginId)), own));
}

export function resolvePluginUiTranslationText(params: TranslationBinding & Readonly<{
    pluginId: string;
    key: string | null | undefined;
}>): string | null {
    const key = params.key?.trim();
    if (!key) return null;
    const locale = params.locale?.trim() || 'en';
    return params.runtime?.matchesSource(params.projection, params.pluginId)
        ? params.runtime.getText(params.pluginId, key, locale)
        : readInlineTranslationText(params.projection, params.pluginId, key, locale);
}

/** Author literals remain literal; unavailable copy uses the author's fallback. */
export function resolvePluginLocalizedText(params: TranslationBinding & Readonly<{
    pluginId: string;
    value: unknown;
}>): string {
    if (typeof params.value === 'string') return params.value;
    const candidate = readRecord(params.value);
    const key = typeof candidate?.key === 'string' ? candidate.key : null;
    const fallback = typeof candidate?.fallback === 'string' ? candidate.fallback : null;
    const text = resolvePluginUiText({ ...params, key, fallback });
    return resolvePluginLocalizedStringV2Text(params.value, text);
}

export type PluginLocalizedTextResolver = (pluginId: string, value: unknown) => string;

export function createPluginLocalizedTextResolver(params: TranslationBinding): PluginLocalizedTextResolver {
    const locale = params.locale ?? getPreferredLanguage();
    return (pluginId, value) => resolvePluginLocalizedText({ ...params, pluginId, value, locale });
}

type TranslationHookBinding = Omit<TranslationBinding, 'projection'> & Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
}>;

function useTranslationDemand(params: TranslationHookBinding) {
    const contextualRuntime = React.useContext(PluginUiTranslationRuntimeContext);
    const runtime = params.runtime ?? contextualRuntime;
    const projectionRef = React.useRef(params.projection);
    projectionRef.current = params.projection;
    const hasProjection = Boolean(params.projection);
    // A presentation owns its fallback scope. Equivalent sources still share
    // root reads; Session/selected-Machine sources retain their own currentness.
    const scoped = React.useMemo(() => {
        const projection = projectionRef.current;
        return runtime && projection
            ? { parent: runtime, runtime: runtime.createScopedRuntime(projection) }
            : null;
    }, [runtime, hasProjection]);
    React.useEffect(() => () => scoped?.runtime.dispose(), [scoped]);
    React.useLayoutEffect(() => {
        if (scoped?.parent === runtime && params.projection) scoped.runtime.setProjection(params.projection);
    }, [runtime, scoped, params.projection]);
    const runtimeFor = React.useCallback((pluginId: string): PluginUiTranslationRuntime | null => {
        if (runtime?.matchesSource(params.projection, pluginId)) return runtime;
        return scoped?.parent === runtime && scoped.runtime.matchesSource(params.projection, pluginId) ? scoped.runtime : null;
    }, [runtime, scoped, params.projection]);
    const preferredLanguage = usePreferredLanguage();
    const locale = params.locale?.trim() || preferredLanguage;
    const demanded = React.useMemo(() => new Set<string>(), [runtime, locale, params.projection]);
    const subscribe = React.useCallback((notify: () => void) => {
        const changed = (pluginId: string) => { if (demanded.has(pluginId)) notify(); };
        const stopRoot = runtime?.subscribe(changed);
        const stopScoped = scoped?.parent === runtime ? scoped.runtime.subscribe(changed) : undefined;
        return () => { stopRoot?.(); stopScoped?.(); };
    }, [runtime, scoped, demanded]);
    const snapshot = React.useCallback(() => {
        let revision = 0;
        for (const pluginId of demanded) revision += runtimeFor(pluginId)?.getRevision(pluginId) ?? 0;
        return revision;
    }, [runtimeFor, demanded]);
    const revision = React.useSyncExternalStore(subscribe, snapshot, snapshot);
    const demand = React.useCallback((pluginId: string) => {
        demanded.add(pluginId);
    }, [demanded]);
    // Only committed visible presentation creates IO. Render attempts merely
    // record demand, including strings resolved by the owner's descendants.
    React.useEffect(() => {
        for (const pluginId of demanded) void runtimeFor(pluginId)?.demand(pluginId, locale, { retryUnavailable: false });
    });
    return { runtimeFor, locale, revision, demand };
}

/** Explicit demand for an imperative opening event outside React rendering. */
export function usePluginUiTranslationDemand(params: Readonly<{
    runtime?: PluginUiTranslationRuntime | null;
    locale?: string | null;
}> = {}): (pluginIds: readonly string[]) => Promise<void> {
    const contextualRuntime = React.useContext(PluginUiTranslationRuntimeContext);
    const runtime = params.runtime ?? contextualRuntime;
    const preferredLanguage = usePreferredLanguage();
    const locale = params.locale?.trim() || preferredLanguage;
    return React.useCallback(async (pluginIds: readonly string[]) => {
        await Promise.all([...new Set(pluginIds)].map(pluginId => runtime?.demand(pluginId, locale)));
    }, [runtime, locale]);
}

export type PluginLocalizedTextBinding = Readonly<{
    localize: PluginLocalizedTextResolver;
    demandTranslations: (pluginIds: readonly string[]) => Promise<void>;
}>;

/** One scope supplies both committed labels and imperative opening events. */
export function usePluginLocalizedText(params: TranslationHookBinding): PluginLocalizedTextBinding {
    const { runtimeFor, locale, revision, demand } = useTranslationDemand(params);
    const localize = React.useMemo(() => (pluginId: string, value: unknown) => {
        if (typeof readRecord(value)?.key === 'string') demand(pluginId);
        return resolvePluginLocalizedText({ ...params, runtime: runtimeFor(pluginId), locale, pluginId, value });
    }, [params.projection, runtimeFor, locale, revision, demand]);
    const demandTranslations = React.useCallback(async (pluginIds: readonly string[]) => {
        await Promise.all([...new Set(pluginIds)].map(pluginId => runtimeFor(pluginId)?.demand(pluginId, locale)));
    }, [runtimeFor, locale]);
    return React.useMemo(() => ({ localize, demandTranslations }), [localize, demandTranslations]);
}

/** Bind once at each visible presentation owner, including navigation chrome. */
export function usePluginLocalizedTextResolver(params: TranslationHookBinding): PluginLocalizedTextResolver {
    return usePluginLocalizedText(params).localize;
}

export function usePluginUiTranslationBundle(params: TranslationHookBinding & Readonly<{
    pluginId: string;
    contributorPluginIds?: readonly string[];
}>): TranslationBundle {
    const { runtimeFor, locale, revision, demand } = useTranslationDemand(params);
    demand(params.pluginId);
    for (const pluginId of params.contributorPluginIds ?? []) demand(pluginId);
    return React.useMemo(() => {
        const read = (pluginId: string) => resolvePluginUiTranslationBundle({
            projection: params.projection, runtime: runtimeFor(pluginId), locale, pluginId,
        });
        if (!params.contributorPluginIds?.length) return read(params.pluginId);
        return Object.freeze(Object.assign({}, ...[...new Set(params.contributorPluginIds)].map(read), read(params.pluginId)));
    }, [params.projection, runtimeFor, locale, revision, params.pluginId, params.contributorPluginIds]);
}
