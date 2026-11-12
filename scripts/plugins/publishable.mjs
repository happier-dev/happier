// @ts-check
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** @param {unknown} value */
export function isPublishablePluginPackage(value) {
  if (!value || typeof value !== 'object') return false;
  const happier = /** @type {{ happier?: unknown }} */ (value).happier;
  return Boolean(happier && typeof happier === 'object' && /** @type {{ bundled?: unknown }} */ (happier).bundled === false);
}

/** @param {string} repoRoot @returns {{ id: string; packageName: string; packageDir: string }[]} */
export function readPublishablePlugins(repoRoot) {
  const root = resolve(repoRoot, 'packages/plugins');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const packageDir = resolve(root, entry.name);
    const manifestPath = resolve(packageDir, 'package.json');
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isPublishablePluginPackage(manifest)) return [];
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error(`Missing publishable plugin package name for ${entry.name}`);
    return [{ id: entry.name, packageName: manifest.name, packageDir }];
  }).sort((left, right) => left.id.localeCompare(right.id));
}
