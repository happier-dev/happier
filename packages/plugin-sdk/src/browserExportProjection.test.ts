import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

type GenerationPlan = Readonly<{
    packageExports: Readonly<Record<string, unknown>>;
    sourceBarrels: Readonly<Record<string, string>>;
}>;

const packageRoot = resolve(import.meta.dirname, '..');
let plan: GenerationPlan;

beforeAll(async () => {
    // Load the existing JavaScript producer as Node ESM, outside Vite's source resolver.
    const inventoryProducer: {
        readCurrentApiSurfaceInventory: (options: Readonly<{ packageRoot: string }>) => Promise<unknown>;
    } = await import(new URL('../scripts/apiSurfaceCli.mjs', import.meta.url).href);
    const projectionProducer: {
        createApiSurfaceGenerationPlan: (inventory: unknown) => GenerationPlan;
    } = await import(new URL('../scripts/apiSurface.mjs', import.meta.url).href);
    const inventory: unknown = await inventoryProducer.readCurrentApiSurfaceInventory({ packageRoot });
    plan = projectionProducer.createApiSurfaceGenerationPlan(inventory);
}, 60_000);

function expectBrowserBarrelsCurrent(read: (path: string) => string): void {
    const browserBarrels = Object.entries(plan.sourceBarrels)
        .filter(([path]) => path.endsWith('.browser.ts'));
    expect(browserBarrels.length).toBeGreaterThan(0);
    for (const [path, expected] of browserBarrels) {
        expect(read(path), path).toBe(expected);
    }
}

describe('canonical browser export projection', () => {
    it('publishes package conditions from the canonical inventory', () => {
        const packageJson: { exports: unknown } = JSON.parse(
            readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
        );
        expect(packageJson.exports).toEqual(plan.packageExports);
    });

    it('exports every browser-eligible public symbol and excludes other realms', () => {
        expectBrowserBarrelsCurrent((path) => readFileSync(resolve(packageRoot, path), 'utf8'));
    });

    it.each([
        { path: 'src/index.browser.ts', exportName: 'ComposerReferenceCandidateIdV1Schema' },
        { path: 'src/protocol/index.browser.ts', exportName: 'TriageSourceInstanceIdV1Schema' },
    ])(
        'detects a missing any-realm schema in $path',
        ({ path, exportName }) => {
            const source = plan.sourceBarrels[path];
            const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
            const schemaExport = parsed.statements.find((statement) => (
                ts.isExportDeclaration(statement)
                && statement.exportClause
                && ts.isNamedExports(statement.exportClause)
                && statement.exportClause.elements.some((element) => (
                    element.name.text === exportName
                ))
            ));
            expect(schemaExport, 'fixture must remove the real any-realm export').toBeDefined();
            if (!schemaExport) throw new Error('Missing constructed fixture export');
            const missingSchema = source.slice(0, schemaExport.getFullStart())
                + source.slice(schemaExport.end);
            expect(() => expectBrowserBarrelsCurrent((barrel) => (
                barrel === path ? missingSchema : plan.sourceBarrels[barrel]
            ))).toThrow(path);
        },
    );

    it('detects an added Node-only export in a browser barrel', () => {
        const path = 'src/index.browser.ts';
        expect(() => expectBrowserBarrelsCurrent((barrel) => (
            plan.sourceBarrels[barrel]
                + (barrel === path ? "export { readFileSync } from 'node:fs';\n" : '')
        ))).toThrow(path);
    });
});
