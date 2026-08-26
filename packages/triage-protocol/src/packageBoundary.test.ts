import { readFile } from 'node:fs/promises';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';
import * as testingV1 from './testing/v1/index.js';

/**
 * Every name the emitted declaration file publishes, including the type-only
 * ones no runtime import can see.
 *
 * `export *` and `export default` are counted rather than expanded: either one
 * would make the published set unenumerable here, which is the same as having
 * no fence at all.
 */
function publishedDeclarationNames(declarationText: string): Readonly<{
    names: readonly string[];
    unenumerable: number;
}> {
    const source = ts.createSourceFile(
        'index.d.ts',
        declarationText,
        ts.ScriptTarget.ES2022,
        true,
    );
    const names: string[] = [];
    let unenumerable = 0;
    for (const statement of source.statements) {
        if (ts.isExportAssignment(statement)) {
            unenumerable += 1;
            continue;
        }
        if (ts.isExportDeclaration(statement)) {
            const clause = statement.exportClause;
            if (clause === undefined || !ts.isNamedExports(clause)) {
                unenumerable += 1;
                continue;
            }
            for (const element of clause.elements) names.push(element.name.text);
            continue;
        }
        const exported = ts.canHaveModifiers(statement)
            && (ts.getModifiers(statement) ?? [])
                .some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
            }
            continue;
        }
        const named = 'name' in statement ? statement.name : undefined;
        if (named !== undefined && typeof named === 'object' && ts.isIdentifier(named)) {
            names.push(named.text);
            continue;
        }
        unenumerable += 1;
    }
    return { names, unenumerable };
}

describe('Triage protocol public barrel', () => {
    it('projects the explicit V1 contribution contract from the root entry point', () => {
        expect(protocol.TriageSourcesContributionPointV1).toMatchObject({
            maxContributionsPerContributor: 1,
            protocols: [{
                id: 'happier.triage/sources',
                version: 1,
            }],
        });
        expect(protocol.TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1).toBe('sources');
        expect(protocol.TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1).toBe('happier.triage');
    });

    it('exposes no default, current, latest, or legacy alias', () => {
        const aliases = Object.keys(protocol)
            .filter((name) => /(?:Current|Latest|Legacy|Default)$/u.test(name));

        expect(aliases).toEqual([]);
        expect(Object.hasOwn(protocol, 'default')).toBe(false);
    });

    /**
     * A `*JsonSchema` alias is published only where a consumer cannot reach
     * `Schema.jsonSchema` itself.
     *
     * `jsonSchema` is a member of the public `ProtocolComposableSchema`
     * interface, so every composable schema this package exports already
     * carries its own JSON Schema projection. An alias beside it therefore adds
     * no capability at all — it only adds a second published name for one
     * value, and a published name is permanent. The three kept here are the
     * ones a consumer genuinely needs as a standalone value: two Collection
     * definitions in `packages/plugins/triage/src/corpus/collections/
     * definitions.ts` and the detail-envelope projection a source mount
     * asserts against.
     *
     * The list is exhaustive on purpose. Asserting only the identity of a few
     * named aliases would pass just as well with thirty-six unused ones beside
     * them, which is exactly the state this replaced.
     */
    it('publishes exactly the JSON Schema aliases a consumer cannot derive itself', () => {
        const aliases = Object.keys(protocol).filter((name) => name.endsWith('JsonSchema')).sort();

        expect(aliases).toEqual([
            'TriageConfiguredSourceInstanceV1JsonSchema',
            'TriageDetailSurfaceInputV1JsonSchema',
            'TriageEntryRefV1JsonSchema',
        ]);
        expect(protocol.TriageConfiguredSourceInstanceV1JsonSchema)
            .toBe(protocol.TriageConfiguredSourceInstanceV1Schema.jsonSchema);
        expect(protocol.TriageDetailSurfaceInputV1JsonSchema)
            .toBe(protocol.TriageDetailSurfaceInputV1Schema.jsonSchema);
        expect(protocol.TriageEntryRefV1JsonSchema)
            .toBe(protocol.TriageEntryRefV1Schema.jsonSchema);
    });

    /**
     * The published surface carries no projection a consumer never calls.
     *
     * `projectTriageDetailFieldV1` was published beside
     * `projectTriageDetailFieldsV1`, which is its only caller anywhere. Every
     * source renders a snapshot's facts in declared order, so the plural is the
     * contract; the singular was an internal step of it.
     */
    it('publishes the plural detail-field projection and not its internal step', () => {
        expect(typeof protocol.projectTriageDetailFieldsV1).toBe('function');
        expect(Object.hasOwn(protocol, 'projectTriageDetailFieldV1')).toBe(false);
    });

    it('publishes every V1 bound source projections and target limits are derived from', () => {
        // The exact values are owned by `v1/bounds.ts` and proven fit for the
        // shape inventory by `v1/maximumEncodedResult.test.ts`; restating them
        // here would create a second bounds ledger that drifts. What the public
        // barrel owes its consumers is that each bound is exported and usable.
        const bounds = Object.entries(protocol)
            .filter(([name]) => name.startsWith('MAX_TRIAGE_'));

        expect(bounds.map(([name]) => name).sort()).toEqual([
            'MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1',
            'MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1',
            'MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1',
            'MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1',
            'MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1',
            'MAX_TRIAGE_LOCATION_UTF8_BYTES_V1',
            'MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1',
            'MAX_TRIAGE_REPOSITORY_PATH_UTF8_BYTES_V1',
            'MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1',
            'MAX_TRIAGE_ROW_FACTS_V1',
            'MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1',
            'MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1',
            'MAX_TRIAGE_TEXT_UTF8_BYTES_V1',
        ]);
        for (const [name, value] of bounds) {
            expect(value, name).toSatisfy(
                (bound: unknown) => Number.isSafeInteger(bound) && (bound as number) > 0,
            );
        }
        // The scan page count and the display-text bound are one budget: the
        // page multiplies every per-entry display byte on the way to the
        // operation-shape inventory. `maximumEncodedResult.test.ts` derives that worst
        // case; pinning both values here is what makes a consumer-visible
        // change to either one deliberate.
        expect(protocol.MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1).toBe(64);
        expect(protocol.MAX_TRIAGE_TEXT_UTF8_BYTES_V1).toBe(512);
    });
});

