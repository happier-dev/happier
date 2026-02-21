import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../../../..');
const sourcesRoot = path.join(repoRoot, 'apps/ui/sources');

const APP_TEXT_MODULE = '@/components/ui/text/Text';
const LEGACY_TEXT_MODULE = '@/components/ui/text/StyledText';

function isTsLike(filePath: string): boolean {
    return /\.(ts|tsx|mts|cts|js|jsx)$/.test(filePath);
}

function shouldSkipFile(filePath: string): boolean {
    const rel = toPosix(path.relative(repoRoot, filePath));
    if (!rel.startsWith('apps/ui/sources/')) return true;
    if (rel.includes('/node_modules/')) return true;
    if (/\.(spec|test)\.[tj]sx?$/.test(rel)) return true;
    if (rel.includes('/__tests__/')) return true;
    if (rel.includes('/sources/dev/')) return true;
    if (rel.includes('/sources/app/(app)/dev/')) return true;
    if (rel === 'apps/ui/sources/components/ui/text/Text.tsx') return true;
    return false;
}

function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

function walk(dir: string, out: string[]): void {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        if (ent.name === 'node_modules') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            walk(full, out);
            continue;
        }
        if (isTsLike(full)) out.push(full);
    }
}

type Replacement = { start: number; end: number; value: string };

function replaceWithRanges(text: string, ranges: Replacement[]): string {
    if (ranges.length === 0) return text;
    ranges.sort((a, b) => b.start - a.start);
    let next = text;
    for (const r of ranges) {
        next = `${next.slice(0, r.start)}${r.value}${next.slice(r.end)}`;
    }
    return next;
}

type NamedImport = Readonly<{ name: string; alias?: string | null }>;

function printNamedImports(names: ReadonlyArray<NamedImport>): string {
    if (names.length === 0) return '';
    const entries = names.map((n) => (n.alias ? `${n.name} as ${n.alias}` : n.name));
    return `{ ${entries.join(', ')} }`;
}

function collectNamedImports(node: ts.ImportDeclaration): { defaultName: string | null; namespaceName: string | null; named: NamedImport[]; isTypeOnly: boolean } {
    const clause = node.importClause;
    if (!clause) return { defaultName: null, namespaceName: null, named: [], isTypeOnly: false };

    const defaultName = clause.name ? clause.name.text : null;
    const isTypeOnly = Boolean(clause.isTypeOnly);

    const bindings = clause.namedBindings;
    if (!bindings) return { defaultName, namespaceName: null, named: [], isTypeOnly };

    if (ts.isNamespaceImport(bindings)) {
        return { defaultName, namespaceName: bindings.name.text, named: [], isTypeOnly };
    }

    const named = bindings.elements.map((el) => ({
        name: el.propertyName ? el.propertyName.text : el.name.text,
        alias: el.propertyName ? el.name.text : null,
    }));

    return { defaultName, namespaceName: null, named, isTypeOnly };
}

function buildImportLine(args: { defaultName: string | null; namespaceName: string | null; named: NamedImport[]; module: string; isTypeOnly: boolean }): string | null {
    const parts: string[] = [];
    if (args.defaultName) parts.push(args.defaultName);
    if (args.namespaceName) parts.push(`* as ${args.namespaceName}`);
    if (args.named.length > 0) parts.push(printNamedImports(args.named));

    if (parts.length === 0) return null;
    const typePrefix = args.isTypeOnly ? 'import type ' : 'import ';
    return `${typePrefix}${parts.join(', ')} from '${args.module}';`;
}

function uniqNamedImports(named: NamedImport[]): NamedImport[] {
    const seen = new Map<string, NamedImport>();
    for (const n of named) {
        const key = `${n.name}:${n.alias ?? ''}`;
        if (!seen.has(key)) seen.set(key, n);
    }
    return Array.from(seen.values()).sort((a, b) => {
        const aKey = `${a.name}:${a.alias ?? ''}`;
        const bKey = `${b.name}:${b.alias ?? ''}`;
        return aKey.localeCompare(bKey);
    });
}

