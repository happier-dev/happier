import type { ImageProps } from 'expo-image';

import { resolveAssetUrl } from '@/changelog/releaseNotes/assetUrlResolver';

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

export function resolveStoryDeckMediaSources(media: unknown): StoryDeckResolvedMediaSources {
    const explicitPrimaryUrl = readStringField(media, 'primaryUrl') ?? readStringField(media, 'url');
    const explicitFallbackUrl = readStringField(media, 'fallbackUrl');
    const resolved = explicitPrimaryUrl ? null : resolveAssetFromKey(readStringField(media, 'key'));

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
    return buildImageSources(media, 'localAssetKey', resolveStoryDeckMediaSources(media), options);
}

export function resolveStoryDeckPosterSources(media: unknown): StoryDeckResolvedMediaSources {
    const explicitPrimaryUrl = readStringField(media, 'posterUrl');
    const explicitFallbackUrl = readStringField(media, 'posterFallbackUrl');
    const resolved = explicitPrimaryUrl ? null : resolveAssetFromKey(readStringField(media, 'posterKey'));

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
    return buildImageSources(media, 'localPosterAssetKey', resolveStoryDeckPosterSources(media), options);
}
