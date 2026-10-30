import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const canonicalPlaybackOwnerPath = 'sources/voice/runtime/playback/VoicePlaybackController.ts';

const retiredCompatibilityWrappers = [
    'sources/voice/runtime/VoicePlaybackController.ts',
] as const;

const uiRootPath = fileURLToPath(new URL('../../../../', import.meta.url));
const canonicalOwnerModulePath = join(uiRootPath, canonicalPlaybackOwnerPath).replace(/\.ts$/, '');

async function listSourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'testkit' ? [] : listSourceFiles(path);
        return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)
            && !/\.(?:test|spec|generated)\./.test(entry.name) ? [path] : [];
    }));
    return files.flat();
}

function playbackImportTargets(filePath: string, source: string): string[] {
    const targets = new Set<string>();
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest);
    const visit = (node: ts.Node) => {
        let moduleSpecifier: ts.Node | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) moduleSpecifier = node.moduleSpecifier;
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) moduleSpecifier = node.argument.literal;
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) moduleSpecifier = node.arguments[0];
        if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)
            && /\/VoicePlaybackController(?:\.[cm]?[jt]sx?)?$/.test(moduleSpecifier.text)) {
            const specifier = moduleSpecifier.text;
            const target = specifier.startsWith('@/') ? join(uiRootPath, 'sources', specifier.slice(2))
                : specifier.startsWith('.') ? resolve(dirname(filePath), specifier) : specifier;
            targets.add(target.replace(/\.[cm]?[jt]sx?$/, ''));
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...targets];
}

describe('voice playback canonical owner imports', () => {
    it('routes every direct interruption/stopper consumer through the runtime/playback owner path', async () => {
        // Inspect actual import/re-export/dynamic/type edges, not mentions in comments or a
        // fixed list that omits native variants and newly added consumers elsewhere in the UI.
        const files = await listSourceFiles(join(uiRootPath, 'sources'));
        const consumers: Array<{ consumer: string; target: string }> = [];
        for (const filePath of files) {
            const source = await readFile(filePath, 'utf8');
            if (!source.includes('VoicePlaybackController')) continue;
            consumers.push(...playbackImportTargets(filePath, source).map(target => ({
                consumer: relative(uiRootPath, filePath), target,
            })));
        }
        expect(consumers.length).toBeGreaterThan(0);
        expect(consumers.filter(({ target }) => target !== canonicalOwnerModulePath)).toEqual([]);
    });

    it('keeps the canonical owner self-contained rather than requiring a self-import', async () => {
        const ownerPath = join(uiRootPath, canonicalPlaybackOwnerPath);
        expect(playbackImportTargets(ownerPath, await readFile(ownerPath, 'utf8'))).toEqual([]);
    });

    it('deletes the playback compatibility wrapper once all remaining consumers use the canonical owner path', async () => {
        for (const retiredPath of retiredCompatibilityWrappers) {
            await expect(access(join(uiRootPath, retiredPath))).rejects.toBeDefined();
        }
    });
});