function collectReplacements(filePath: string, text: string): Replacement[] {
    const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const replacements: Replacement[] = [];

    const imports = sf.statements.filter(ts.isImportDeclaration);
    const rnImports = imports.filter((d) => ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text === 'react-native');
    const appTextImports = imports.filter((d) => ts.isStringLiteral(d.moduleSpecifier) && (d.moduleSpecifier.text === APP_TEXT_MODULE || d.moduleSpecifier.text === LEGACY_TEXT_MODULE));

    let needsText: NamedImport | null = null;
    let needsTextInput: NamedImport | null = null;

    // 1) Update react-native imports to remove Text/TextInput (value imports only).
    for (const decl of rnImports) {
        const parsed = collectNamedImports(decl);
        if (parsed.isTypeOnly) continue;
        if (parsed.namespaceName) continue;
        const originalNamed = parsed.named;
        if (originalNamed.length === 0) continue;

        const kept: NamedImport[] = [];
        for (const n of originalNamed) {
            if (n.name === 'Text') {
                needsText = needsText ?? { name: 'Text', alias: n.alias ?? null };
                continue;
            }
            if (n.name === 'TextInput') {
                needsTextInput = needsTextInput ?? { name: 'TextInput', alias: n.alias ?? null };
                continue;
            }
            kept.push(n);
        }

        if (kept.length === originalNamed.length) continue;

        const nextLine = buildImportLine({
            defaultName: parsed.defaultName,
            namespaceName: parsed.namespaceName,
            named: kept,
            module: 'react-native',
            isTypeOnly: parsed.isTypeOnly,
        });

        replacements.push({
            start: decl.getStart(sf),
            end: decl.getEnd(),
            value: nextLine ? nextLine : '',
        });
    }

    // 2) Ensure we import Text/TextInput from the app primitive module (rewrite legacy specifier too).
    const appDecl = appTextImports.length > 0 ? appTextImports[0] : null;
    if (appDecl) {
        const parsed = collectNamedImports(appDecl);
        const named = [...parsed.named];

        if (needsText && !named.some((n) => n.name === 'Text' && (n.alias ?? null) === (needsText!.alias ?? null))) {
            named.push(needsText);
        }
        if (needsTextInput && !named.some((n) => n.name === 'TextInput' && (n.alias ?? null) === (needsTextInput!.alias ?? null))) {
            named.push(needsTextInput);
        }

        const nextModule = APP_TEXT_MODULE;
        const nextLine = buildImportLine({
            defaultName: parsed.defaultName,
            namespaceName: parsed.namespaceName,
            named: uniqNamedImports(named),
            module: nextModule,
            isTypeOnly: parsed.isTypeOnly,
        });

        // Replace the entire import declaration for stability (module + bindings).
        replacements.push({
            start: appDecl.getStart(sf),
            end: appDecl.getEnd(),
            value: nextLine ?? '',
        });
    } else if (needsText || needsTextInput) {
        const named: NamedImport[] = [];
        if (needsText) named.push(needsText);
        if (needsTextInput) named.push(needsTextInput);

        const line = buildImportLine({
            defaultName: null,
            namespaceName: null,
            named: uniqNamedImports(named),
            module: APP_TEXT_MODULE,
            isTypeOnly: false,
        });

        if (line) {
            const lastImport = imports.length > 0 ? imports[imports.length - 1] : null;
            const insertAt = lastImport ? lastImport.getEnd() : 0;
            const prefix = lastImport ? '\n' : '';
            replacements.push({
                start: insertAt,
                end: insertAt,
                value: `${prefix}${line}\n`,
            });
        }
    }

    return replacements;
}

const files: string[] = [];
walk(sourcesRoot, files);

let changed = 0;
for (const abs of files) {
    if (shouldSkipFile(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const replacements = collectReplacements(abs, text);
    if (replacements.length === 0) continue;
    const next = replaceWithRanges(text, replacements);
    if (next !== text) {
        fs.writeFileSync(abs, next, 'utf8');
        changed += 1;
        console.log(`REWROTE: ${toPosix(path.relative(repoRoot, abs))}`);
    }
}

console.log(`Rewrote text primitives in ${changed} files.`);
