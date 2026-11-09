import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { ingestCanonicalPluginManifest, type CanonicalPluginManifestIngestionResult } from '@/plugins/manifest/ingest';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

type BundledManifestLocator = Readonly<{ manifestRelativePath: string }> | Readonly<{ manifest: unknown }>;

function readBundledPluginManifestText(locator: Readonly<{ manifestRelativePath: string }>, runtimeRoot?: string): string {
    const manifestPath = runtimeRoot ? join(runtimeRoot, locator.manifestRelativePath) : resolveCliRuntimeAssetPath(locator.manifestRelativePath);
    return readFileSync(manifestPath, 'utf8');
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
    const visit = (node: unknown): unknown => {
        if (node === null || typeof node !== 'object') return node;
        const array = Array.isArray(node);
        const record = node as Record<string, unknown>;
        let key = array ? '[' : '{';
        for (const property of Object.keys(record)) {
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

/** Parsed declarations for field projection; executable ingress owns validation. */
export function readBundledPluginManifest(locator: BundledManifestLocator, runtimeRoot?: string): unknown {
    return 'manifest' in locator ? locator.manifest : shareRepeatedJsonSubtrees(JSON.parse(readBundledPluginManifestText(locator, runtimeRoot)));
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
