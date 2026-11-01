import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

type BundledManifestLocator = Readonly<{ manifestRelativePath: string }> | Readonly<{ manifest: unknown }>;

function readBundledPluginManifestText(locator: Readonly<{ manifestRelativePath: string }>, runtimeRoot?: string): string {
    const manifestPath = runtimeRoot ? join(runtimeRoot, locator.manifestRelativePath) : resolveCliRuntimeAssetPath(locator.manifestRelativePath);
    return readFileSync(manifestPath, 'utf8');
}

/** Preserve file JSON for canonical ingress, which owns decoding and validation. */
export function readBundledPluginManifestInput(locator: BundledManifestLocator, runtimeRoot?: string): unknown {
    return 'manifest' in locator ? locator.manifest : readBundledPluginManifestText(locator, runtimeRoot);
}

/** Parsed declarations for field projection; executable ingress owns validation. */
export function readBundledPluginManifest(locator: BundledManifestLocator, runtimeRoot?: string): unknown {
    return 'manifest' in locator ? locator.manifest : JSON.parse(readBundledPluginManifestText(locator, runtimeRoot)) as unknown;
}
