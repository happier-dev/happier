import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rewriteInlineMockFamilies, type InlineMockFamily } from './mockFamilyRewriter';

const repoRoot = path.resolve(__dirname, '../../../..');

type CliOptions = Readonly<{
    families: readonly InlineMockFamily[];
    scopes: readonly string[];
    write: boolean;
    json: boolean;
}>;

export function parseRewriteInlineMockFamiliesArgs(argv: readonly string[]): CliOptions {
    const families: InlineMockFamily[] = [];
    const scopes: string[] = [];
    let write = false;
    let json = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--family') {
            const next = argv[index + 1];
            if (!next || !['reactNative', 'text', 'modal', 'router', 'storage', 'unistyles'].includes(next)) {
                throw new Error('Expected --family <reactNative|text|modal|router|storage|unistyles>.');
            }
            families.push(next as InlineMockFamily);
            index += 1;
            continue;
        }
        if (arg === '--scope') {
            const next = argv[index + 1];
            if (!next) {
                throw new Error('Expected --scope <path>.');
            }
            scopes.push(next);
            index += 1;
            continue;
        }
        if (arg === '--write') {
            write = true;
            continue;
        }
        if (arg === '--dry-run') {
            write = false;
            continue;
        }
        if (arg === '--json') {
            json = true;
            continue;
        }
        scopes.push(arg);
    }

    return {
        families: families.length > 0 ? families : ['reactNative', 'text', 'modal', 'router', 'storage', 'unistyles'],
        scopes: scopes.length > 0 ? scopes : ['apps/ui/sources'],
        write,
        json,
    };
}

function isTsLike(filePath: string): boolean {
    return /\.(ts|tsx|mts|cts|js|jsx)$/.test(filePath);
}

function toPosix(filePath: string): string {
    return filePath.split(path.sep).join('/');
}

function walk(currentPath: string, out: string[]): void {
    const stat = fs.statSync(currentPath);
    if (stat.isDirectory()) {
        for (const child of fs.readdirSync(currentPath)) {
            if (child.startsWith('.')) continue;
            if (child === 'node_modules') continue;
            walk(path.join(currentPath, child), out);
        }
        return;
    }
    if (isTsLike(currentPath)) {
        out.push(currentPath);
    }
}

function resolveScopes(scopes: readonly string[]): string[] {
    return scopes.map((scope) => (path.isAbsolute(scope) ? scope : path.resolve(repoRoot, scope)));
}

function main(): void {
    const options = parseRewriteInlineMockFamiliesArgs(process.argv.slice(2));
    const files: string[] = [];

    for (const scope of resolveScopes(options.scopes)) {
        walk(scope, files);
    }

    let changedFiles = 0;
    const rewritesByFamily = new Map<InlineMockFamily, number>();

    for (const filePath of files) {
        const text = fs.readFileSync(filePath, 'utf8');
        const result = rewriteInlineMockFamilies(text, {
            filePath,
            families: options.families,
        });
        if (result.rewrites.length === 0 || result.text === text) {
            continue;
        }

        changedFiles += 1;
        for (const rewrite of result.rewrites) {
            rewritesByFamily.set(rewrite.family, (rewritesByFamily.get(rewrite.family) ?? 0) + 1);
        }

        if (options.write) {
            fs.writeFileSync(filePath, result.text, 'utf8');
            console.log(`REWROTE: ${toPosix(path.relative(repoRoot, filePath))}`);
        } else {
            console.log(`WOULD_REWRITE: ${toPosix(path.relative(repoRoot, filePath))}`);
        }
    }

    const summary = {
        mode: options.write ? 'write' : 'dry-run',
        families: options.families,
        scopes: options.scopes,
        changedFiles,
        rewritesByFamily: Object.fromEntries([...rewritesByFamily.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };

    if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
    }

    console.log('summary:');
    console.log(`  mode=${summary.mode}`);
    console.log(`  changedFiles=${summary.changedFiles}`);
    console.log(`  families=${summary.families.join(',')}`);
    for (const [family, count] of Object.entries(summary.rewritesByFamily)) {
        console.log(`  ${family}=${count}`);
    }
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entryFilePath === currentFilePath) {
    main();
}