/**
 * `/testing/v1` is a source author's conformance and fixture entry point.
 *
 * `CONTRACT.md` §1 scopes it to "fixtures and conformance assertions only", and
 * §9 adds the one published byte-gate derivation, because two packages must
 * agree on a single worst case rather than keep two walks that drift. What that
 * needs is the derivation itself and the values a caller feeds it — not the
 * internal steps the walk is built from. Those stay importable from
 * `./maximumEncodedValue.js` for this package's own derivation test, which is
 * the only thing that ever exercised them.
 */
describe('Triage protocol testing/v1 entry point', () => {
    it('publishes the conformance surface and the one byte-gate derivation, and no walk internal', () => {
        expect(Object.keys(testingV1).sort()).toEqual([
            'assertTriageSourceContributionV1',
            'buildMaximalSchemaValue',
            'checkTriageSourceContributionV1',
            'createTriageSourceV1Fixture',
            'deriveMaximumEncodedBytes',
            'deriveMaximumEncodedBytesByLabel',
            'encodedJsonBytes',
        ]);
    });

    /**
     * The runtime-key check above cannot see a type-only export at all: an
     * `export type` emits no runtime binding, so a structural declaration
     * copied from the SDK and published beside the conformance surface is
     * invisible to `Object.keys`. What an installed consumer's compiler reads
     * is the emitted declaration file, so the fence belongs there — this is the
     * half that would have caught the two SDK-shaped copies and let them become
     * permanent published names.
     *
     * `vitest.globalSetup.mjs` builds `dist` before any case runs, so this
     * reads the artifact this package would actually ship.
     */
    it('declares exactly that surface, and its three published types, in the emitted declarations', async () => {
        const published = publishedDeclarationNames(await readFile(
            new URL('../dist/testing/v1/index.d.ts', import.meta.url),
            'utf8',
        ));

        // A star re-export would publish an open set through a fence that
        // still reads green, so the counter has to be provably reachable
        // before its zero here means anything.
        expect(publishedDeclarationNames("export * from './conformance.js';\n").unenumerable)
            .toBe(1);
        expect(published.unenumerable).toBe(0);
        expect([...published.names].sort()).toEqual([
            // The conformance result, the fixture shape, and the one schema
            // input of the published byte-gate derivation. Each is the exact
            // parse/return type of a published value; none restates a
            // declaration the SDK already owns.
            'MeasurableSchemaV1',
            'TriageSourceConformanceResultV1',
            'TriageSourceV1Fixture',
            'assertTriageSourceContributionV1',
            'buildMaximalSchemaValue',
            'checkTriageSourceContributionV1',
            'createTriageSourceV1Fixture',
            'deriveMaximumEncodedBytes',
            'deriveMaximumEncodedBytesByLabel',
            'encodedJsonBytes',
        ]);
    });
});
