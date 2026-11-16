import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { attachPrecomputedDeclarationFields, defineDeferredDeclarationField } from '@happier-dev/protocol/plugins/contributions/deferredDeclarationFields';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { ingestCanonicalPluginManifest, type CanonicalPluginManifestIngestionResult } from '@/plugins/manifest/ingest';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import {
    BUNDLED_DECLARATION_ASSET_DIR, BUNDLED_DEFERRED_ACTION_KEYS, bundledDeclarationAssetFileName,
    digestBundledDeclarationText, projectBundledDeclarationAssets,
    type BundledDeclarationSummaryV1, type BundledDeclarationValuesV1, type BundledDeferredActionKey,
} from './declarationAssets';
import { logger } from '@/ui/logger';

type BundledManifestLocator = Readonly<{ manifestRelativePath: string }> | Readonly<{ manifest: unknown }>;

function resolveBundledPluginManifestPath(locator: Readonly<{ manifestRelativePath: string }>, runtimeRoot?: string): string {
    return runtimeRoot ? join(runtimeRoot, locator.manifestRelativePath) : resolveCliRuntimeAssetPath(locator.manifestRelativePath);
}

function readBundledPluginManifestText(locator: Readonly<{ manifestRelativePath: string }>, runtimeRoot?: string): string {
    return readFileSync(resolveBundledPluginManifestPath(locator, runtimeRoot), 'utf8');
}

/** Preserve file JSON for canonical ingress, which owns decoding and validation. */
export function readBundledPluginManifestInput(locator: BundledManifestLocator, runtimeRoot?: string): unknown {
    return 'manifest' in locator ? locator.manifest : readBundledPluginManifestText(locator, runtimeRoot);
}

/**
 * Bundled declarations repeat the same JSON Schema subtrees across their Actions,
 * and every long-lived process retains them. Keep one object per repeated subtree
 * in this manifest; shared subtrees are frozen so a mutation cannot reach siblings.
 * Key order is part of the identity, so the parsed value stays structurally exact.
 */
function shareRepeatedJsonSubtrees(root: unknown): unknown {
    const canonicalByKey = new Map<string, { value: object; id: number; shared: boolean }>();
    const idOf = new Map<object, number>();
    let deferredHolders = 0;
    const visit = (node: unknown): unknown => {
        if (node === null || typeof node !== 'object') return node;
        const array = Array.isArray(node);
        const record = node as Record<string, unknown>;
        let key = array ? '[' : '{';
        for (const property of Object.keys(record)) {
            // A deferred declaration value is not part of this read: never
            // materialize it here, and never merge its holder with another.
            if (Object.getOwnPropertyDescriptor(record, property)?.get) {
                deferredHolders += 1;
                key = `${key}deferred#${deferredHolders},`;
                continue;
            }
            const child = visit(record[property]);
            record[property] = child;
            key += `${array ? '' : `${JSON.stringify(property)}:`}${child !== null && typeof child === 'object' ? `#${idOf.get(child)}` : JSON.stringify(child)},`;
        }
        const existing = canonicalByKey.get(key);
        if (existing) {
            if (!existing.shared) { existing.shared = true; Object.freeze(existing.value); }
            return existing.value;
        }
        const entry = { value: node, id: canonicalByKey.size, shared: false };
        canonicalByKey.set(key, entry);
        idOf.set(node, entry.id);
        return node;
    };
    return visit(root);
}

type DeferredActionValues = Readonly<Record<string, unknown>>;
/** One read per declaration file and process, shared by every reader of that plugin and key. */
const deferredActionValuesByPath = new Map<string, Readonly<{ declarationDigest: string; values: DeferredActionValues }>>();

/** A bundled manifest was rewritten under a running process; its admitted summary can no longer be completed. */
export class BundledPluginDeclarationChangedError extends Error {
    readonly code = 'bundled_plugin_declaration_changed';
    constructor(readonly pluginId: string) {
        super(`Bundled plugin declaration '${pluginId}' changed after admission; restart to admit it`);
        this.name = 'BundledPluginDeclarationChangedError';
    }
}

