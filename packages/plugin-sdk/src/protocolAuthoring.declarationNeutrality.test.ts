import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import {
    defineProtocolJsonValue,
    defineProtocolObject,
    defineProtocolUtf8String,
    defineProtocolUniqueArray,
    type ProtocolComposableSchema,
    type ProtocolJsonValue,
} from './protocol/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceAuthoringDeclarationConfig = fileURLToPath(
    new URL('../tsconfig.json', import.meta.url),
);
const sourceAuthoringDeclarationOutputDirectory = resolve(
    packageRoot,
    '.facade-current-declarations',
);
const compiledProtocolAuthoringDeclarationEntrypoint = fileURLToPath(
    new URL('../dist/protocol/index.d.ts', import.meta.url),
);
const compiledTargetedContributionAuthoringDeclaration = fileURLToPath(
    new URL('../dist/targetedContributionAuthoring.d.ts', import.meta.url),
);
const compiledConnectedAccountsDeclaration = fileURLToPath(
    new URL('../dist/connectedAccounts.d.ts', import.meta.url),
);
const sourceAuthoringDeclarationSources = [
    fileURLToPath(new URL('./protocol/protocolFacade.ts', import.meta.url)),
    fileURLToPath(new URL('./protocol/composerRef.ts', import.meta.url)),
    fileURLToPath(new URL('./protocol/collectionCursor.ts', import.meta.url)),
    fileURLToPath(new URL('./protocol/index.ts', import.meta.url)),
    fileURLToPath(new URL('./targetedContributionAuthoring.ts', import.meta.url)),
    fileURLToPath(new URL('./connectedAccounts.ts', import.meta.url)),
] as const;

let sourceAuthoringDeclarations: ReadonlyMap<string, string> | undefined;

function emitSourceAuthoringDeclarations(): ReadonlyMap<string, string> {
    if (sourceAuthoringDeclarations !== undefined) return sourceAuthoringDeclarations;

    const parsed = ts.getParsedCommandLineOfConfigFile(
        sourceAuthoringDeclarationConfig,
        {},
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: () => undefined,
        },
    );
    if (parsed === undefined) {
        throw new Error(`Unable to parse ${sourceAuthoringDeclarationConfig}`);
    }
    const program = ts.createProgram({
        rootNames: [...sourceAuthoringDeclarationSources],
        options: {
            ...parsed.options,
            declaration: true,
            declarationMap: false,
            emitDeclarationOnly: true,
            incremental: false,
            noEmit: false,
            outDir: sourceAuthoringDeclarationOutputDirectory,
        },
        projectReferences: parsed.projectReferences,
    });
    const declarations = new Map<string, string>();
    const diagnostics: ts.Diagnostic[] = [];
    for (const sourcePath of sourceAuthoringDeclarationSources) {
        const sourceFile = program.getSourceFile(sourcePath);
        if (sourceFile === undefined) throw new Error(`Missing declaration source ${sourcePath}`);

        diagnostics.push(...program.getDeclarationDiagnostics(sourceFile));
        const emitted = program.emit(sourceFile, (fileName, contents) => {
            if (fileName.endsWith('.d.ts')) declarations.set(resolve(fileName), contents);
        }, undefined, true);
        diagnostics.push(...emitted.diagnostics);
    }
    const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
        throw new Error(errors.map((diagnostic) => (
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        )).join('\n'));
    }
    sourceAuthoringDeclarations = declarations;
    return declarations;
}

function emittedSourceAuthoringDeclaration(relativePath: string): string {
    const declaration = emitSourceAuthoringDeclarations().get(
        resolve(sourceAuthoringDeclarationOutputDirectory, relativePath),
    );
    if (declaration === undefined) {
        throw new Error(`Missing emitted source declaration ${relativePath}`);
    }
    return declaration;
}

function compileExternalProtocolAuthoringConsumer(sourceText: string): readonly ts.Diagnostic[] {
    const declarations = emitSourceAuthoringDeclarations();
    const consumerPath = resolve(
        sourceAuthoringDeclarationOutputDirectory,
        'external-protocol-authoring-consumer.ts',
    );
    const compilerOptions: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ['lib.es2022.d.ts'],
        types: [],
    };
    const host = ts.createCompilerHost(compilerOptions);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const directoryExists = host.directoryExists?.bind(host) ?? (() => false);
    const virtualDirectories = new Set<string>();
    for (const declarationPath of declarations.keys()) {
        let directory = dirname(declarationPath);
        while (directory.startsWith(sourceAuthoringDeclarationOutputDirectory)) {
            virtualDirectories.add(directory);
            const parent = dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    }
    host.fileExists = (fileName) => (
        resolve(fileName) === consumerPath
        || declarations.has(resolve(fileName))
        || fileExists(fileName)
    );
    host.directoryExists = (directoryName) => (
        virtualDirectories.has(resolve(directoryName))
        || directoryExists(directoryName)
    );
    host.readFile = (fileName) => {
        const resolvedFileName = resolve(fileName);
        if (resolvedFileName === consumerPath) return sourceText;
        return declarations.get(resolvedFileName) ?? readFile(fileName);
    };
    host.getSourceFile = (fileName, languageVersionOrOptions) => {
        const contents = host.readFile(fileName);
        return contents === undefined
            ? undefined
            : ts.createSourceFile(
                fileName,
                contents,
                languageVersionOrOptions,
                true,
                fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.Unknown,
            );
    };

    const program = ts.createProgram({
        rootNames: [consumerPath],
        options: compilerOptions,
        host,
    });
    return ts.getPreEmitDiagnostics(program);
}

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

