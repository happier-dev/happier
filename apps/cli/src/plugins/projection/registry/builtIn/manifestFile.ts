import { join } from 'node:path';
import { attachPrecomputedDeclarationFields, defineDeferredDeclarationField } from '@happier-dev/protocol/plugins/contributions/deferredDeclarationFields';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { ingestCanonicalPluginManifest, type CanonicalPluginManifestIngestionResult } from '@/plugins/manifest/ingest';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import {
    SCHEMA_SECTIONS, readIndexedBundledDeclarationManifest, withIndexedBundledDeclaration,
    type DeclarationSummary, type SchemaSection, type SchemaValues,
} from './declarationAssetFormat.mjs';

type BundledManifestLocator = Readonly<{ manifestRelativePath: string }> | Readonly<{ manifest: unknown }>;

function resolveBundledPluginManifestPath(locator: Readonly<{ manifestRelativePath: string }>, runtimeRoot?: string): string {
    return runtimeRoot ? join(runtimeRoot, locator.manifestRelativePath) : resolveCliRuntimeAssetPath(locator.manifestRelativePath);
}

/** Full declaration for canonical ingress (including retained runner attestation). */
export function readBundledPluginManifestInput(locator: BundledManifestLocator, runtimeRoot?: string): unknown {
    return 'manifest' in locator
        ? locator.manifest
        : readIndexedBundledDeclarationManifest(resolveBundledPluginManifestPath(locator, runtimeRoot));
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

/** A bundled manifest was rewritten under a running process; its admitted summary can no longer be completed. */
export class BundledPluginDeclarationChangedError extends Error {
    readonly code = 'bundled_plugin_declaration_changed';
    constructor(readonly pluginId: string) {
        super(`Bundled plugin declaration '${pluginId}' changed after admission; restart to admit it`);
        this.name = 'BundledPluginDeclarationChangedError';
    }
}

/**
 * The publisher's summary keeps each deferred Action value as `null` in its key
 * position; replace it with a deferred declaration field and attach the
 * publisher-derived input hints. Kept apart from the reader closures: an
 * accessor must not share a scope with the parsed action.
 */
function deferActionSchemaValues(
    action: Readonly<Record<string, unknown>>,
    createRead: (actionId: string, key: SchemaSection) => () => unknown,
    inputHints: Readonly<{ value: unknown }> | null,
): Record<string, unknown> {
    const actionId = action.id as string;
    const deferred: Record<string, unknown> = {};
    for (const key of Object.keys(action)) {
        if ((SCHEMA_SECTIONS as readonly string[]).includes(key) && action[key] === null) {
            // The publisher defers only admitted Action JSON Schemas, which are JSON objects.
            defineDeferredDeclarationField(deferred, key, createRead(actionId, key as SchemaSection), { jsonObject: true });
        } else {
            deferred[key] = action[key];
        }
    }
    if (inputHints) attachPrecomputedDeclarationFields(deferred, { inputHints: inputHints.value });
    return deferred;
}

function deferSummaryActions(manifestPath: string, summary: DeclarationSummary): unknown {
    const manifest = summary.manifest as { id?: unknown; contributes?: { actions?: unknown } };
    const pluginId = String(manifest.id);
    const sections = new Map<SchemaSection, SchemaValues>();
    const readActionSchema = (id: string, section: SchemaSection) => {
        let values = sections.get(section);
        if (!values) {
            values = withIndexedBundledDeclaration(manifestPath, (current, readSection) => {
                if (current.declarationDigest !== summary.declarationDigest) {
                    throw new BundledPluginDeclarationChangedError(pluginId);
                }
                return shareRepeatedJsonSubtrees(readSection(section)) as SchemaValues;
            });
            sections.set(section, values);
        }
        return values[id];
    };
    const actions = manifest.contributes?.actions;
    if (Array.isArray(actions)) {
        for (let index = 0; index < actions.length; index += 1) {
            const action: unknown = actions[index];
            if (!action || typeof action !== 'object' || typeof (action as { id?: unknown }).id !== 'string') continue;
            const actionId = (action as { id: string }).id;
            actions[index] = deferActionSchemaValues(action as Record<string, unknown>,
                (id, section) => () => readActionSchema(id, section), Object.hasOwn(summary.inputHintsByActionId, actionId)
                    ? { value: summary.inputHintsByActionId[actionId] } : null);
        }
    }
    return manifest;
}

/** Read the current summary and leave Action schemas deferred until first use. */
export function readBundledPluginManifest(locator: BundledManifestLocator, runtimeRoot?: string): unknown {
    if ('manifest' in locator) return locator.manifest;
    const manifestPath = resolveBundledPluginManifestPath(locator, runtimeRoot);
    return withIndexedBundledDeclaration(manifestPath, summary => {
        const manifest = shareRepeatedJsonSubtrees(deferSummaryActions(manifestPath, summary));
        if (manifest && typeof manifest === 'object') {
            attachPrecomputedDeclarationFields(manifest, { canonicalDeclarationDigest: summary.canonicalDeclarationDigest });
        }
        return manifest;
    });
}

/** Server-compatible release-less declaration digest, without materializing schemas. */
export function readBundledPluginCanonicalDeclarationDigest(
    locator: Readonly<{ manifestRelativePath: string }>,
    runtimeRoot?: string,
): string {
    return withIndexedBundledDeclaration(resolveBundledPluginManifestPath(locator, runtimeRoot),
        header => header.canonicalDeclarationDigest);
}

/** The publisher owns file declarations; generic inline inputs still cross admission. */
export function ingestBundledPluginManifest(locator: BundledManifestLocator, manifest: unknown): CanonicalPluginManifestIngestionResult {
    const options = { purpose: 'installedRead', manifestAuthority: 'bundled_first_party', sourceProvenance: 'localSource' } as const;
    // Generated files serialize the canonical publisher's successfully admitted
    // manifest. The only assertion is at that same-build JSON decoding boundary.
    return 'manifest' in locator
        ? ingestCanonicalPluginManifest(manifest, options)
        : ingestCanonicalPluginManifest(manifest as CanonicalPluginManifest, { ...options, admission: 'build' });
}