function readDeferredActionValues(params: Readonly<{
    valuesPath: string; manifestPath: string; pluginId: string; declarationDigest: string; key: BundledDeferredActionKey;
}>): DeferredActionValues {
    const retained = deferredActionValuesByPath.get(params.valuesPath);
    if (retained?.declarationDigest === params.declarationDigest) return retained.values;
    let file: Partial<BundledDeclarationValuesV1> | undefined;
    try {
        file = JSON.parse(readFileSync(params.valuesPath, 'utf8')) as Partial<BundledDeclarationValuesV1>;
    } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
    }
    let valuesByActionId = file?.v === 1 && file.declarationDigest === params.declarationDigest ? file.valuesByActionId : undefined;
    if (!valuesByActionId || typeof valuesByActionId !== 'object') {
        // The schema file is missing or from another publication: complete the
        // admitted summary from its own verified manifest, loudly.
        const manifestText = readFileSync(params.manifestPath, 'utf8');
        if (digestBundledDeclarationText(manifestText) !== params.declarationDigest) {
            throw new BundledPluginDeclarationChangedError(params.pluginId);
        }
        logger.warn('[PLUGINS] Bundled declaration schema asset is stale; reading the manifest', {
            code: 'bundled_declaration_asset_stale', pluginId: params.pluginId, asset: basename(params.valuesPath),
        });
        valuesByActionId = projectBundledDeclarationAssets(manifestText)[params.key].valuesByActionId;
    }
    const values = shareRepeatedJsonSubtrees(valuesByActionId) as DeferredActionValues;
    deferredActionValuesByPath.set(params.valuesPath, { declarationDigest: params.declarationDigest, values });
    return values;
}

/**
 * The publisher's summary keeps each deferred Action value as `null` in its key
 * position; replace it with a deferred declaration field and attach the
 * publisher-derived input hints. Kept apart from the reader closures: an
 * accessor must not share a scope with the parsed action.
 */
function deferActionSchemaValues(
    action: Readonly<Record<string, unknown>>,
    createRead: (actionId: string, key: BundledDeferredActionKey) => () => unknown,
    inputHints: Readonly<{ value: unknown }> | null,
): Record<string, unknown> {
    const actionId = action.id as string;
    const deferred: Record<string, unknown> = {};
    for (const key of Object.keys(action)) {
        if ((BUNDLED_DEFERRED_ACTION_KEYS as readonly string[]).includes(key) && action[key] === null) {
            // The publisher defers only admitted Action JSON Schemas, which are JSON objects.
            defineDeferredDeclarationField(deferred, key, createRead(actionId, key as BundledDeferredActionKey), { jsonObject: true });
        } else {
            deferred[key] = action[key];
        }
    }
    if (inputHints) attachPrecomputedDeclarationFields(deferred, { inputHints: inputHints.value });
    return deferred;
}

function readSummaryFile(manifestPath: string): Partial<BundledDeclarationSummaryV1> | undefined {
    try {
        return JSON.parse(readFileSync(join(dirname(manifestPath), BUNDLED_DECLARATION_ASSET_DIR,
            bundledDeclarationAssetFileName(basename(manifestPath), 'summary')), 'utf8')) as Partial<BundledDeclarationSummaryV1>;
    } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
        throw error;
    }
}

/**
 * The summary of exactly these manifest bytes, or undefined. A summary from
 * another publication is never trusted (and never drops the plugin): the
 * caller reads the manifest itself, and the mismatch is reported.
 */
function readVerifiedSummary(manifestPath: string, declarationDigest: string): BundledDeclarationSummaryV1 | undefined {
    const summary = readSummaryFile(manifestPath);
    if (!summary) return undefined;
    if (summary.v !== 1 || summary.declarationDigest !== declarationDigest || !summary.manifest || typeof summary.manifest !== 'object'
        || !summary.inputHintsByActionId || typeof summary.inputHintsByActionId !== 'object'
        || typeof summary.canonicalDeclarationDigest !== 'string') {
        logger.warn('[PLUGINS] Bundled declaration summary does not match its manifest; reading the manifest', {
            code: 'bundled_declaration_asset_stale', manifest: basename(manifestPath),
        });
        return undefined;
    }
    return summary as BundledDeclarationSummaryV1;
}

