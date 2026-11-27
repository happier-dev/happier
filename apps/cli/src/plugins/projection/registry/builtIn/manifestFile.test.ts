import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readBundledPluginManifest } from './manifestFile';
import { readIndexedBundledDeclarationManifest } from './declarationAssetFormat.mjs';

const cliRoot = resolve(__dirname, '../../../../..');
const relativePath = 'assets/bundled-plugin-manifests/scm-github.json';

function containers(value: unknown): { occurrences: number; distinct: Set<object> } {
    let occurrences = 0;
    const distinct = new Set<object>();
    const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        occurrences += 1;
        distinct.add(node);
        for (const child of Object.values(node)) visit(child);
    };
    visit(value);
    return { occurrences, distinct };
}

describe('bundled plugin manifest reader', () => {
    it('keeps one object per repeated declaration subtree in the retained manifest', () => {
        const manifest = readBundledPluginManifest({ manifestRelativePath: relativePath }, cliRoot);
        const { occurrences, distinct } = containers(manifest);
        expect(occurrences).toBeGreaterThan(10_000);
        expect(distinct.size * 3).toBeLessThan(occurrences);
    });

    it('stays structurally identical to the declaration and refuses mutation of a shared subtree', () => {
        const declaration = readIndexedBundledDeclarationManifest(resolve(cliRoot, relativePath));
        const manifest = readBundledPluginManifest({ manifestRelativePath: relativePath }, cliRoot);
        expect(manifest).toEqual(declaration);

        const seen = new Set<object>();
        let shared: object | null = null;
        const visit = (node: unknown): void => {
            if (shared || !node || typeof node !== 'object') return;
            if (seen.has(node)) { shared = node; return; }
            seen.add(node);
            for (const child of Object.values(node)) visit(child);
        };
        visit(manifest);
        expect(shared).not.toBeNull();
        expect(Object.isFrozen(shared)).toBe(true);
    });
});
