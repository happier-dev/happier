import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CLI_SOURCE_ROOT = join(process.cwd(), 'src');

function listProductionTypeScriptFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') return [];
            return listProductionTypeScriptFiles(path);
        }
        if (!entry.isFile() || !/\.(ts|tsx)$/u.test(entry.name)) return [];
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) return [];
        if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.tsx')) return [];
        return [path];
    });
}

function collectClaudePluginRootImports(path: string): string[] {
    const sourceText = readFileSync(path, 'utf8');
    const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];

    function visit(node: ts.Node): void {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier
            && ts.isStringLiteral(node.moduleSpecifier)
            && node.moduleSpecifier.text === '@happier-dev/plugins-claude'
        ) {
            violations.push(relative(CLI_SOURCE_ROOT, path));
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

function collectForbiddenModuleImports(path: string, forbiddenModule: string): string[] {
    const sourceText = readFileSync(path, 'utf8');
    const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];

    function visit(node: ts.Node): void {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier
            && ts.isStringLiteral(node.moduleSpecifier)
            && node.moduleSpecifier.text === forbiddenModule
        ) {
            violations.push(relative(CLI_SOURCE_ROOT, path));
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return violations;
}

describe('Claude plugin import boundary', () => {
    it('keeps CLI production code off the Claude plugin root UI entrypoint', () => {
        const violations = listProductionTypeScriptFiles(CLI_SOURCE_ROOT)
            .flatMap(collectClaudePluginRootImports)
            .sort();

        expect(violations).toEqual([]);
    });

    it('keeps provider task status helpers plugin-owned', () => {
        const hostProviderTaskStatusPath = join(CLI_SOURCE_ROOT, 'backends/claude/sdk/providerTaskStatus.ts');
        const violations = listProductionTypeScriptFiles(CLI_SOURCE_ROOT)
            .flatMap((path) => collectForbiddenModuleImports(path, '@/backends/claude/sdk/providerTaskStatus'))
            .sort();

        expect(existsSync(hostProviderTaskStatusPath)).toBe(false);
        expect(violations).toEqual([]);
    });

    it('keeps unused remote sidechain session wrappers out of the host tree', () => {
        const hostRemoteSessionWrapperPath = join(
            CLI_SOURCE_ROOT,
            'backends/claude/remote/sidechains/resolveClaudeSubagentJsonlPathForRemoteSession.ts',
        );

        expect(existsSync(hostRemoteSessionWrapperPath)).toBe(false);
    });

    it('keeps Claude permission mode callers on the narrow plugin runtime subpath', () => {
        const narrowPermissionModeSubpath = '@happier-dev/plugins-claude/agent/runtime/permissionMode';
        const permissionModeCallers = [
            join(CLI_SOURCE_ROOT, 'backends/claude/utils/permissionMode.ts'),
            join(CLI_SOURCE_ROOT, 'backends/claude/utils/resolveClaudeLocalLaunchRequest.ts'),
        ];

        for (const callerPath of permissionModeCallers) {
            const source = readFileSync(callerPath, 'utf8');
            expect(source).toContain(narrowPermissionModeSubpath);
            expect(source).not.toContain("from '@happier-dev/plugins-claude/agent';");
            expect(source).not.toContain('from "@happier-dev/plugins-claude/agent";');
        }
    });
});
