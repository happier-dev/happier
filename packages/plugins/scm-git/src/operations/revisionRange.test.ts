import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScmLogListResponseSchema } from '@happier-dev/protocol/scm';

import { createGitScmBackendRuntimeRegistration } from '../backend.js';
import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';

describe('registered Git exact revision range history', () => {
    it('attests pinned endpoints and native total count independently of the bounded page and unrelated HEAD', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-revision-range-'));
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
        try {
            git('init', '--quiet');
            git('config', 'user.name', 'Range Fixture');
            git('config', 'user.email', 'range@example.test');
            const commit = async (name: string) => {
                await writeFile(join(root, 'file.txt'), name);
                git('add', 'file.txt');
                git('commit', '--quiet', '-m', name);
                return git('rev-parse', 'HEAD');
            };
            const baseOid = await commit('A');
            await commit('B');
            const headOid = await commit('C');
            await writeFile(join(root, 'file.txt'), 'D');
            git('add', 'file.txt');
            const unrelatedHead = git('commit-tree', git('write-tree'), '-p', baseOid, '-m', 'D');
            git('update-ref', 'HEAD', unrelatedHead);
            expect(git('rev-parse', 'HEAD')).not.toBe(headOid);
            const logList = createGitScmBackendRuntimeRegistration().handlers.read?.logList;
            expect(logList).toBeTypeOf('function');
            if (!logList) throw new Error('Git must register its log reader');
            const read = (baseOid: string, headOid: string) => runWithRealGitScmRuntime(() => logList({
                context: { cwd: root, projectKey: root, detection: { isRepo: true, rootPath: root, mode: '.git' } },
                request: { cwd: root, limit: 1, revisionRange: { kind: 'revisionRange', baseOid, headOid } },
                signal: new AbortController().signal,
            }));

            const forward = await read(baseOid, headOid);
            expect(ScmLogListResponseSchema.parse(forward)).toEqual(forward);
            expect(forward).toMatchObject({ success: true, entries: [{ sha: headOid, subject: 'C' }],
                revisionRange: { kind: 'revisionRange', baseOid, headOid, graphRelation: 'forward', totalCount: 2, nextSkip: 1 } });
            expect(forward.entries).toHaveLength(1);
            expect(await read(headOid, unrelatedHead)).toMatchObject({ success: true,
                entries: [{ sha: unrelatedHead, subject: 'D' }], revisionRange: { kind: 'revisionRange',
                    baseOid: headOid, headOid: unrelatedHead, graphRelation: 'diverged', totalCount: 1 } });
            expect(await read(baseOid, baseOid)).toMatchObject({ success: true, entries: [],
                revisionRange: { kind: 'revisionRange', baseOid, headOid: baseOid, graphRelation: 'equal', totalCount: 0 } });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