describe('public protocol-authoring declaration neutrality', () => {
    it('preserves concrete schema input and output types for external declaration consumers', () => {
        const diagnostics = compileExternalProtocolAuthoringConsumer(`
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
        `);

        expect(diagnostics.map((diagnostic) => (
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        ))).toEqual([]);
        // Whole TypeScript-program work: measured 8.5 s / 15.9 s alone and
        // timing out against 30 s inside `vitest run` for the package. Aligned
        // with the package's other whole-program suites rather than a number
        // that only holds on an idle host.
    }, 120_000);

    it('keeps composed array, unique-array, and union input distinct from parsed output', () => {
        // A schema whose authored input and parsed output genuinely differ is
        // the only shape that can tell the canonical two-parameter signature
        // apart from one that reuses the output projection for both sides.
        const diagnostics = compileExternalProtocolAuthoringConsumer(`
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
        `);

        expect(diagnostics.map((diagnostic) => (
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        ))).toEqual([]);
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

        expect(emittedSourceAuthoringDeclaration('protocol/index.d.ts')).toMatch(
            /export\s+type\s*\{[\s\S]*?\bProtocolComposableSchema\b[\s\S]*?\}\s*from\s*['"]\.\/protocolFacade\.js['"]/u,
        );
        // Whole TypeScript-program work: measured 8.5 s / 15.9 s alone and
        // timing out against 30 s inside `vitest run` for the package. Aligned
        // with the package's other whole-program suites rather than a number
        // that only holds on an idle host.
    }, 120_000);

    it('keeps the public facade declaration closure structural and isolated from source composition internals', async () => {
        const declaration = emittedSourceAuthoringDeclaration('protocol/protocolFacade.d.ts');
        const entrypointDeclaration = emittedSourceAuthoringDeclaration('protocol/index.d.ts');
        const targetedDeclaration = emittedSourceAuthoringDeclaration('targetedContributionAuthoring.d.ts');

        expectTypeOf<ProtocolComposableSchema<{ readonly title: string }>['jsonSchema']>()
            .toMatchTypeOf<Readonly<{ type?: string }>>();
        expect(declaration).not.toContain(`type ${'Defined'}${'Schema'}<`);
        expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
        expect(declaration).toContain('readonly jsonSchema: PluginJsonSchema;');
        expect(declaration).toContain('export interface ProtocolComposableSchema<');
        expect(declaration).toContain('type ProtocolSchemaInput<');
        expect(declaration).toContain(
            "TProjection extends 'input' ? ProtocolSchemaInput<TShape[TKey]> : ProtocolSchemaOutput<TShape[TKey]>",
        );
        expect(declaration).toContain('type ProtocolObjectPreservedProjection<');
        expect(declaration).toContain(
            'ProtocolObjectAdditionalValue<TOptions, TProjection> | ProtocolObjectKnownValue<TShape, TProjection>',
        );
        expect(declaration).not.toContain('type Simplify<');
        expect(declaration).toContain('export type ProtocolUtf8StringOptions = Readonly<{');
        expect(declaration).toContain('export type ProtocolJsonValueOptions = Readonly<{');
        expect(declaration).toContain(
            'export type ProtocolUniqueJsonArrayOptions = ProtocolArrayOptions;',
        );
        expect(declaration).toMatch(
            /defineProtocolUniqueArray:\s*<[\s\S]*?options\?: ProtocolUniqueJsonArrayOptions/u,
        );
        expect(declaration).toMatch(
            /defineProtocolUtf8String:\s*\(options: ProtocolUtf8StringOptions\)/u,
        );
        expect(declaration).not.toContain('ProtocolUniqueArrayBounds');
        expect(entrypointDeclaration).toContain("from './protocolFacade.js';");
        expect(entrypointDeclaration).not.toContain("from '../protocolSchema.js';");
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
    });

    it('directly re-exports the Connected Account identity schema from the narrow Protocol owner', () => {
        const declaration = emittedSourceAuthoringDeclaration('connectedAccounts.d.ts');

        expect(declaration).toContain(
            "export { QualifiedConnectedAccountRefJsonSchema, QualifiedConnectedAccountRefSchema, } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';",
        );
        expect(declaration).not.toContain('ProtocolComposableSchema<QualifiedConnectedAccountRef>');
    });

    it('keeps the compiled declaration closure free of validator text as well as validator types', async () => {
        const closure = await readProtocolAuthoringDeclarationClosure(
            compiledProtocolAuthoringDeclarationEntrypoint,
        );
        const leakedReferences = [...closure.entries()]
            .flatMap(([declarationPath, declaration]) => validatorSpecificDeclarationReferences
                .filter((reference) => reference.test(declaration))
                .map((reference) => `${declarationPath}: ${reference}`));

        expect(leakedReferences).toEqual([]);
        for (const declaration of closure.values()) {
            expect(declaration).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
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

        expect(declaration).toContain(
            "export { QualifiedConnectedAccountRefJsonSchema, QualifiedConnectedAccountRefSchema, } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';",
        );
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
