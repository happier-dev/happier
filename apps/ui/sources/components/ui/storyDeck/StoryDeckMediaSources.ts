import type { ImageProps } from 'expo-image';

import { resolveAssetUrl } from '@/changelog/releaseNotes/assetUrlResolver';
import type { StoryDeckMediaSurface } from '@/changelog/releaseNotes/types';

import { resolveStoryDeckBundledImageAsset } from './storyDeckBundledAssetRegistry';

export type StoryDeckResolvedMediaSources = Readonly<{
    primaryUrl: string | null;
    fallbackUrl: string | null;
    urls: readonly string[];
    sha256: string | null;
}>;

export type StoryDeckImageSourceValue = NonNullable<ImageProps['source']>;

export type StoryDeckImageSource = Readonly<{
    kind: 'local';
    key: string;
    source: StoryDeckImageSourceValue;
}> | Readonly<{
    kind: 'remote';
    uri: string;
    source: StoryDeckImageSourceValue;
}>;

export type StoryDeckResolvedImageSources = Readonly<{
    primarySource: StoryDeckImageSource | null;
    fallbackSource: StoryDeckImageSource | null;
    sources: readonly StoryDeckImageSource[];
    cacheKey: string;
}>;

type ResolveImageSourceOptions = Readonly<{
    resolveBundledImageAsset?: (key: string) => StoryDeckImageSourceValue | null;
    surface?: StoryDeckMediaSurface;
}>;

type ResolveMediaSourceOptions = Readonly<{
    surface?: StoryDeckMediaSurface;
}>;

