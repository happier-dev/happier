import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBackendCommandMaxOutputBytes, type BackendRuntimeContext } from '@happier-dev/plugin-sdk/scm/backend';
import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import * as reads from './readOperations.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let root: string;
const roots: string[] = [];
const context = (): BackendRuntimeContext => ({ cwd: root, projectKey: root, detection: { isRepo: true, rootPath: root, mode: '.git' } });
async function commit(path: string, subject: string): Promise<string> {
    await writeFile(join(root, path), subject);
    git(root, ['--literal-pathspecs', 'add', '--', path]);
    git(root, ['commit', '-m', subject]);
    return git(root, ['rev-parse', 'HEAD']);
}
async function history(paths: string[], headOid?: string) {
    expect(reads.gitHistoryEntries, 'Git must contribute real entry history').toBeTypeOf('function');
    return runWithRealGitScmRuntime(() => reads.gitHistoryEntries({ context: context(), request: { cwd: root, folder: '', paths, ...(headOid ? { headOid } : {}) } }));
}
describe('Git demanded entry history', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-entry-history-'));
        roots.push(root);
        git(root, ['init']);
        git(root, ['config', 'user.name', 'History Author']);
        git(root, ['config', 'user.email', 'history@example.test']);
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });
    it('returns each file’s actual commit and a directory’s latest descendant, with literal path boundaries', async () => {
        const first = await commit('one.txt', 'first');
        await mkdir(join(root, 'dir'));
        const nested = await commit('dir/child', 'descendant');
        await mkdir(join(root, 'directory'));
        await commit('directory/sibling', 'sibling is not dir');
        const second = await commit('two', 'second');
        const special = [':(glob)*', '-dash', 'line\nbreak', 'space '];
        const expected = new Map<string, string>();
        for (const path of special) expected.set(path, await commit(path, `literal ${expected.size}`));
        await writeFile(join(root, 'untracked'), 'not committed');
        const response = await history(['one.txt', 'two', 'dir', 'untracked', ...special, '']);
        expect(response.success).toBe(true);
        if (!response.success) return;
        expect(response.headOid).toBe(git(root, ['rev-parse', 'HEAD']));
        expect(response.entries.slice(0, 4)).toMatchObject([
            { path: 'one.txt', kind: 'commit', commit: { oid: first, subject: 'first', authorName: 'History Author' } },
            { path: 'two', kind: 'commit', commit: { oid: second } },
            { path: 'dir', kind: 'commit', commit: { oid: nested } },
            { path: 'untracked', kind: 'none' },
        ]);
        for (const entry of response.entries.slice(4, -1)) {
            expect(entry).toMatchObject({ kind: 'commit', commit: { oid: expected.get(entry.path) } });
        }
        expect(response.entries.at(-1)).toMatchObject({ path: '', kind: 'commit', commit: { oid: git(root, ['rev-parse', 'HEAD']) } });
        expect(response.entries[0]).toMatchObject({ commit: { committedAt: expect.any(Number) } });
    });
    it('reports unborn as no commits, and conflicting witnesses as source changed', async () => {
        expect(await history(['untracked'])).toEqual({ success: true, headOid: null, entries: [{ path: 'untracked', kind: 'none' }] });
        const before = await commit('one', 'before');
        const after = await commit('one', 'after');
        expect(await history(['one'], before)).toMatchObject({ success: false, headOid: after, errorCode: 'SCM_SOURCE_CHANGED' });
    });
    it('settles recent demanded facts before older root history exceeds the command output boundary', async () => {
        // Exercise the canonical default boundary, not an executor's permitted
        // environment override. Keep that override intact for the other tests.
        vi.stubEnv('HAPPIER_SCM_MAX_OUTPUT_BYTES', '');
        const commandOutputBoundary = resolveBackendCommandMaxOutputBytes();
        await writeFile(join(root, 'old'), 'old content');
        git(root, ['add', 'old']);
        // A real old commit subject makes the unrestricted root log exceed the
        // existing 4 MiB process boundary without a slow thousands-commit fixture.
        const oldSubjectFragment = 'old history ';
        const oldSubject = oldSubjectFragment.repeat(Math.floor(commandOutputBoundary / oldSubjectFragment.length) + 1);
        execFileSync('git', ['commit', '--quiet', '-F', '-'], { cwd: root, input: oldSubject });
        const recent = await commit('recent', 'recent fact');
        expect(Buffer.byteLength(execFileSync('git', ['log', '--format=%s'], {
            cwd: root, maxBuffer: commandOutputBoundary * 2,
        }))).toBeGreaterThan(commandOutputBoundary);
        const services = createRealGitScmBackendRuntimeServices();
        let bytesRead = 0;
        const response = await runWithGitScmCommandRunner(input => {
            if (!('stdoutConsumer' in input)) return services.runCommand(input);
            return services.runCommandStreaming!({ ...input, stdoutConsumer: chunk => {
                bytesRead += chunk.byteLength;
                return input.stdoutConsumer(chunk);
            } });
        }, () => reads.gitHistoryEntries({ context: context(), request: { cwd: root, folder: '', paths: ['recent', '', 'recent'] } }));
        expect(response).toMatchObject({ success: true, headOid: recent, entries: [
            { path: 'recent', kind: 'commit', commit: { oid: recent, subject: 'recent fact' } },
            { path: '', kind: 'commit', commit: { oid: recent, subject: 'recent fact' } },
            { path: 'recent', kind: 'commit', commit: { oid: recent, subject: 'recent fact' } },
        ] });
        expect(bytesRead).toBeGreaterThan(0);
        expect(bytesRead).toBeLessThan(commandOutputBoundary);
        // An unsettled demand still needs exhaustion and must never turn an
        // incomplete traversal into a fabricated no-touch fact.
        expect(await history(['recent', 'missing', ''])).toMatchObject({ success: true, entries: [
            { path: 'recent', kind: 'commit', commit: { oid: recent } },
            { path: 'missing', kind: 'unavailable', reason: 'command_output_limit_exceeded' },
            { path: '', kind: 'commit', commit: { oid: recent } },
        ] });
    });
    it('keeps repository-relative literal identities when detection starts inside a workspace subdirectory', async () => {
        const repositoryFile = await commit('same', 'repository file');
        await mkdir(join(root, 'workspace'));
        const workspaceFile = await commit('workspace/same', 'workspace file');
        await mkdir(join(root, 'workspace', 'dir'));
        const descendant = await commit('workspace/dir/line\nbreak ', 'workspace descendant');
        const tip = await commit('outside', 'later repository sibling');
        const workspace = join(root, 'workspace');
        const response = await runWithRealGitScmRuntime(() => reads.gitHistoryEntries({
            context: { ...context(), cwd: workspace },
            request: { cwd: workspace, folder: '', paths: ['same', 'workspace/same', 'workspace/dir', 'workspace/dir/line\nbreak ', 'workspace'] },
        }));
        expect(response).toMatchObject({ success: true, headOid: tip, entries: [
            { path: 'same', kind: 'commit', commit: { oid: repositoryFile } },
            { path: 'workspace/same', kind: 'commit', commit: { oid: workspaceFile } },
            { path: 'workspace/dir', kind: 'commit', commit: { oid: descendant } },
            { path: 'workspace/dir/line\nbreak ', kind: 'commit', commit: { oid: descendant } },
            { path: 'workspace', kind: 'commit', commit: { oid: descendant } },
        ] });
    });
    it('does not mistake a missing detached HEAD object for an unborn branch', async () => {
        await commit('one', 'one');
        await writeFile(join(root, '.git', 'HEAD'), `${'f'.repeat(40)}\n`);
        expect(await history(['one'])).toMatchObject({ success: false, errorCode: 'COMMAND_FAILED' });
    });
    it.runIf(process.platform === 'win32')('resolves a canonical Windows workspace prefix to the actual Git path spelling', async () => {
        await mkdir(join(root, 'Sub'));
        const file = await commit('Sub/same', 'Windows workspace file');
        const tip = await commit('outside', 'later repository sibling');
        const workspace = join(root, 'Sub').toLowerCase();
        expect(await runWithRealGitScmRuntime(() => reads.gitHistoryEntries({
            context: { ...context(), cwd: workspace },
            request: { cwd: workspace, folder: 'sub', paths: ['sub/same', 'sub'] },
        }))).toMatchObject({ success: true, headOid: tip, entries: [
            { path: 'sub/same', kind: 'commit', commit: { oid: file } },
            { path: 'sub', kind: 'commit', commit: { oid: file } },
        ] });
    });
    it.runIf(process.platform === 'win32')('does not recover a Windows folder alias by following a junction target', async () => {
        await mkdir(join(root, 'target'));
        await commit('target/child', 'target history');
        const outside = await mkdtemp(join(tmpdir(), 'happier-entry-history-outside-'));
        roots.push(outside);
        for (const [alias, target] of [['inside-link', join(root, 'target')], ['outside-link', outside]] as const) {
            await symlink(target, join(root, alias), 'junction');
            expect(await runWithRealGitScmRuntime(() => reads.gitHistoryEntries({
                context: context(), request: { cwd: root, folder: alias, paths: [`${alias}/child`, alias] },
            }))).toMatchObject({ success: true, entries: [
                { kind: 'unavailable', reason: 'history_folder_unavailable' },
                { kind: 'unavailable', reason: 'history_folder_unavailable' },
            ] });
        }
    });
    it.runIf(process.platform === 'linux')('does not fold distinct Linux repository path identities', async () => {
        await mkdir(join(root, 'Sub'));
        const upper = await commit('Sub/same', 'upper directory');
        await mkdir(join(root, 'sub'));
        const lower = await commit('sub/same', 'lower directory');
        expect(await history(['Sub/same', 'sub/same'])).toMatchObject({ success: true, entries: [
            { path: 'Sub/same', kind: 'commit', commit: { oid: upper } },
            { path: 'sub/same', kind: 'commit', commit: { oid: lower } },
        ] });
    });
    it('pins the object once even when the branch moves during the pending read', async () => {
        const before = await commit('one', 'before');
        const services = createRealGitScmBackendRuntimeServices();
        let moved = false;
        const response = await runWithGitScmCommandRunner(async input => {
                const result = await ('stdoutConsumer' in input ? services.runCommandStreaming!(input) : services.runCommand(input));
                if (!moved && input.args.includes('HEAD^{commit}')) {
                    moved = true;
                    await commit('one', 'after');
                }
                return result;
            }, () => reads.gitHistoryEntries({ context: context(), request: { cwd: root, folder: '', paths: ['one'], headOid: before } }));
        expect(response).toMatchObject({ success: true, headOid: before, entries: [{ kind: 'commit', commit: { oid: before, subject: 'before' } }] });
        expect(git(root, ['rev-parse', 'HEAD'])).not.toBe(before);
    });
    it('preserves Unicode and literal newline paths when frames arrive one byte at a time', async () => {
        git(root, ['config', 'user.name', 'History 🧪 Author']);
        const path = 'é\nfile';
        const oid = await commit(path, 'Unicode 🧪 subject');
        const services = createRealGitScmBackendRuntimeServices();
        const response = await runWithGitScmCommandRunner(input => {
            if (!('stdoutConsumer' in input)) return services.runCommand(input);
            // Fragment the real OS boundary, retaining Git and parsing logic.
            return services.runCommandStreaming!({ ...input, stdoutConsumer: chunk => {
                for (let index = 0; index < chunk.byteLength; index += 1) {
                    if (input.stdoutConsumer(chunk.subarray(index, index + 1)) === 'stop') return 'stop';
                }
                return 'continue';
            } });
        }, () => reads.gitHistoryEntries({ context: context(), request: { cwd: root, folder: '', paths: [path] } }));
        expect(response).toMatchObject({ success: true, entries: [{ path, kind: 'commit',
            commit: { oid, subject: 'Unicode 🧪 subject', authorName: 'History 🧪 Author' } }] });
    });
    it('does not attribute shallow boundary inventory to that boundary commit', async () => {
        await commit('old', 'old root');
        const latest = await commit('new', 'new commit');
        const origin = root;
        root = await mkdtemp(join(tmpdir(), 'happier-entry-history-shallow-'));
        roots.push(root);
        git(origin, ['clone', '--depth=1', `file://${origin}`, root]);
        const response = await history(['old', 'new', 'unknown']);
        expect(response).toMatchObject({ success: true, headOid: latest, entries: [
            { path: 'old', kind: 'unavailable', reason: 'shallow_history' },
            { path: 'new', kind: 'unavailable', reason: 'shallow_history' },
            { path: 'unknown', kind: 'unavailable', reason: 'shallow_history' },
        ] });
        git(root, ['config', 'user.name', 'History Author']);
        git(root, ['config', 'user.email', 'history@example.test']);
        const above = await commit('new', 'above boundary');
        expect(await history(['new', 'old'])).toMatchObject({ success: true, headOid: above, entries: [
            { path: 'new', kind: 'commit', commit: { oid: above } },
            { path: 'old', kind: 'unavailable', reason: 'shallow_history' },
        ] });
    });
    it('uses the actual file/directory kind without following symlink targets or historical descendants', async () => {
        await mkdir(join(root, 'replaced'));
        await commit('replaced/child', 'old directory');
        await rm(join(root, 'replaced'), { recursive: true });
        await writeFile(join(root, 'replaced'), 'untracked file replacing directory');
        await mkdir(join(root, 'target'));
        await commit('target/child', 'target directory');
        await symlink('target', join(root, 'link'));
        expect(await history(['replaced', 'link'])).toMatchObject({ success: true, entries: [
            { path: 'replaced', kind: 'none' }, { path: 'link', kind: 'none' },
        ] });
    });
    it('returns unavailable for truncated frames, cancellation and the existing output boundary', async () => {
        await commit('one', 'one');
        const services = createRealGitScmBackendRuntimeServices();
        for (const mode of ['frame', 'cancel', 'limit']) {
            const controller = new AbortController();
            const response = await runWithGitScmCommandRunner(async input => {
                if (!input.args.includes('log')) return services.runCommand(input);
                if (mode === 'frame') {
                    if ('stdoutConsumer' in input) input.stdoutConsumer(Buffer.from('\0incomplete'));
                    return { success: true, stdout: '', stderr: '', exitCode: 0 };
                }
                if (mode === 'cancel') controller.abort();
                return { success: false, stdout: '', stderr: mode, exitCode: -1, ...(mode === 'limit' ? { outputLimitExceeded: true } : {}) };
            }, () => reads.gitHistoryEntries({ context: context(), signal: controller.signal, request: { cwd: root, folder: '', paths: ['one'] } }));
            const reason = mode === 'frame' ? 'invalid_history_output' : mode === 'cancel' ? 'cancelled' : 'command_output_limit_exceeded';
            expect(response).toMatchObject({ success: true, entries: [{ path: 'one', kind: 'unavailable', reason }] });
        }
    });
    it('uses path history without following old rename identities', async () => {
        const original = await commit('old-name', 'original');
        git(root, ['mv', 'old-name', 'new-name']);
        git(root, ['commit', '-m', 'rename']);
        const renamed = git(root, ['rev-parse', 'HEAD']);
        expect(await history(['old-name', 'new-name'])).toMatchObject({ success: true, entries: [
            { path: 'old-name', kind: 'commit', commit: { oid: renamed } },
            { path: 'new-name', kind: 'commit', commit: { oid: renamed } },
        ] });
        expect(renamed).not.toBe(original);
    });
});
