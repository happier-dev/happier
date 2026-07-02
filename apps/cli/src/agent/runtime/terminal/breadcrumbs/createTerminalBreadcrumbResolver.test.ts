import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTerminalBreadcrumbResolver, type TerminalBreadcrumbResolverConfig } from './createTerminalBreadcrumbResolver';

type Input = Readonly<{
    cwd: string;
    terminalId?: string | null;
}>;

type Source = Readonly<{
    agentDir: string;
    remoteSessionId: string;
    sessionFilePath: string;
    terminalId: string;
}>;

function createConfig(overrides?: Partial<TerminalBreadcrumbResolverConfig<Input, Source>>): TerminalBreadcrumbResolverConfig<Input, Source> {
    const root = resolve('/tmp/a13e-root');
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'workspace');
    const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_remote-123.jsonl');

    return {
        agentDir,
        resolveTerminalId: (input) => input.terminalId,
        breadcrumbSubdir: 'terminal-sessions',
        sessionsSubdir: 'sessions',
        parseSessionId: (path) => {
            const fileName = basename(path);
            return fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length).split('_')[1] : null;
        },
        validateCwd: (candidateCwd, input) => resolve(candidateCwd) === resolve(input.cwd),
        validateSessionFile: () => true,
        projectSource: (context) => ({
            agentDir: context.agentDir,
            remoteSessionId: context.remoteSessionId,
            sessionFilePath: context.sessionFilePath,
            terminalId: context.terminalId,
        }),
        readTextFile: () => `${cwd}\n${sessionFilePath}\n`,
        canonicalizePath: (path) => resolve(path),
        ...overrides,
    };
}

describe('createTerminalBreadcrumbResolver', () => {
    it('resolves a valid two-line breadcrumb through provider-supplied projection', () => {
        const root = resolve('/tmp/a13e-root');
        const agentDir = join(root, 'agent');
        const cwd = join(root, 'workspace');
        const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_remote-123.jsonl');
        const readPaths: string[] = [];

        const resolver = createTerminalBreadcrumbResolver(createConfig({
            readTextFile: (path) => {
                readPaths.push(path);
                return `${cwd}\n${sessionFilePath}\n`;
            },
        }));

        expect(resolver({ cwd, terminalId: 'pts-3' })).toEqual({
            agentDir,
            remoteSessionId: 'remote-123',
            sessionFilePath,
            terminalId: 'pts-3',
        });
        expect(readPaths).toEqual([join(agentDir, 'terminal-sessions', 'pts-3')]);
    });

    it('returns undefined for invalid breadcrumbs before projection', () => {
        const root = resolve('/tmp/a13e-root');
        const agentDir = join(root, 'agent');
        const cwd = join(root, 'workspace');
        const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_remote-123.jsonl');
        const outsideSessionFilePath = join(root, 'outside', '1710000000000_remote-123.jsonl');
        const projected: Source[] = [];

        const cases: readonly [string, Input, Partial<TerminalBreadcrumbResolverConfig<Input, Source>>][] = [
            ['missing terminal id', { cwd, terminalId: null }, {}],
            ['missing breadcrumb file', { cwd, terminalId: 'pts-3' }, { readTextFile: () => { throw new Error('missing'); } }],
            ['extra non-empty lines', { cwd, terminalId: 'pts-3' }, { readTextFile: () => `${cwd}\n${sessionFilePath}\nextra\n` }],
            ['cwd mismatch', { cwd, terminalId: 'pts-3' }, { readTextFile: () => `${join(root, 'other')}\n${sessionFilePath}\n` }],
            ['outside sessions root', { cwd, terminalId: 'pts-3' }, { readTextFile: () => `${cwd}\n${outsideSessionFilePath}\n` }],
            ['invalid session id', { cwd, terminalId: 'pts-3' }, { parseSessionId: () => null }],
            ['invalid session file', { cwd, terminalId: 'pts-3' }, { validateSessionFile: () => false }],
        ];

        for (const [, input, overrides] of cases) {
            const resolver = createTerminalBreadcrumbResolver(createConfig({
                ...overrides,
                projectSource: (context) => {
                    const source = {
                        agentDir: context.agentDir,
                        remoteSessionId: context.remoteSessionId,
                        sessionFilePath: context.sessionFilePath,
                        terminalId: context.terminalId,
                    };
                    projected.push(source);
                    return source;
                },
            }));

            expect(resolver(input)).toBeUndefined();
        }

        expect(projected).toEqual([]);
    });
});
