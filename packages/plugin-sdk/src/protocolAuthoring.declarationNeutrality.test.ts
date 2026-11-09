import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import { emittedSourceAuthoringDeclaration, compileExternalProtocolAuthoringConsumer, disposeSourceAuthoringDeclarations } from './test-support/protocolAuthoringDeclarations.js';
afterAll(disposeSourceAuthoringDeclarations);
import ts from 'typescript';

import {
    defineProtocolJsonValue,
    defineProtocolObject,
    defineProtocolUtf8String,
    defineProtocolUniqueArray,
    type ProtocolComposableSchema,
    type ProtocolJsonValue,
} from './protocol/index.js';

const compiledProtocolAuthoringDeclarationEntrypoint = fileURLToPath(
    new URL('../dist/protocol/index.d.ts', import.meta.url),
);
const compiledTargetedContributionAuthoringDeclaration = fileURLToPath(
    new URL('../dist/targetedContributionAuthoring.d.ts', import.meta.url),
);
const compiledConnectedAccountsDeclaration = fileURLToPath(
    new URL('../dist/connectedAccounts.d.ts', import.meta.url),
);
function declarationPathFromRelativeSpecifier(
    declarationPath: string,
    specifier: string,
): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const resolved = resolve(dirname(declarationPath), specifier);
    if (resolved.endsWith('.js')) return `${resolved.slice(0, -'.js'.length)}.d.ts`;
    if (resolved.endsWith('.mjs')) return `${resolved.slice(0, -'.mjs'.length)}.d.ts`;
    if (resolved.endsWith('.cjs')) return `${resolved.slice(0, -'.cjs'.length)}.d.ts`;
    if (resolved.endsWith('.d.ts')) return resolved;
    return `${resolved}.d.ts`;
}

function namedPropertySignature(
    members: readonly ts.TypeElement[],
    sourceFile: ts.SourceFile,
    name: string,
): ts.PropertySignature | undefined {
    return members.find((member): member is ts.PropertySignature => (
        ts.isPropertySignature(member)
        && member.name.getText(sourceFile) === name
    ));
}

async function readProtocolAuthoringDeclarationClosure(
    entrypoint = compiledProtocolAuthoringDeclarationEntrypoint,
): Promise<ReadonlyMap<string, string>> {
    const pending = [entrypoint];
    const declarations = new Map<string, string>();

    while (pending.length > 0) {
        const declarationPath = pending.pop();
        if (declarationPath === undefined || declarations.has(declarationPath)) continue;

        const declaration = await readFile(declarationPath, 'utf8');
        declarations.set(declarationPath, declaration);
        for (const match of declaration.matchAll(/(?:from|import)\s*[(']\s*([^'"()]+)\s*['")]/gu)) {
            const relativeDeclarationPath = declarationPathFromRelativeSpecifier(
                declarationPath,
                match[1] ?? '',
            );
            if (relativeDeclarationPath !== undefined && !declarations.has(relativeDeclarationPath)) {
                pending.push(relativeDeclarationPath);
            }
        }
    }

    return declarations;
}

const validatorSpecificDeclarationReferences = [
    /\bfrom\s+['"]zod(?:\/[^'"]*)?['"]/u,
    /\bzod\b/iu,
    /\bz\.[A-Za-z_$][A-Za-z0-9_$]*/u,
    /\bZod[A-Za-z0-9_$]*/u,
    /\bZodLikeSchema\b/u,
] as const;

const internalProtocolAuthoringDeclarationReferences = [
    ...validatorSpecificDeclarationReferences,
    /\bProtocolAuthoringCompositionInternals\b/u,
    /\b_zod\b/u,
    /['"]\.\.\/protocolSchema\.js['"]/u,
] as const;

function validatorTypeReferences(path: string, text: string): readonly string[] {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && /^(?:Zod[A-Za-z0-9_$]*|_zod)$/u.test(node.text)) found.add(node.text);
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            && /^zod(?:\/|$)/u.test(node.moduleSpecifier.text)) found.add(node.moduleSpecifier.text);
        if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && node.left.text === 'z') found.add(node.getText(source));
        ts.forEachChild(node, visit);
    };
    visit(source);
    return [...found].map((name) => path + ': ' + name);
}

