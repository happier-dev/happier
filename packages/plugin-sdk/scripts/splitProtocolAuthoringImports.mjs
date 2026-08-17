#!/usr/bin/env node

/**
 * Split the unreleased protocol-authoring import surface into the two r0.47
 * author entrypoints. The default mode is a read-only dry run; --write is the
 * only mode that changes source files. Unknown/ambiguous imports are fatal so
 * this cannot silently create a third owner.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';

const repoRoot = resolve(import.meta.dirname, '../../..');
const oldSpecifier = '@happier-dev/plugin-sdk/protocol-authoring';
const protocolSymbols = new Set([
    'PluginJsonSchema',
    'ProtocolArrayOptions',
    'ProtocolComposableSchema',
    'ProtocolJsonValue',
    'ProtocolJsonValueOptions',
    'ProtocolNumberOptions',
    'ProtocolObjectEvolutionPolicy',
    'ProtocolObjectOptions',
    'ProtocolSchemaOutput',
    'ProtocolSchemaSafeParseResult',
    'ProtocolStringOptions',
    'ProtocolUniqueJsonArrayOptions',
    'ProtocolUtf8StringOptions',
    'ProtocolValidationError',
    'ProtocolValidationIssue',
    'defineProtocolArray',
    'defineProtocolJsonValue',
    'defineProtocolLiteral',
    'defineProtocolNumber',
    'defineProtocolObject',
    'defineProtocolString',
    'defineProtocolUnion',
    'defineProtocolUniqueArray',
    'defineProtocolUtf8String',
    'pluginJsonValuesEqual',
    'readProtocolComposableSchema',
]);
const contributionSymbols = new Set([
    'ContributionActionDangerLevel',
    'ContributionActionSurface',
    'ContributionAuthorDefinition',
    'ContributionAuthorTargets',
    'ContributionContributeInput',
    'ContributionOperationBindings',
    'ContributionOperationDefinition',
    'ContributionOperationRole',
    'ContributionPointAuthorDefinition',
    'ContributionPointOptions',
    'ContributionProtocol',
    'ContributionProtocolDefinition',
    'ContributionProtocolManifest',
    'ContributionSurfaceBinding',
    'ContributionSurfaceBindings',
    'ContributionSurfaceDefinition',
    'ContributionSurfaceFallback',
    'ContributionSurfaceHandle',
    'ContributionSurfaceIcon',
    'ContributionSurfaceLocalizedString',
    'ContributionSurfaceNode',
    'ContributionSurfaceNodeInput',
    'ContributionSurfacePresentation',
    'ContributionSurfaceRole',
    'DefinedContributionPointProtocolMap',
    'DescriptorFields',
    'IsRequiredSurfaceDefinition',
    'PluginTargetedContributionSelectionV1',
    'PluginTargetedContributionSelectionV1Schema',
    'PublicContributionProtocol',
    'PublicContributionProtocols',
    'RequiredSurfaceRoles',
    'SchemaInput',
    'SchemaOutput',
    'SurfaceFields',
    'defineContributionPoint',
    'defineContributionProtocol',
]);
const stopListPatterns = [
    /(^|\/)node_modules\//u,
    /(^|\/)dist\//u,
    /(^|\/)\.git\//u,
    /(?:^|\/)packages\/plugin-sdk\/(?:API\.md|api-surface\.json|capability-matrix\.json)$/u,
    /\.d\.ts$/u,
    /\.map$/u,
    /(?:^|\/)\.project\/plans\//u,
    /(?:^|\/)scripts\/splitProtocolAuthoringImports\.mjs$/u,
];

function isStopped(file) {
    return stopListPatterns.some((pattern) => pattern.test(file));
}

function sourceFiles() {
    if (!existsSync(resolve(repoRoot, 'packages/plugin-sdk/package.json'))
        || !existsSync(resolve(repoRoot, 'apps'))) {
        throw new Error(`unexpected repository root for codemod: ${repoRoot}`);
    }
    const files = execFileSync('rg', [
        '-l',
        '--hidden',
        '--glob', '!.git/**',
        '--glob', '!node_modules/**',
        '--glob', '!dist/**',
        '--glob', '!**/*.d.ts',
        'protocol-authoring',
        repoRoot,
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split('\n')
        .map((file) => file.trim())
        .filter(Boolean)
        .map((file) => relative(repoRoot, file));
    return files.filter((file) => !isStopped(file));
}

function sourceImportName(element) {
    return element.propertyName?.text ?? element.name.text;
}

function classify(name) {
    const protocol = protocolSymbols.has(name);
    const contribution = contributionSymbols.has(name);
    if (protocol === contribution) return undefined;
    return protocol ? 'protocol' : 'contributions';
}

function replacementSpecifier(file, originalSpecifier, kind) {
    if (originalSpecifier === oldSpecifier) {
        return `${oldSpecifier.slice(0, oldSpecifier.lastIndexOf('/') + 1)}${kind}`;
    }
    const suffix = originalSpecifier
        .replace(/protocol-authoring(?=\/|$)/u, kind);
    if (suffix === originalSpecifier) return undefined;
    return suffix;
}

function isCommented(text) {
    return text.includes('//') || text.includes('/*') || text.includes('*/');
}