function deferSummaryActions(manifestPath: string, summary: BundledDeclarationSummaryV1): unknown {
    const { declarationDigest, inputHintsByActionId } = summary;
    const manifest = summary.manifest as { id?: unknown; contributes?: { actions?: unknown } };
    const pluginId = String(manifest.id);
    const directory = join(dirname(manifestPath), BUNDLED_DECLARATION_ASSET_DIR);
    const valuesPaths = {
        inputSchema: join(directory, bundledDeclarationAssetFileName(basename(manifestPath), 'inputSchema')),
        resultSchema: join(directory, bundledDeclarationAssetFileName(basename(manifestPath), 'resultSchema')),
    };
    const actions = manifest.contributes?.actions;
    if (Array.isArray(actions)) {
        for (let index = 0; index < actions.length; index += 1) {
            const action: unknown = actions[index];
            if (!action || typeof action !== 'object' || typeof (action as { id?: unknown }).id !== 'string') continue;
            const actionId = (action as { id: string }).id;
            actions[index] = deferActionSchemaValues(action as Record<string, unknown>,
                (id, key) => () => readDeferredActionValues({ valuesPath: valuesPaths[key], manifestPath, pluginId, declarationDigest, key })[id],
                Object.hasOwn(inputHintsByActionId, actionId) ? { value: inputHintsByActionId[actionId] } : null);
        }
    }
    return manifest;
}

/**
 * Parsed declarations for field projection; executable ingress owns validation.
 * File declarations are read from the publisher's summary of exactly these
 * manifest bytes: Action input/result JSON Schemas (~79% of the bytes) become
 * deferred declaration fields read on first use, and their input hints arrive
 * precomputed. Without a matching summary (inline manifests, fixture or older
 * retained runtime roots, or an unregenerated checkout) the manifest itself is
 * read, so a declaration is never stale or dropped.
 */
export function readBundledPluginManifest(locator: BundledManifestLocator, runtimeRoot?: string): unknown {
    if ('manifest' in locator) return locator.manifest;
    const manifestPath = resolveBundledPluginManifestPath(locator, runtimeRoot);
    const manifestText = readFileSync(manifestPath, 'utf8');
    const summary = readVerifiedSummary(manifestPath, digestBundledDeclarationText(manifestText));
    const manifest = shareRepeatedJsonSubtrees(summary ? deferSummaryActions(manifestPath, summary) : JSON.parse(manifestText));
    if (summary && manifest && typeof manifest === 'object') {
        // Exact verified bytes, attached after subtree sharing. An authored
        // projection's object spread intentionally drops this identity.
        attachPrecomputedDeclarationFields(manifest, { canonicalDeclarationDigest: summary.canonicalDeclarationDigest });
    }
    return manifest;
}

/**
 * The server-compatible release-less declaration digest of a bundled file
 * declaration (see `BundledDeclarationSummaryV1.canonicalDeclarationDigest`),
 * from its verified summary; null without one. Never materializes schemas.
 */
export function readBundledPluginCanonicalDeclarationDigest(
    locator: Readonly<{ manifestRelativePath: string }>,
    runtimeRoot?: string,
): string | null {
    const manifestPath = resolveBundledPluginManifestPath(locator, runtimeRoot);
    return readVerifiedSummary(manifestPath, digestBundledDeclarationText(readFileSync(manifestPath, 'utf8')))
        ?.canonicalDeclarationDigest ?? null;
}

/** The publisher owns file declarations; generic inline inputs still cross admission. */
export function ingestBundledPluginManifest(locator: BundledManifestLocator, manifest: unknown): CanonicalPluginManifestIngestionResult {
    const options = { purpose: 'installedRead', manifestAuthority: 'bundled_first_party', sourceProvenance: 'localSource' } as const;
    // Generated files serialize the canonical publisher's successfully admitted
    // manifest. The only assertion is at that same-build JSON decoding boundary.
    return 'manifestRelativePath' in locator
        ? ingestCanonicalPluginManifest(manifest as CanonicalPluginManifest, { ...options, admission: 'build' })
        : ingestCanonicalPluginManifest(manifest, options);
}
