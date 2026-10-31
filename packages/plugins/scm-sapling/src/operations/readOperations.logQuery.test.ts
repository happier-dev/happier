import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithBackendRuntimeServices, type BackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

// The host command adapter is the OS/process boundary; keep the Sapling runtime real.
const runScmCommandMock = vi.fn<BackendRuntimeServices['runCommand']>();

import type { ScmLogListRequest } from '@happier-dev/plugin-sdk/scm';
import type { BackendRuntimeContext as ScmBackendContext } from '@happier-dev/plugin-sdk/scm/backend';

import { saplingLogList } from './readOperations.js';

const SAPLING_LOG_TEMPLATE_ARGS = [
    '--template',
    '{node}\\0{node|short}\\0{author|person}\\0{author|email}\\0{date|hgdate}\\0{desc|firstline}\\0{desc}\\0',
];

function makeEntry(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaaaaaaa',
        authorName: 'Ada Lovelace',
        authorEmail: 'ada@example.com',
        timestamp: 1_767_225_600_000,
        subject: 'feat: cache layer',
        body: 'feat: cache layer',
        ...overrides,
    };
}

function commandCalls(): Array<{ args: readonly string[] }> {
    return runScmCommandMock.mock.calls.map((call) => ({
        args: call[0].args,
    }));
}

