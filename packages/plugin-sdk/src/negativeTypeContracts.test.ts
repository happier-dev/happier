import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type NegativeTypeCase = Readonly<{
    id: string;
    reason: string;
    fileName: string;
    start: number;
    end: number;
}>;

const CASE_PATTERN = /\/\* @sdk-negative-type-case:([^:]+):([^:]+):([^ ]+) \*\/[\s\S]*?\/\* @sdk-negative-type-case-end \*\//gu;

function sourceFilesBelow(directory: string): readonly string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFilesBelow(path);
        return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });
}

function decode(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function reconstructNegativeTypeCases(
    fileName: string,
    source: string,
): Readonly<{ source: string; cases: readonly NegativeTypeCase[] }> {
    const cases: NegativeTypeCase[] = [];
    let output = '';
    let previousEnd = 0;

    for (const match of source.matchAll(CASE_PATTERN)) {
        const matchStart = match.index;
        output += source.slice(previousEnd, matchStart);
        const code = decode(match[3]);
        const start = output.length;
        output += code;
        cases.push({
            id: match[1],
            reason: decode(match[2]),
            fileName,
            start,
            end: output.length,
        });
        previousEnd = matchStart + match[0].length;
    }
    output += source.slice(previousEnd);
    return { source: output, cases };
}

describe('SDK negative type contracts', () => {
    it('retains only the explicitly audited public-boundary and legacy negative-contract fences', () => {
        const sourceRoot = resolve(import.meta.dirname);
        const directive = ['@ts', 'expect-error'].join('-');
        const fences = sourceFilesBelow(sourceRoot).flatMap((fileName) => {
            const lines = readFileSync(fileName, 'utf8').split('\n');
            return lines.flatMap((line, index) => line.includes(directive)
                ? [{
                    fileName: fileName.slice(sourceRoot.length + 1),
                    reason: line.slice(line.indexOf(directive) + directive.length).trim(),
                    guardedDeclaration: lines[index + 1]?.trim(),
                }]
                : []);
        });

        expect(fences).toEqual([
            {
                fileName: 'actions/actionContracts.test.ts',
                reason: 'Client Action modules are package-relative.',
                guardedDeclaration: "modulePath: 'runAction',",
            },
            {
                fileName: 'actions/actionContracts.test.ts',
                reason: 'Authored Actions cannot infer a daemon execution target.',
                guardedDeclaration: 'missingTarget: {',
            },
            {
                fileName: 'actions/actionContracts.test.ts',
                reason: 'Client Action handlers belong only to the client artifact activation.',
                guardedDeclaration: 'const invalidClientAction: PluginActionDefinition<{',
            },
            {
                fileName: 'actions/actionContracts.test.ts',
                reason: 'Client Action handlers never receive daemon services.',
                guardedDeclaration: 'void context.services;',
            },
            {
                fileName: 'actions/actionContracts.test.ts',
                reason: 'Client activation does not expose daemon Agent registration.',
                guardedDeclaration: 'void clientApi.agents;',
            },
            {
                fileName: 'actions/actionContracts.test.ts',
                reason: 'Client activation does not expose daemon Hook registration.',
                guardedDeclaration: 'void clientApi.hooks;',
            },
            {
                fileName: 'actions/actionContracts.test.ts',
                reason: "The contract's declaration requires a title string.",
                guardedDeclaration: "void actions.execute(contract, { id: 'release-1' });",
            },
            {
                fileName: 'agentRuntimeSurfaceContract.ts',
                reason: 'CORE.T2A: RuntimeCoreV1 is a retired shadow runtime ABI.',
                guardedDeclaration: "import type { RuntimeCoreV1 } from './agent-runtime.js';",
            },
            {
                fileName: 'agentRuntimeSurfaceContract.ts',
                reason: 'CORE.T2A: AcpSessionRuntimeV1 is replaced by the common ACP composer.',
                guardedDeclaration: "import type { AcpSessionRuntimeV1 } from './agent-runtime.js';",
            },
            {
                fileName: 'agentRuntimeSurfaceContract.ts',
                reason: 'G6: AgentRuntimeV1 is replaced by the native AgentRuntime contract.',
                guardedDeclaration: "import type { AgentRuntimeV1 } from './agent-runtime.js';",
            },
            {
                fileName: 'agentUiGrammar.contract.test-d.ts',
                reason: "'bool' is not a declarable new-session option kind.",
                guardedDeclaration: "newSession: { agentOptions: [{ key: 'allowIndexing', kind: 'bool' }] },",
            },
            {
                fileName: 'agentUiGrammar.contract.test-d.ts',
                reason: '`newSesion` is not part of the Agent UI grammar.',
                guardedDeclaration: 'behavior: { newSesion: { canSelectWithoutDetectedCli: true } },',
            },
            {
                fileName: 'agentUiGrammar.contract.test-d.ts',
                reason: 'nested behavior inherits `contributes.agents[].id`.',
                guardedDeclaration: "providerId: 'another.agent',",
            },
            {
                fileName: 'agentUiGrammar.contract.test-d.ts',
                reason: 'compiled first-party component ids are not authorable.',
                guardedDeclaration: "slots: [{ id: 'x', slot: 'session.detailsTabs', componentId: 'firstParty.claude.teammateDetailsTab' }],",
            },
            {
                fileName: 'agentUiGrammar.contract.test-d.ts',
                reason: 'only the `static` spawn-extras form is authorable.',
                guardedDeclaration: "payload: { spawnSessionExtras: { kind: 'adapter', adapterId: 'codex.backendMode' } },",
            },
            {
                fileName: 'agentUiGrammar.contract.test-d.ts',
                reason: 'static spawn configuration is scalar-only.',
                guardedDeclaration: 'value: { acmeMode: { nested: true } },',
            },
            {
                fileName: 'agentUiGrammar.contract.test-d.ts',
                reason: 'compiled message-meta descriptor ids are not authorable.',
                guardedDeclaration: "ui: { message: { metaDescriptorIds: ['claude.thinking'] } },",
            },
            {
                fileName: 'host/registration/scope.test.ts',
                reason: 'A client registration scope does not expose daemon registrations.',
                guardedDeclaration: 'void scope.api.hooks;',
            },
            {
                fileName: 'storage.accountKv.contract.test-d.ts',
                reason: 'Account KV writes must name their conditional version.',
                guardedDeclaration: "void transaction.set('checkpoint', { offset: 1 });",
            },
            {
                fileName: 'storage.accountKv.contract.test-d.ts',
                reason: 'A tombstone cannot be deleted through an absent precondition.',
                guardedDeclaration: "void transaction.delete('checkpoint', { expectedVersion: 'absent' });",
            },
            {
                fileName: 'targetedContributionAuthoring.test.ts',
                reason: 'A descriptor-free protocol forbids the field.',
                guardedDeclaration: "descriptor: { providerId: 'github' },",
            },
        ]);
    });

    // One TypeScript program over every reconstructed negative case in the
    // package: the cost tracks the SDK source tree, not a fixed workload, and
    // it grows with each `@sdk-negative-type-case` fence. Measured 83.9 s in
    // isolation and >120 s inside `vitest run` for the whole package, where it
    // shares the host with the other whole-program declaration suites. The
    // budget is sized from that in-suite reality with headroom, so a slow
    // shared host cannot turn a passing type contract into a red suite.
    it('rejects every data-driven negative case without source suppression fences', () => {
        const sourceRoot = resolve(import.meta.dirname);
        const reconstructedSources = new Map<string, string>();
        const cases: NegativeTypeCase[] = [];

        for (const fileName of sourceFilesBelow(sourceRoot)) {
            const source = readFileSync(fileName, 'utf8');
            if (!source.includes('@sdk-negative-type-case:')) continue;
            const reconstructed = reconstructNegativeTypeCases(fileName, source);
            reconstructedSources.set(fileName, reconstructed.source);
            cases.push(...reconstructed.cases);
        }

        const configPath = resolve(sourceRoot, '../tsconfig.tests.json');
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (configFile.error) {
            throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
        }
        const parsed = ts.parseJsonConfigFileContent(
            configFile.config,
            ts.sys,
            dirname(configPath),
            undefined,
            configPath,
        );
        const host = ts.createCompilerHost(parsed.options);
        const readFile = host.readFile.bind(host);
        host.readFile = (fileName) => reconstructedSources.get(resolve(fileName)) ?? readFile(fileName);
        host.getSourceFile = (fileName, languageVersionOrOptions) => {
            const sourceText = host.readFile(fileName);
            return sourceText === undefined
                ? undefined
                : ts.createSourceFile(
                    fileName,
                    sourceText,
                    languageVersionOrOptions,
                    true,
                    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
                );
        };

        const program = ts.createProgram({
            rootNames: parsed.fileNames,
            options: parsed.options,
            projectReferences: parsed.projectReferences,
            host,
        });
        const syntacticDiagnostics = program.getSyntacticDiagnostics();
        const diagnostics = program.getSemanticDiagnostics();
        const missing = cases.filter((negativeCase) => !diagnostics.some((diagnostic) => (
            diagnostic.file?.fileName === negativeCase.fileName
            && diagnostic.start !== undefined
            && negativeCase.start <= diagnostic.start
            && diagnostic.start <= negativeCase.end
        )));
        const unexpectedFiles = diagnostics
            .filter((diagnostic) => (
                diagnostic.file === undefined
                || !reconstructedSources.has(diagnostic.file.fileName)
            ))
            .map((diagnostic) => ({
                fileName: diagnostic.file?.fileName ?? '<global>',
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            }));

        expect(cases).toHaveLength(298);
        expect(syntacticDiagnostics.map((diagnostic) => ({
            fileName: diagnostic.file?.fileName ?? '<global>',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        }))).toEqual([]);
        expect(missing.map(({ id, reason }) => ({ id, reason }))).toEqual([]);
        expect(unexpectedFiles).toEqual([]);
    }, 300_000);
});