type ResolvedAsset = NonNullable<ReturnType<typeof resolveAssetUrl>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(source: unknown, key: string): string | null {
    if (!isRecord(source)) return null;
    const value = source[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function uniqueUrls(urls: readonly (string | null | undefined)[]): readonly string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const url of urls) {
        if (typeof url !== 'string' || url.trim().length === 0) continue;
        const trimmed = url.trim();
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function sourceKey(source: StoryDeckImageSource): string {
    return source.kind === 'local' ? `local:${source.key}` : `remote:${source.uri}`;
}

function uniqueImageSources(sources: readonly (StoryDeckImageSource | null | undefined)[]): readonly StoryDeckImageSource[] {
    const seen = new Set<string>();
    const out: StoryDeckImageSource[] = [];
    for (const source of sources) {
        if (!source) continue;
        const key = sourceKey(source);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(source);
    }
    return out;
}

function resolveAssetFromKey(key: string | null): ResolvedAsset | null {
    return key ? resolveAssetUrl(key) : null;
}

function hasStringField(source: unknown, key: string): boolean {
    return readStringField(source, key) != null;
}

function getSurfaceOverride(media: unknown, surface?: StoryDeckMediaSurface): Readonly<Record<string, unknown>> | null {
    if (!surface || !isRecord(media)) return null;
    const override = media[surface];
    return isRecord(override) ? override : null;
}

function omitFields(source: Readonly<Record<string, unknown>>, fields: readonly string[]): Record<string, unknown> {
    const result: Record<string, unknown> = { ...source };
    for (const field of fields) {
        delete result[field];
    }
    return result;
}

const IMAGE_SOURCE_FIELDS = ['localAssetKey', 'key', 'primaryUrl', 'fallbackUrl', 'url'] as const;
const VIDEO_SOURCE_FIELDS = ['key', 'primaryUrl', 'fallbackUrl', 'url'] as const;
const VIDEO_POSTER_FIELDS = ['localPosterAssetKey', 'posterKey', 'posterUrl', 'posterFallbackUrl'] as const;

function hasAnyStringField(source: unknown, fields: readonly string[]): boolean {
    return fields.some((field) => hasStringField(source, field));
}

function mergeImageMediaForSurface(media: unknown, surface?: StoryDeckMediaSurface): unknown {
    if (!isRecord(media)) return media;
    const override = getSurfaceOverride(media, surface);
    if (!override) return media;
    const base = hasAnyStringField(override, IMAGE_SOURCE_FIELDS)
        ? omitFields(media, IMAGE_SOURCE_FIELDS)
        : { ...media };
    return { ...base, ...override };
}

function mergeVideoMediaForSurface(media: unknown, surface?: StoryDeckMediaSurface): unknown {
    if (!isRecord(media)) return media;
    const override = getSurfaceOverride(media, surface);
    if (!override) return media;

    let base: Record<string, unknown> = { ...media };
    if (hasAnyStringField(override, VIDEO_SOURCE_FIELDS)) {
        base = omitFields(base, VIDEO_SOURCE_FIELDS);
    }
    if (hasAnyStringField(override, VIDEO_POSTER_FIELDS)) {
        base = omitFields(base, VIDEO_POSTER_FIELDS);
    }
    return { ...base, ...override };
}

export function resolveStoryDeckImageMediaForSurface<T>(media: T, surface?: StoryDeckMediaSurface): T {
    return mergeImageMediaForSurface(media, surface) as T;
}

export function resolveStoryDeckVideoMediaForSurface<T>(media: T, surface?: StoryDeckMediaSurface): T {
    return mergeVideoMediaForSurface(media, surface) as T;
}

export function resolveStoryDeckMediaSources(
    media: unknown,
    options?: ResolveMediaSourceOptions,
): StoryDeckResolvedMediaSources {
    const resolvedMedia = mergeVideoMediaForSurface(media, options?.surface);
    const explicitPrimaryUrl = readStringField(resolvedMedia, 'primaryUrl') ?? readStringField(resolvedMedia, 'url');
    const explicitFallbackUrl = readStringField(resolvedMedia, 'fallbackUrl');
    const resolved = explicitPrimaryUrl ? null : resolveAssetFromKey(readStringField(resolvedMedia, 'key'));

    const primaryUrl = explicitPrimaryUrl ?? resolved?.url ?? null;
    const fallbackUrl = explicitFallbackUrl ?? resolved?.fallbackUrl ?? null;
    const urls = uniqueUrls([primaryUrl, fallbackUrl]);

    return {
        primaryUrl,
        fallbackUrl,
        urls,
        sha256: resolved?.sha256 ?? null,
    };
}

function buildImageSources(
    media: unknown,
    localKeyField: string,
    remoteSources: StoryDeckResolvedMediaSources,
    options?: ResolveImageSourceOptions,
): StoryDeckResolvedImageSources {
    const localKey = readStringField(media, localKeyField);
    const resolveBundled = options?.resolveBundledImageAsset ?? resolveStoryDeckBundledImageAsset;
    const localSourceValue = localKey ? resolveBundled(localKey) : null;
    const localSource: StoryDeckImageSource | null = localKey && localSourceValue
        ? { kind: 'local', key: localKey, source: localSourceValue }
        : null;
    const remoteSourcesList: StoryDeckImageSource[] = remoteSources.urls.map((uri) => ({
        kind: 'remote',
        uri,
        source: { uri },
    }));
    const sources = uniqueImageSources([localSource, ...remoteSourcesList]);

    return {
        primarySource: sources[0] ?? null,
        fallbackSource: sources[1] ?? null,
        sources,
        cacheKey: sources.map(sourceKey).join('|'),
    };
}

export function resolveStoryDeckImageSources(
    media: unknown,
    options?: ResolveImageSourceOptions,
): StoryDeckResolvedImageSources {
    const resolvedMedia = mergeImageMediaForSurface(media, options?.surface);
    return buildImageSources(resolvedMedia, 'localAssetKey', resolveStoryDeckMediaSources(resolvedMedia), options);
}

export function resolveStoryDeckPosterSources(
    media: unknown,
    options?: ResolveMediaSourceOptions,
): StoryDeckResolvedMediaSources {
    const resolvedMedia = mergeVideoMediaForSurface(media, options?.surface);
    const explicitPrimaryUrl = readStringField(resolvedMedia, 'posterUrl');
    const explicitFallbackUrl = readStringField(resolvedMedia, 'posterFallbackUrl');
    const resolved = explicitPrimaryUrl ? null : resolveAssetFromKey(readStringField(resolvedMedia, 'posterKey'));

    const primaryUrl = explicitPrimaryUrl ?? resolved?.url ?? null;
    const fallbackUrl = explicitFallbackUrl ?? resolved?.fallbackUrl ?? null;
    const urls = uniqueUrls([primaryUrl, fallbackUrl]);

    return {
        primaryUrl,
        fallbackUrl,
        urls,
        sha256: resolved?.sha256 ?? null,
    };
}

export function resolveStoryDeckPosterImageSources(
    media: unknown,
    options?: ResolveImageSourceOptions,
): StoryDeckResolvedImageSources {
    const resolvedMedia = mergeVideoMediaForSurface(media, options?.surface);
    return buildImageSources(resolvedMedia, 'localPosterAssetKey', resolveStoryDeckPosterSources(resolvedMedia), options);
}