describe('saplingLogList bounded commit query', () => {
    let context: ScmBackendContext;

    beforeEach(() => {
        runScmCommandMock.mockReset();
        context = {
            cwd: '/repo',
            projectKey: 'test:/repo',
            detection: {
                isRepo: true,
                rootPath: '/repo',
                mode: '.sl',
            },
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shares one AbortSignal across every concurrent commit-query arm and waits for all to terminate', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        const controller = new AbortController();
        const terminated: number[] = [];
        runScmCommandMock.mockImplementation((input: Readonly<{ signal?: AbortSignal }>) => new Promise((resolve) => {
            const callIndex = runScmCommandMock.mock.calls.length;
            const settle = () => {
                terminated.push(callIndex);
                resolve({ success: false, stdout: '', stderr: 'SCM command was aborted', exitCode: -1 });
            };
            if (input.signal?.aborted) settle();
            else if (input.signal) input.signal.addEventListener('abort', settle, { once: true });
            else setTimeout(settle, 50);
        }));

        const result = saplingLogList({
            context,
            request: { cwd: '/repo', query: 'deadbeef', limit: 10 },
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(runScmCommandMock).toHaveBeenCalledTimes(2));
        controller.abort();
        await result;

        expect(runScmCommandMock.mock.calls.map(([input]) => input.signal)).toEqual([
            controller.signal,
            controller.signal,
        ]);
        expect(terminated).toHaveLength(2);
    }));

    it('searches commit text and author through the keyword flag and echoes queryApplied', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        const entry = makeEntry();
        runScmCommandMock.mockResolvedValueOnce({
            success: true,
            stdout: [
                entry.sha,
                entry.shortSha,
                entry.authorName,
                entry.authorEmail,
                String(Math.floor(entry.timestamp / 1000)) + ' 0',
                entry.subject,
                entry.body,
                '',
            ].join('\0'),
            stderr: '',
            exitCode: 0,
        });

        const response = await saplingLogList({
            context,
            request: { cwd: '/repo', query: 'cache layer', limit: 10 } satisfies ScmLogListRequest,
        });

        expect(response.success).toBe(true);
        expect(response.queryApplied).toBe(true);
        expect(response.entries?.map((candidate) => candidate.sha)).toEqual([entry.sha]);

        const calls = commandCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toEqual(['log', '-k', 'cache layer', '--limit', '10', ...SAPLING_LOG_TEMPLATE_ARGS]);
    }));

    it('adds an abbreviated-SHA revision arm for hex-like queries and merges with keyword results', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        const keywordEntry = makeEntry({ sha: 'b'.repeat(40), timestamp: 1_000 });
        const shaEntry = makeEntry({ sha: 'c'.repeat(40), timestamp: 2_000 });

        runScmCommandMock.mockImplementation(async (input: { args: readonly string[] }) => {
            if (input.args.includes('-k')) {
                return {
                    success: true,
                    stdout: [
                        keywordEntry.sha,
                        keywordEntry.shortSha,
                        keywordEntry.authorName,
                        keywordEntry.authorEmail,
                        String(Math.floor(keywordEntry.timestamp / 1000)) + ' 0',
                        keywordEntry.subject,
                        keywordEntry.body,
                        '',
                    ].join('\0'),
                    stderr: '',
                    exitCode: 0,
                };
            }
            return {
                success: true,
                stdout: [
                    shaEntry.sha,
                    shaEntry.shortSha,
                    shaEntry.authorName,
                    shaEntry.authorEmail,
                    String(Math.floor(shaEntry.timestamp / 1000)) + ' 0',
                    shaEntry.subject,
                    shaEntry.body,
                    '',
                ].join('\0'),
                stderr: '',
                exitCode: 0,
            };
        });

        const response = await saplingLogList({
            context,
            request: { cwd: '/repo', query: 'cccccccc', limit: 10 } satisfies ScmLogListRequest,
        });

        expect(response.queryApplied).toBe(true);
        expect(response.entries?.map((candidate) => candidate.sha)).toEqual([shaEntry.sha, keywordEntry.sha]);

        const calls = commandCalls();
        expect(calls).toHaveLength(2);
        expect(calls[1]?.args[0]).toBe('log');
        expect(calls[1]?.args).toContain('ancestors(.) & id(cccccccc)');
    }));

    it('constrains full and abbreviated SHA matches to current-parent ancestry', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockImplementation(async (input: { args: readonly string[] }) => {
            if (input.args.includes('-k')) {
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            }
            return { success: true, stdout: '', stderr: '', exitCode: 0 };
        });

        for (const query of ['c'.repeat(40), 'cccccccc']) {
            const response = await saplingLogList({
                context,
                request: { cwd: '/repo', query, limit: 10 } satisfies ScmLogListRequest,
            });
            expect(response.success).toBe(true);
        }

        const revisionCalls = commandCalls().filter(({ args }) => args.includes('-r'));
        expect(revisionCalls).toHaveLength(2);
        expect(revisionCalls.map(({ args }) => args[args.indexOf('-r') + 1])).toEqual([
            `ancestors(.) & id(${'c'.repeat(40)})`,
            'ancestors(.) & id(cccccccc)',
        ]);
    }));

    it('returns typed empty success when the SHA arm cannot resolve an unknown revision', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockImplementation(async (input: { args: readonly string[] }) => {
            if (input.args.includes('-k')) {
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            }
            return {
                success: false,
                stdout: '',
                stderr: 'abort: unknown revision deadbeefdeadbeef',
                exitCode: 255,
            };
        });

        const response = await saplingLogList({
            context,
            request: { cwd: '/repo', query: 'deadbeefdeadbeef', limit: 10 } satisfies ScmLogListRequest,
        });

        expect(response.success).toBe(true);
        expect(response.queryApplied).toBe(true);
        expect(response.entries).toEqual([]);
    }));

    it('keeps failing with the mapped command-failure code when keyword search fails', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockResolvedValue({
            success: false,
            stdout: '',
            stderr: 'abort: repository /repo not found',
            exitCode: 255,
        });

        const response = await saplingLogList({
            context,
            request: { cwd: '/repo', query: 'anything', limit: 10 } satisfies ScmLogListRequest,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBeDefined();
        expect(response.queryApplied).toBeUndefined();
    }));

    it('keeps the legacy recent-page behavior (no query echo) when no query is sent', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        const entry = makeEntry();
        runScmCommandMock.mockResolvedValueOnce({
            success: true,
            stdout: [
                entry.sha,
                entry.shortSha,
                entry.authorName,
                entry.authorEmail,
                String(Math.floor(entry.timestamp / 1000)) + ' 0',
                entry.subject,
                entry.body,
                '',
            ].join('\0'),
            stderr: '',
            exitCode: 0,
        });

        const response = await saplingLogList({
            context,
            request: { cwd: '/repo', limit: 2 } satisfies ScmLogListRequest,
        });

        expect(response.success).toBe(true);
        expect(response.queryApplied).toBeUndefined();
        expect(commandCalls()[0]?.args).toEqual(['log', '--limit', '2', ...SAPLING_LOG_TEMPLATE_ARGS]);
    }));
});