describe('public protocol-authoring declaration neutrality', () => {
    it('distinguishes schema types from permitted diagnostic error-class strings', () => {
        expect(validatorTypeReferences('example.d.ts', "export type Name = 'ZodError' | '$ZodError';")).toEqual([]);
        expect(validatorTypeReferences('example.d.ts', "import type { ZodType } from 'zod'; export type Schema = ZodType;")).not.toEqual([]);
        expect(validatorTypeReferences('example.d.ts', 'export type Schema = z.ZodString;')).not.toEqual([]);
    });
    it('preserves concrete schema input and output types for external declaration consumers', async () => {
        await compileExternalProtocolAuthoringConsumer(`
            import {
                defineProtocolArray,
                defineProtocolObject,
                defineProtocolString,
                type ProtocolSchemaInput,
                type ProtocolSchemaOutput,
            } from './protocol/index.js';

            const item = defineProtocolObject({
                id: defineProtocolString(),
                optionalLabel: defineProtocolString().optional(),
            }, { policy: 'closed' });
            const items = defineProtocolArray(item);

            type ItemInput = ProtocolSchemaInput<typeof item>;
            type ItemOutput = ProtocolSchemaOutput<typeof item>;
            const input: ItemInput = { id: 'one' };
            const output: ItemOutput = item.parse(input);
            const parsedItems: readonly ItemOutput[] = items.parse([input]);

            const id: string = output.id;
            const optionalLabel: string | undefined = output.optionalLabel;
            const firstId: string = parsedItems[0]!.id;
            void id;
            void optionalLabel;
            void firstId;
        `, 'concrete');
        // Whole TypeScript-program work: measured 8.5 s / 15.9 s alone and
        // timing out against 30 s inside `vitest run` for the package. Aligned
        // with the package's other whole-program suites rather than a number
        // that only holds on an idle host.
    }, 120_000);

    it('keeps composed array, unique-array, and union input distinct from parsed output', async () => {
        // A schema whose authored input and parsed output genuinely differ is
        // the only shape that can tell the canonical two-parameter signature
        // apart from one that reuses the output projection for both sides.
        await compileExternalProtocolAuthoringConsumer(`
            import {
                defineProtocolArray,
                defineProtocolLiteral,
                defineProtocolUnion,
                defineProtocolUniqueArray,
                type ProtocolComposableSchema,
                type ProtocolSchemaInput,
                type ProtocolSchemaOutput,
            } from './protocol/index.js';

            declare const decimalText: ProtocolComposableSchema<string, number>;

            const decimals = defineProtocolArray(decimalText);
            const uniqueDecimals = defineProtocolUniqueArray(decimalText);
            const decimalOrNone = defineProtocolUnion([decimalText, defineProtocolLiteral('none')]);

            const authored: ProtocolSchemaInput<typeof decimals> = ['1', '2'];
            const parsed: ProtocolSchemaOutput<typeof decimals> = decimals.parse(authored);
            const authoredUnique: ProtocolSchemaInput<typeof uniqueDecimals> = ['1', '2'];
            const parsedUnique: ProtocolSchemaOutput<typeof uniqueDecimals> = uniqueDecimals.parse(authoredUnique);
            const authoredUnion: ProtocolSchemaInput<typeof decimalOrNone> = '1';
            const parsedUnion: ProtocolSchemaOutput<typeof decimalOrNone> = decimalOrNone.parse(authoredUnion);

            const total: number = parsed[0]! + parsedUnique[0]!;
            const settled: number | 'none' = parsedUnion;
            void total;
            void settled;
        `, 'distinct-input-output');
        // Whole TypeScript-program work; see the sibling consumer test above
        // for the measured timings this budget is aligned with.
    }, 120_000);

    it('keeps the source declaration entrypoint validator-neutral without losing algebra inference', async () => {
        const utf8Text = defineProtocolUtf8String({ maxUtf8Bytes: 1_024, minLength: 1 });
        const tags = defineProtocolUniqueArray(utf8Text, { minItems: 1, maxItems: 2 });
        const schema = defineProtocolObject({
            description: utf8Text,
            optionalDescription: utf8Text.optional(),
            tags: defineProtocolUniqueArray(utf8Text, { minItems: 1, maxItems: 2 }),
        }, { policy: 'closed' });

        expectTypeOf<ReturnType<typeof tags.parse>>().toEqualTypeOf<readonly string[]>();
        type ParsedSchema = ReturnType<typeof schema.parse>;
        expectTypeOf<keyof ParsedSchema>().toEqualTypeOf<'description' | 'optionalDescription' | 'tags'>();
        expectTypeOf<ParsedSchema['description']>().toEqualTypeOf<string>();
        expectTypeOf<ParsedSchema['optionalDescription']>().toEqualTypeOf<string | undefined>();
        expectTypeOf<ParsedSchema['tags']>().toEqualTypeOf<readonly string[]>();
        expectTypeOf<ParsedSchema>().toMatchTypeOf<ProtocolJsonValue>();
        expectTypeOf<ReturnType<typeof defineProtocolJsonValue>>()
            .toEqualTypeOf<ProtocolComposableSchema<ProtocolJsonValue, ProtocolJsonValue>>();
        expectTypeOf<
            ReturnType<typeof defineProtocolJsonValue> extends { readonly _zod: unknown }
                ? true
                : false
        >().toEqualTypeOf<false>();

        expect(await emittedSourceAuthoringDeclaration('protocol/index.public.d.ts')).toMatch(
            /export\s+type\s*\{[\s\S]*?\bProtocolComposableSchema\b[\s\S]*?\}\s*from\s*['"]\.\/protocolFacade\.js['"]/u,
        );
        // Whole TypeScript-program work: measured 8.5 s / 15.9 s alone and
        // timing out against 30 s inside `vitest run` for the package. Aligned
        // with the package's other whole-program suites rather than a number
        // that only holds on an idle host.
    }, 120_000);

    it('keeps the public facade validator-neutral while retaining canonical declaration identities', async () => {
        const declaration = await emittedSourceAuthoringDeclaration('protocol/protocolFacade.d.ts');
        const entrypointDeclaration = await emittedSourceAuthoringDeclaration('protocol/index.public.d.ts');
        const composerReferenceResolutionDeclaration = await emittedSourceAuthoringDeclaration(
            'protocol/composerReferenceResolution.d.ts',
        );
        const targetedDeclaration = await emittedSourceAuthoringDeclaration('targetedContributionAuthoring.d.ts');

        expectTypeOf<ProtocolComposableSchema<{ readonly title: string }>['jsonSchema']>()
            .toMatchTypeOf<Readonly<{ type?: string }>>();
        expect(declaration).not.toContain(`type ${'Defined'}${'Schema'}<`);
        expect(declaration).toContain('type ProtocolObjectPreservedProjection<');
        expect(declaration).toContain(
            'ProtocolObjectAdditionalValue<TOptions, TProjection> | ProtocolObjectKnownValue<TShape, TProjection>',
        );
        expect(declaration).not.toContain('type Simplify<');
        expect(declaration).toMatch(
            /defineProtocolUniqueArray:\s*<[\s\S]*?options\?: ProtocolUniqueJsonArrayOptions/u,
        );
        expect(declaration).toMatch(
            /defineProtocolUtf8String:\s*\(options: ProtocolUtf8StringOptions\)/u,
        );
        expect(declaration).not.toContain('ProtocolUniqueArrayBounds');
        expect(entrypointDeclaration).toContain("from './protocolFacade.js';");
        expect(entrypointDeclaration).not.toContain("from '../protocolSchema.js';");
        expect(composerReferenceResolutionDeclaration).toContain(
            "from '@happier-dev/protocol/plugins/contributions/composer-reference-providers';",
        );
        expect(composerReferenceResolutionDeclaration).not.toContain(
            "from '@happier-dev/protocol';",
        );
        expect(targetedDeclaration).toContain("from './protocol/protocolFacade.js';");
        expect(targetedDeclaration).toContain('ProtocolJsonValue as JsonValue');
        expect(targetedDeclaration).toContain('ProtocolComposableSchema');
        expect(targetedDeclaration).not.toContain('PublicProtocolSchema');
        expect(targetedDeclaration).not.toContain("from './identity.js';");
        expect(targetedDeclaration).not.toContain("from './protocolSchema.js';");
        const leakedReferences = internalProtocolAuthoringDeclarationReferences
            .filter((reference) => reference.test(declaration))
            .map((reference) => reference.toString());

        expect(leakedReferences).toEqual([]);
        // This test can be the first declaration consumer in a focused run;
        // reuse the neighboring consumers' whole-program compiler budget.
    }, 120_000);

    it('directly re-exports the Connected Account identity schema from the narrow Protocol owner', async () => {
        const declaration = await emittedSourceAuthoringDeclaration('connectedAccounts.d.ts');

        const source = ts.createSourceFile('connectedAccounts.d.ts', declaration, ts.ScriptTarget.Latest, true);
        const exported = source.statements.flatMap((statement) => (
            ts.isExportDeclaration(statement) && statement.moduleSpecifier
            && ts.isStringLiteral(statement.moduleSpecifier)
            && statement.moduleSpecifier.text === '@happier-dev/protocol/connect/qualified-connected-account-persistence'
            && statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((element) => element.name.text) : []
        ));
        expect(exported).toEqual(expect.arrayContaining(['QualifiedConnectedAccountRefJsonSchema', 'QualifiedConnectedAccountRefSchema']));
        expect(declaration).not.toContain('ProtocolComposableSchema<QualifiedConnectedAccountRef>');
    });

    it('keeps the compiled declaration closure free of validator text as well as validator types', async () => {
        const closure = await readProtocolAuthoringDeclarationClosure(
            compiledProtocolAuthoringDeclarationEntrypoint,
        );
        const leakedReferences = [...closure.entries()]
            .flatMap(([declarationPath, declaration]) => validatorTypeReferences(declarationPath, declaration));

        expect(leakedReferences).toEqual([]);
        for (const [declarationPath, declaration] of closure.entries()) {
            expect(declaration).not.toContain(`type ${'Defined'}${'Schema'}<`);
            expect(declaration).not.toContain('ProtocolAuthoringSchema');
            expect(declaration).not.toContain('PublicProtocolSchema');
            expect(declaration).not.toContain('defineProtocolSchema');
            expect(declaration).not.toContain('definedSchemaInput');
            expect(declaration).not.toContain('definedSchemaOutput');
        }
    });

    it('keeps compiled Connected Account identity schemas on the narrow Protocol owner', async () => {
        const declaration = await readFile(compiledConnectedAccountsDeclaration, 'utf8');

        const source = ts.createSourceFile('connectedAccounts.d.ts', declaration, ts.ScriptTarget.Latest, true);
        const exported = source.statements.flatMap((statement) => (
            ts.isExportDeclaration(statement) && statement.moduleSpecifier
            && ts.isStringLiteral(statement.moduleSpecifier)
            && statement.moduleSpecifier.text === '@happier-dev/protocol/connect/qualified-connected-account-persistence'
            && statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((element) => element.name.text) : []
        ));
        expect(exported).toEqual(expect.arrayContaining(['QualifiedConnectedAccountRefJsonSchema', 'QualifiedConnectedAccountRefSchema']));
        expect(declaration).not.toContain(
            "import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';",
        );
        expect(declaration).not.toContain('ProtocolComposableSchema<QualifiedConnectedAccountRef>');
    });

    it('keeps compiled ContributionProtocol declarations identity-parameterized', async () => {
        const declaration = await readFile(compiledTargetedContributionAuthoringDeclaration, 'utf8');
        const sourceFile = ts.createSourceFile(
            compiledTargetedContributionAuthoringDeclaration,
            declaration,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const contributionProtocol = sourceFile.statements.find((statement): statement is ts.InterfaceDeclaration => (
            ts.isInterfaceDeclaration(statement)
            && statement.name.text === 'ContributionProtocol'
        ));

        expect(contributionProtocol?.typeParameters?.map((parameter) => parameter.name.text)).toEqual([
            'TOperations',
            'TSurfaces',
            'TDescriptorSchema',
            'TProtocolId',
            'TProtocolVersion',
        ]);
        const members = contributionProtocol?.members ?? [];
        expect(namedPropertySignature(members, sourceFile, 'id')?.type?.getText(sourceFile))
            .toBe('TProtocolId');
        expect(namedPropertySignature(members, sourceFile, 'version')?.type?.getText(sourceFile))
            .toBe('TProtocolVersion');
    });
});