function renderNamedImport(sourceFile, declaration, elements, originalSpecifier, moduleSpecifier) {
    const clause = declaration.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        throw new Error('Only named imports can be split');
    }
    const namedBindings = clause.namedBindings;
    const first = namedBindings.elements[0];
    const last = namedBindings.elements[namedBindings.elements.length - 1];
    const namedStart = namedBindings.getStart(sourceFile);
    const namedEnd = namedBindings.end;
    const openBrace = sourceFile.text.indexOf('{', namedStart);
    const closeBrace = sourceFile.text.lastIndexOf('}', namedEnd - 1);
    if (openBrace < 0 || closeBrace < 0 || first === undefined || last === undefined) {
        throw new Error('Unable to locate named import braces');
    }
    const declarationText = declaration.getText(sourceFile);
    const multiline = declarationText.includes('\n');
    const prefix = sourceFile.text.slice(declaration.getStart(sourceFile), openBrace + 1);
    const firstLeading = sourceFile.text.slice(openBrace + 1, first.getStart(sourceFile));
    const closeLeading = sourceFile.text.slice(last.end, closeBrace);
    if (isCommented(firstLeading) || isCommented(closeLeading)) {
        throw new Error('Mixed protocol-authoring import has comments at the split boundary');
    }
    const indentation = multiline
        ? sourceFile.text.slice(
            sourceFile.text.lastIndexOf('\n', first.getStart(sourceFile) - 1) + 1,
            first.getStart(sourceFile),
        ).match(/^\s*/u)?.[0] ?? '    '
        : '';
    const closingIndentation = multiline
        ? sourceFile.text.slice(
            sourceFile.text.lastIndexOf('\n', closeBrace - 1) + 1,
            closeBrace,
        ).match(/^\s*/u)?.[0] ?? ''
        : '';
    const sourceTail = sourceFile.text.slice(closeBrace + 1, declaration.end);
    const modulePattern = new RegExp(`(['"])${originalSpecifier.replaceAll('/', '\\/')}`, 'u');
    const renderGroup = (group) => {
        const renderedElements = group.map((element) => element.getText(sourceFile));
        const body = multiline
            ? `\n${indentation}${renderedElements.join(`,\n${indentation}`)},\n${closingIndentation}}`
            : ` ${renderedElements.join(', ')} }`;
        const tail = sourceTail.replace(modulePattern, `$1${moduleSpecifier}`);
        return `${prefix}${body}${tail}`;
    };
    return renderGroup(elements);
}

function importReplacement(file, source, declaration) {
    const moduleSpecifier = declaration.moduleSpecifier.text;
    const clause = declaration.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        throw new Error('Unknown default/namespace/side-effect import form');
    }
    const groups = new Map();
    for (const element of clause.namedBindings.elements) {
        const kind = classify(sourceImportName(element));
        if (!kind) throw new Error(`Unknown or ambiguous symbol ${sourceImportName(element)}`);
        const existing = groups.get(kind) ?? [];
        existing.push(element);
        groups.set(kind, existing);
    }
    const rendered = [...groups.entries()].map(([kind, elements]) => {
        const target = replacementSpecifier(file, moduleSpecifier, kind);
        if (!target) throw new Error(`Cannot rewrite ${moduleSpecifier}`);
        return renderNamedImport(sourceFileFor(file, source), declaration, elements, moduleSpecifier, target);
    });
    return rendered.join(source.includes('\r\n') ? '\r\n' : '\n');
}

function sourceFileFor(file, source) {
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collectReplacements(file, source) {
    const sourceFile = sourceFileFor(file, source);
    const replacements = [];
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || !statement.moduleSpecifier.text.includes('protocol-authoring')) continue;
        const moduleSpecifier = statement.moduleSpecifier.text;
        if (moduleSpecifier !== oldSpecifier && !moduleSpecifier.includes('protocol-authoring')) {
            continue;
        }
        const replacement = importReplacement(file, source, statement);
        replacements.push({ start: statement.getStart(sourceFile), end: statement.end, replacement });
    }
    return replacements;
}

async function main() {
    const write = process.argv.includes('--write');
    const files = sourceFiles();
    const changed = [];
    const refused = [];
    let importCount = 0;
    for (const file of files) {
        const absolute = resolve(repoRoot, file);
        const source = await readFile(absolute, 'utf8');
        if (!source.includes('protocol-authoring')) continue;
        try {
            const replacements = collectReplacements(file, source);
            if (replacements.length === 0) continue;
            importCount += replacements.length;
            let next = source;
            for (const replacement of replacements.toReversed()) {
                next = `${next.slice(0, replacement.start)}${replacement.replacement}${next.slice(replacement.end)}`;
            }
            if (next !== source) {
                changed.push({ file, imports: replacements.length });
                if (write) await writeFile(absolute, next);
            }
        } catch (error) {
            refused.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const census = execFileSync('rg', [
        '-l',
        '--hidden',
        '--glob', '!.git/**',
        '--glob', '!node_modules/**',
        '--glob', '!dist/**',
        '--glob', '!packages/plugin-sdk/API.md',
        '--glob', '!packages/plugin-sdk/api-surface.json',
        '--glob', '!packages/plugin-sdk/capability-matrix.json',
        '--glob', '!**/*.d.ts',
        '--glob', '!.project/plans/**',
        'protocol-authoring',
        repoRoot,
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n').map((file) => file.trim()).filter(Boolean)
        .map((file) => relative(repoRoot, file))
        .filter((file) => !isStopped(file));
    console.log(`${write ? 'run' : 'dry-run'}: ${changed.length} files, ${importCount} import declarations`);
    for (const item of changed) console.log(`  ${write ? 'updated' : 'would update'} ${item.file} (${item.imports})`);
    if (refused.length > 0) {
        console.error('refused imports:');
        for (const item of refused) console.error(`  ${item}`);
        process.exitCode = 2;
    }
    console.log(`stop-list census: ${census.length} non-generated files still mention protocol-authoring`);
    for (const file of census) console.log(`  residue ${file}`);
}

await main();
