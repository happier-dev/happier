import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RawJSONLines as CanonicalRawJSONLines } from '@happier-dev/plugins-claude/agent/transcripts';
import { describe, expect, it } from 'vitest';

import type { RawJSONLines as CliLibRawJSONLines } from './lib.js';

type IsExactType<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
        ? (<Value>() => Value extends Right ? 1 : 2) extends
          (<Value>() => Value extends Left ? 1 : 2)
            ? true
            : false
        : false;

const rawJSONLinesTypesHaveExactIdentity: IsExactType<
    CliLibRawJSONLines,
    CanonicalRawJSONLines
> = true;

const cliSourceDir = dirname(fileURLToPath(import.meta.url));
const cliPackageDir = resolve(cliSourceDir, '..');
const claudeTranscriptExportSource = '@happier-dev/plugins-claude/agent/transcripts';
const genericRuntimeRootNames = ['agent', 'api', 'daemon', 'rpc', 'session', 'terminal'] as const;

function listProductionTypeScriptFiles(root: string): readonly string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = resolve(root, entry.name);
        if (entry.isDirectory()) return listProductionTypeScriptFiles(entryPath);
        if (!entry.isFile()) return [];
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) return [];
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) return [];
        if (entry.name.endsWith('.test-support.ts')) return [];
        return [entryPath];
    });
}

describe('@happier-dev/cli/lib Claude transcript compatibility identities', () => {
    it('keeps the released package subpath mapped to the CLI lib artifact', () => {
        const packageJson = JSON.parse(
            readFileSync(resolve(cliPackageDir, 'package.json'), 'utf8'),
        ) as {
            exports?: Record<string, unknown>;
        };

        expect(packageJson.exports?.['./lib']).toEqual({
            require: {
                types: './dist/lib.d.cts',
                default: './dist/lib.cjs',
            },
            import: {
                types: './dist/lib.d.mts',
                default: './dist/lib.mjs',
            },
        });
    });

    it('re-exports the released Claude JSONL object and type from their canonical owner', () => {
        expect(rawJSONLinesTypesHaveExactIdentity).toBe(true);

        const libSource = readFileSync(resolve(cliSourceDir, 'lib.ts'), 'utf8');
        const claudeModuleReferences = [
            ...libSource.matchAll(/from\s+['"](@happier-dev\/plugins-claude[^'"]*)['"]/gu),
        ].map((match) => match[1]);
        const canonicalExport = libSource.match(
            /export\s*\{([^}]*)\}\s*from\s*['"]@happier-dev\/plugins-claude\/agent\/transcripts['"]/u,
        );
        const exportedNames = (canonicalExport?.[1] ?? '')
            .split(',')
            .map((name) => name.trim().replace(/\s+/gu, ' '))
            .filter(Boolean)
            .sort();

        expect(claudeModuleReferences).toEqual([claudeTranscriptExportSource]);
        expect(exportedNames).toEqual(['RawJSONLinesSchema', 'type RawJSONLines']);
    });

    it('keeps generic CLI runtime roots free of direct Claude-plugin imports', () => {
        const offenders = genericRuntimeRootNames.flatMap((rootName) =>
            listProductionTypeScriptFiles(resolve(cliSourceDir, rootName)).flatMap((filePath) => {
                const source = readFileSync(filePath, 'utf8');
                return source.includes('@happier-dev/plugins-claude')
                    ? [relative(cliPackageDir, filePath)]
                    : [];
            }),
        );

        expect(offenders).toEqual([]);
    });
});
