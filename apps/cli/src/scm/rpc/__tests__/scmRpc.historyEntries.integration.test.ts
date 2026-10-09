import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ScmHistoryEntriesRequest, ScmHistoryEntriesResponse } from '@happier-dev/protocol/scm/entriesHistoryV1';
import { createTestGitRpcManager, createTestGitScmBackendRegistry, createTestRpcManager, runGit as git } from './testRpcHarness';
import { createScmBackendRegistry } from '@/scm/registry';

const roots: string[] = [];
function repo() {
    const root = mkdtempSync(join(tmpdir(), 'happier-history-rpc-')); roots.push(root);
    git(root, ['init']); git(root, ['config', 'user.name', 'RPC Author']); git(root, ['config', 'user.email', 'rpc@example.test']);
    return root;
}
function commit(root: string, path: string, subject: string) {
    writeFileSync(join(root, path), subject); git(root, ['--literal-pathspecs', 'add', '--', path]); git(root, ['commit', '-m', subject]);
    return git(root, ['rev-parse', 'HEAD']);
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('SCM entry history RPC dispatch', () => {
    it('reaches the declared Git handler and preserves actual file and directory facts', async () => {
        const root = repo(); const first = commit(root, 'first', 'first');
        mkdirSync(join(root, 'dir')); const second = commit(root, 'dir/child', 'child');
        vi.stubEnv('HAPPIER_MACHINE_RPC_WORKING_DIRECTORY', root);
        const { call } = createTestGitRpcManager({ workingDirectory: root });
        const response = await call<ScmHistoryEntriesResponse, ScmHistoryEntriesRequest>(RPC_METHODS.SCM_HISTORY_ENTRIES, { cwd: root, folder: '', paths: ['first', 'dir', 'untracked'], outcomeVersion: 1 });
        expect(response).toMatchObject({ success: true, headOid: second, entries: [
            { path: 'first', kind: 'commit', commit: { oid: first } },
            { path: 'dir', kind: 'commit', commit: { oid: second } }, { path: 'untracked', kind: 'none' },
        ] });
        expect(await call(RPC_METHODS.SCM_HISTORY_ENTRIES, { cwd: root, folder: '', paths: ['first'], headOid: first })).toMatchObject({
            success: false, errorCode: 'SCM_SOURCE_CHANGED', headOid: second,
        });
        expect(await call(RPC_METHODS.SCM_HISTORY_ENTRIES, { cwd: root, folder: '', paths: ['../escape'], outcomeVersion: 1 })).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
        expect(await call(RPC_METHODS.SCM_HISTORY_ENTRIES, { cwd: join(root, '..'), folder: '', paths: ['first'], outcomeVersion: 1 })).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
    });
    it('returns unsupported without substituting the global log', async () => {
        const root = repo(); commit(root, 'one', 'one');
        const incumbent = createTestGitScmBackendRegistry().listBackends()[0]!;
        const { call } = createTestRpcManager({ workingDirectory: root, registry: createScmBackendRegistry([{ ...incumbent, historyEntries: undefined }]) });
        expect(await call(RPC_METHODS.SCM_HISTORY_ENTRIES, { cwd: root, folder: '', paths: ['one'], outcomeVersion: 1 })).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
    });
    it('uses repository-relative demand from an authorized subdirectory cwd', async () => {
        const root = repo();
        const repositoryFile = commit(root, 'same', 'repository file');
        mkdirSync(join(root, 'workspace'));
        const workspaceFile = commit(root, 'workspace/same', 'workspace file');
        mkdirSync(join(root, 'workspace', 'dir'));
        const descendant = commit(root, 'workspace/dir/line\nbreak ', 'workspace descendant');
        const tip = commit(root, 'outside', 'later repository sibling');
        vi.stubEnv('HAPPIER_MACHINE_RPC_WORKING_DIRECTORY', root);
        const { call } = createTestGitRpcManager({ workingDirectory: root });
        expect(await call<ScmHistoryEntriesResponse, ScmHistoryEntriesRequest>(RPC_METHODS.SCM_HISTORY_ENTRIES, {
            cwd: join(root, 'workspace'), folder: '', paths: ['same', 'workspace/same', 'workspace/dir', 'workspace'], outcomeVersion: 1,
        })).toMatchObject({ success: true, headOid: tip, entries: [
            { path: 'same', kind: 'commit', commit: { oid: repositoryFile } },
            { path: 'workspace/same', kind: 'commit', commit: { oid: workspaceFile } },
            { path: 'workspace/dir', kind: 'commit', commit: { oid: descendant } },
            { path: 'workspace', kind: 'commit', commit: { oid: descendant } },
        ] });
    });
    it('does not invent empty history for an authorized non-repository', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-history-nonrepo-')); roots.push(root);
        const { call } = createTestGitRpcManager({ workingDirectory: root });
        expect(await call(RPC_METHODS.SCM_HISTORY_ENTRIES, { cwd: root, folder: '', paths: ['one'], outcomeVersion: 1 })).toMatchObject({ success: false, errorCode: 'NOT_REPOSITORY' });
    });
});
