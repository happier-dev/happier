#!/usr/bin/env tsx
/**
 * Builds the bundled release-notes manifest from authored sources under
 * `apps/ui/release-notes/releases/<releaseId>.json`.
 *
 * Validation:
 *   - JSON schema (zod) for each authored release.
 *   - Translation-key references must exist in every locale file.
 *   - Remote media-key references must resolve to a present authored asset.
 *   - Bundled image-key references must resolve to the story-deck asset registry.
 *
 * Failure semantics: exits non-zero with a clear message so `yarn ota` blocks.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

import * as ts from 'typescript';
import { z } from 'zod';

import {
    STORY_DECK_LIST_CARD_MAX_ROWS,
    STORY_DECK_MAX_CARDS,
} from '../changelog/releaseNotes/storyDeckCardLimits';
import { hasStoryDeckBundledImageAssetKey } from '../components/ui/storyDeck/storyDeckBundledAssetRegistry';

const ROOT = path.resolve(__dirname, '../../');
const RELEASES_DIR = path.join(ROOT, 'release-notes/releases');
const ASSETS_DIR = path.join(ROOT, 'release-notes/assets');
const TRANSLATIONS_DIR = path.join(ROOT, 'sources/text/translations');
const OUT_PATH = path.join(ROOT, 'sources/changelog/releaseNotes/manifest.generated.json');
const OUT_ASSET_INDEX_PATH = path.join(ROOT, 'sources/changelog/releaseNotes/asset-index.generated.json');

const REQUIRED_LOCALES = [
    'ca', 'en', 'es', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant',
] as const;

const ListCardSchema = z.object({
    kind: z.literal('list'),
    titleKey: z.string().min(1),
    rows: z.array(z.object({
        iconId: z.string().min(1),
        titleKey: z.string().min(1),
        bodyKey: z.string().min(1),
    })).min(1).max(STORY_DECK_LIST_CARD_MAX_ROWS),
});

const ImageCardSchema = z.object({
    kind: z.literal('image'),
    titleKey: z.string().min(1),
    bodyKey: z.string().min(1),
    media: z.object({
        localAssetKey: z.string().min(1).optional(),
        key: z.string().min(1).optional(),
        altKey: z.string().min(1),
    }).superRefine((media, ctx) => {
        if (media.localAssetKey || media.key) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Image media must include localAssetKey or key.',
            path: ['key'],
        });
    }),
});

const VideoCardSchema = z.object({
    kind: z.literal('video'),
    titleKey: z.string().min(1),
    bodyKey: z.string().min(1),
    media: z.object({
        key: z.string().min(1),
        localPosterAssetKey: z.string().min(1).optional(),
        posterKey: z.string().min(1).optional(),
        accessibilityLabelKey: z.string().min(1),
        loop: z.boolean().optional(),
        muted: z.boolean().optional(),
    }).superRefine((media, ctx) => {
        if (media.localPosterAssetKey || media.posterKey) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Video media must include localPosterAssetKey or posterKey.',
            path: ['posterKey'],
        });
    }),
});

const CardSchema = z.discriminatedUnion('kind', [
    ListCardSchema,
    ImageCardSchema,
    VideoCardSchema,
]);

const AuthoredReleaseSchema = z.object({
    releaseId: z.string().min(1),
    versionLabel: z.string().min(1),
    publishedAt: z.string().min(1),
    titleKey: z.string().min(1),
    subtitleKey: z.string().optional(),
    cards: z.array(CardSchema).min(1).max(STORY_DECK_MAX_CARDS),
    actions: z.object({
        viewFullReleaseNotes: z.boolean().optional(),
    }).optional(),
});

type AuthoredRelease = z.infer<typeof AuthoredReleaseSchema>;
type AuthoredCard = z.infer<typeof CardSchema>;

type ReleaseNotesAssetIndexEntry = Readonly<{
    assetKey: string;
    releaseId: string;
    path: string;
    fileName: string;
    sha256: string;
    contentType: string;
    sizeBytes: number;
}>;

function readJson(filePath: string): unknown {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
}

function listAuthoredReleases(): AuthoredRelease[] {
    if (!fs.existsSync(RELEASES_DIR)) {
        return [];
    }
    const files = fs.readdirSync(RELEASES_DIR).filter((name) => name.endsWith('.json'));
    const releases: AuthoredRelease[] = [];
    for (const fileName of files) {
        const fullPath = path.join(RELEASES_DIR, fileName);
        let raw: unknown;
        try {
            raw = readJson(fullPath);
        } catch (error) {
            throw new Error(`Failed to read ${fullPath}: ${(error as Error).message}`);
        }
        const result = AuthoredReleaseSchema.safeParse(raw);
        if (!result.success) {
            throw new Error(
                `Invalid authored release at ${fullPath}: ${JSON.stringify(result.error.issues, null, 2)}`,
            );
        }
        releases.push(result.data);
    }
    return releases;
}

function collectTranslationKeyRefs(card: AuthoredCard): string[] {
    const keys: string[] = [card.titleKey];
    if (card.kind === 'list') {
        for (const row of card.rows) {
            keys.push(row.titleKey, row.bodyKey);
        }
    } else if (card.kind === 'image') {
        keys.push(card.bodyKey, card.media.altKey);
    } else {
        keys.push(card.bodyKey, card.media.accessibilityLabelKey);
    }
    return keys;
}

function readLocaleTranslationPaths(locale: string): Set<string> {
    const filePath = path.join(TRANSLATIONS_DIR, `${locale}.ts`);
    if (!fs.existsSync(filePath)) return new Set();
    return collectReleaseNotesTranslationPaths(fs.readFileSync(filePath, 'utf-8'));
}

function getPropertyNameText(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return null;
}

function collectObjectPaths(node: ts.Expression, prefix: string, paths: Set<string>): void {
    paths.add(prefix);
    if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = getPropertyNameText(property.name);
            if (!name) continue;
            collectObjectPaths(property.initializer, `${prefix}.${name}`, paths);
        }
        return;
    }
    if (ts.isArrayLiteralExpression(node)) {
        node.elements.forEach((element, index) => {
            collectObjectPaths(element, `${prefix}.${index}`, paths);
        });
    }
}

function collectReleaseNotesTranslationPaths(source: string): Set<string> {
    const sourceFile = ts.createSourceFile('locale.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const paths = new Set<string>();

    function visit(node: ts.Node): void {
        if (ts.isPropertyAssignment(node) && getPropertyNameText(node.name) === 'releaseNotes') {
            collectObjectPaths(node.initializer, 'releaseNotes', paths);
            return;
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return paths;
}

function validateTranslationKeysExistInLocale(
    keys: ReadonlyArray<string>,
    localePaths: Set<string>,
): string[] {
    const missing: string[] = [];
    for (const key of keys) {
        if (!localePaths.has(key)) missing.push(key);
    }
    return missing;
}

function validateTranslationKeyPathsForTests(source: string, keys: ReadonlyArray<string>): string[] {
    return validateTranslationKeysExistInLocale(keys, collectReleaseNotesTranslationPaths(source));
}

function listAuthoredAssetKeys(): Set<string> {
    if (!fs.existsSync(ASSETS_DIR)) return new Set();
    const result = new Set<string>();
    function walk(dir: string, prefix: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(fullPath, rel);
            } else {
                result.add(rel);
            }
        }
    }
    walk(ASSETS_DIR, '');
    return result;
}

function collectMediaKeyRefs(release: AuthoredRelease): string[] {
    const keys: string[] = [];
    for (const card of release.cards) {
        if (card.kind === 'image') {
            if (card.media.key) keys.push(card.media.key);
        } else if (card.kind === 'video') {
            keys.push(card.media.key);
            if (card.media.posterKey) keys.push(card.media.posterKey);
        }
    }
    return keys;
}

function collectBundledImageAssetKeyRefs(release: AuthoredRelease): string[] {
    const keys: string[] = [];
    for (const card of release.cards) {
        if (card.kind === 'image') {
            if (card.media.localAssetKey) keys.push(card.media.localAssetKey);
        } else if (card.kind === 'video' && card.media.localPosterAssetKey) {
            keys.push(card.media.localPosterAssetKey);
        }
    }
    return keys;
}

function normalizeReleaseAssetKey(releaseId: string, key: string): string {
    return key.startsWith(`${releaseId}/`) ? key : `${releaseId}/${key}`;
}

function logicalPathForReleaseAsset(releaseId: string, assetKey: string): string {
    return assetKey.startsWith(`${releaseId}/`) ? assetKey.slice(releaseId.length + 1) : assetKey;
}

function buildFlatPublishedFileName(releaseId: string, logicalPath: string): string {
    return `release-notes__${releaseId}__${logicalPath.replace(/\//g, '__')}`;
}

function inferContentType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'mp4': return 'video/mp4';
        case 'mov': return 'video/quicktime';
        case 'json': return 'application/json';
        default: return 'application/octet-stream';
    }
}

function sha256OfFileSync(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildReleaseNotesAssetIndex(params: {
    releases: ReadonlyArray<AuthoredRelease>;
    assetsDir: string;
    assetBaseUrl: string;
    generatedAt: string;
}): {
    schemaVersion: 'v1';
    generatedAt: string;
    assetsBaseUrl: string;
    assets: Record<string, ReleaseNotesAssetIndexEntry>;
} {
    const assets: Record<string, ReleaseNotesAssetIndexEntry> = {};
    for (const release of params.releases) {
        for (const key of collectMediaKeyRefs(release)) {
            const assetKey = normalizeReleaseAssetKey(release.releaseId, key);
            const logicalPath = logicalPathForReleaseAsset(release.releaseId, assetKey);
            const assetPath = path.join(params.assetsDir, assetKey);
            if (!fs.existsSync(assetPath)) {
                throw new Error(`Release ${release.releaseId} references missing asset: ${key}`);
            }
            const fileStat = fs.statSync(assetPath);
            const fileName = buildFlatPublishedFileName(release.releaseId, logicalPath);
            assets[assetKey] = {
                assetKey,
                releaseId: release.releaseId,
                path: logicalPath,
                fileName,
                sha256: sha256OfFileSync(assetPath),
                contentType: inferContentType(fileName),
                sizeBytes: fileStat.size,
            };
        }
    }
    return {
        schemaVersion: 'v1',
        generatedAt: params.generatedAt,
        assetsBaseUrl: params.assetBaseUrl,
        assets,
    };
}

function buildManifest(releases: AuthoredRelease[]): {
    schemaVersion: 'v1';
    latestReleaseId: string | null;
    generatedAt: string;
    assetBaseUrl: string;
    releases: AuthoredRelease[];
} {
    // Sort by publishedAt descending; latestReleaseId from first.
    const sorted = [...releases].sort((a, b) => {
        const aTs = Date.parse(a.publishedAt);
        const bTs = Date.parse(b.publishedAt);
        if (Number.isNaN(aTs) || Number.isNaN(bTs)) {
            return a.releaseId.localeCompare(b.releaseId);
        }
        return bTs - aTs;
    });

    return {
        schemaVersion: 'v1',
        latestReleaseId: sorted.length > 0 ? sorted[0].releaseId : null,
        generatedAt: new Date().toISOString(),
        assetBaseUrl: process.env.HAPPIER_RELEASE_NOTES_ASSET_BASE_URL
            || 'https://github.com/happier-dev/happier-assets/releases/download/release-notes/',
        releases: sorted,
    };
}

function main() {
    console.log('Parsing release notes...');
    const releases = listAuthoredReleases();
    const generatedAt = new Date().toISOString();
    const assetBaseUrl = process.env.HAPPIER_RELEASE_NOTES_ASSET_BASE_URL
        || 'https://github.com/happier-dev/happier-assets/releases/download/release-notes/';

    if (releases.length === 0) {
        console.warn('No authored releases found. Writing empty manifest.');
        fs.writeFileSync(OUT_PATH, `${JSON.stringify({
            schemaVersion: 'v1',
            latestReleaseId: null,
            generatedAt,
            assetBaseUrl,
            releases: [],
        }, null, 4)}\n`);
        fs.writeFileSync(OUT_ASSET_INDEX_PATH, `${JSON.stringify({
            schemaVersion: 'v1',
            generatedAt,
            assetsBaseUrl: assetBaseUrl,
            assets: {},
        }, null, 4)}\n`);
        return;
    }

    // Validate translation keys.
    const localeKeyMaps = new Map<string, Set<string>>();
    for (const locale of REQUIRED_LOCALES) {
        localeKeyMaps.set(locale, readLocaleTranslationPaths(locale));
    }

    const errors: string[] = [];
    const allTranslationKeys = new Set<string>();
    for (const release of releases) {
        allTranslationKeys.add(release.titleKey);
        if (release.subtitleKey) allTranslationKeys.add(release.subtitleKey);
        for (const card of release.cards) {
            for (const key of collectTranslationKeyRefs(card)) {
                allTranslationKeys.add(key);
            }
        }
    }

    for (const [locale, keys] of localeKeyMaps.entries()) {
        const missing = validateTranslationKeysExistInLocale(Array.from(allTranslationKeys), keys);
        if (missing.length > 0) {
            errors.push(`Locale ${locale} is missing translation keys: ${missing.join(', ')}`);
        }
    }

    // Validate media keys.
    const authoredAssets = listAuthoredAssetKeys();
    for (const release of releases) {
        const mediaKeys = collectMediaKeyRefs(release);
        for (const key of mediaKeys) {
            const absoluteKey = normalizeReleaseAssetKey(release.releaseId, key);
            if (!authoredAssets.has(absoluteKey) && !authoredAssets.has(key)) {
                errors.push(`Release ${release.releaseId} references missing asset: ${key}`);
            }
        }
        for (const key of collectBundledImageAssetKeyRefs(release)) {
            if (!hasStoryDeckBundledImageAssetKey(key)) {
                errors.push(`Release ${release.releaseId} references missing bundled story-deck image asset: ${key}`);
            }
        }
    }

    if (errors.length > 0) {
        console.error('Release notes validation failed:');
        for (const err of errors) console.error(`  - ${err}`);
        process.exit(1);
    }

    const manifest = {
        ...buildManifest(releases),
        generatedAt,
        assetBaseUrl,
    };
    const assetIndex = buildReleaseNotesAssetIndex({
        releases: manifest.releases,
        assetsDir: ASSETS_DIR,
        assetBaseUrl: manifest.assetBaseUrl,
        generatedAt: manifest.generatedAt,
    });
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(manifest, null, 4)}\n`);
    fs.writeFileSync(OUT_ASSET_INDEX_PATH, `${JSON.stringify(assetIndex, null, 4)}\n`);
    console.log(`Wrote ${OUT_PATH}`);
    console.log(`Wrote ${OUT_ASSET_INDEX_PATH}`);
    console.log(`Latest release id: ${manifest.latestReleaseId ?? '(none)'}`);
    console.log(`Total releases: ${manifest.releases.length}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
    }
}

export { main as parseReleaseNotes };
export { validateTranslationKeyPathsForTests };
export { buildReleaseNotesAssetIndex as buildReleaseNotesAssetIndexForTests };
