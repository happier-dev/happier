import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureScmComparison } from '../comparisons/captureScmComparison';
import { materializeScmCommitPlan, mergeScmCommitPlanHookTree, validateScmCommitPlanHookSelections } from './materializeCommitPlan';

const repositories: string[] = [];
function repository(content: string): string {
    const cwd = mkdtempSync(join(tmpdir(), 'happier-plan-materialization-'));
    repositories.push(cwd);
    git(cwd, ['init']); git(cwd, ['config', 'user.name', 'Materialization Test']);
    git(cwd, ['config', 'user.email', 'materialization@happier.dev']);
    writeFileSync(join(cwd, 'changes.txt'), content);
    git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'initial']);
    return cwd;
}
function git(cwd: string, args: string[], input?: string): string {
    return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
afterEach(() => { for (const cwd of repositories.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

describe('exact cumulative commit plan materialization', () => {
    it('materializes groups in reverse order and diffs each actual previous tree', async () => {
        const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
        const cwd = repository(before);
        const after = before.replace('line 4\n', 'first\n').replace('line 25\n', 'last\n');
        writeFileSync(join(cwd, 'changes.txt'), after);
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const refs = comparison.inventory.files[0]!.occurrences;
        expect(refs).toHaveLength(2);
        const indexBefore = readFileSync(join(cwd, '.git', 'index'));
        const headBefore = git(cwd, ['rev-parse', 'HEAD']);
        const result = await materializeScmCommitPlan({ cwd, comparison, groups: [
            { id: 'last', changeRefs: [refs[1]!.id] }, { id: 'first', changeRefs: [refs[0]!.id] },
        ] });
        expect(git(cwd, ['show', `${result.steps[0]!.targetTreeOid}:changes.txt`])).toBe(before.replace('line 25\n', 'last\n'));
        expect(git(cwd, ['show', `${result.steps[1]!.targetTreeOid}:changes.txt`])).toBe(after);
        const step = git(cwd, ['diff', result.steps[0]!.targetTreeOid, result.steps[1]!.targetTreeOid]);
        expect(step).toContain('+first');
        expect(step).not.toContain('+last');
        expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(indexBefore);
        expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(headBefore);
        expect(readFileSync(join(cwd, 'changes.txt'), 'utf8')).toBe(after);
    });
    it('distinguishes repeated hunk bodies by their captured occurrence', async () => {
        const lines = Array.from({ length: 40 }, (_, index) => `context ${index % 10}\n`);
        const cwd = repository(lines.join(''));
        lines[5] = 'changed\n'; lines[25] = 'changed\n';
        writeFileSync(join(cwd, 'changes.txt'), lines.join(''));
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const refs = comparison.inventory.files[0]!.occurrences;
        const result = await materializeScmCommitPlan({ cwd, comparison,
            groups: [{ id: 'second', changeRefs: [refs[1]!.id] }] });
        lines[5] = 'context 5\n';
        expect(git(cwd, ['show', `${result.steps[0]!.targetTreeOid}:changes.txt`])).toBe(lines.join(''));
    });
    it('refuses duplicate references and aliases as authority', async () => {
        const cwd = repository('before\n');
        writeFileSync(join(cwd, 'changes.txt'), 'after\n');
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const occurrence = comparison.inventory.files[0]!.occurrences[0]!;
        await expect(materializeScmCommitPlan({ cwd, comparison, groups: [
            { id: 'one', changeRefs: [occurrence.id] }, { id: 'two', changeRefs: [occurrence.id] },
        ] })).rejects.toMatchObject({ reason: 'duplicate_selection' });
        await expect(materializeScmCommitPlan({ cwd, comparison,
            groups: [{ id: 'alias', changeRefs: [occurrence.alias] }] })).rejects.toMatchObject({ reason: 'foreign_selection' });
    });
    it('does not silently include an unselected staged prerequisite', async () => {
        const cwd = repository('before\n');
        writeFileSync(join(cwd, 'changes.txt'), 'staged\n'); git(cwd, ['add', '.']);
        writeFileSync(join(cwd, 'changes.txt'), 'unstaged\n');
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const [staged, unstaged] = comparison.inventory.files[0]!.occurrences;
        await expect(materializeScmCommitPlan({ cwd, comparison,
            groups: [{ id: 'unsafe', changeRefs: [unstaged!.id] }] })).rejects.toMatchObject({ reason: 'unrepresentable_selection', changeRefs: [staged!.id] });
        const result = await materializeScmCommitPlan({ cwd, comparison, groups: [
            { id: 'staged', changeRefs: [staged!.id] }, { id: 'unstaged', changeRefs: [unstaged!.id] },
        ] });
        expect(git(cwd, ['show', `${result.steps[0]!.targetTreeOid}:changes.txt`])).toBe('staged\n');
        expect(git(cwd, ['show', `${result.steps[1]!.targetTreeOid}:changes.txt`])).toBe('unstaged\n');
    });
    it.each(['insertion', 'deletion'] as const)('maps an unstaged selection past a left-out staged %s and permits reversed group order', async (kind) => {
        const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join('');
        const cwd = repository(before);
        const stagedText = kind === 'insertion' ? before.replace('line 4\n', 'line 4\nstaged inserted\n') : before.replace('line 4\n', '');
        writeFileSync(join(cwd, 'changes.txt'), stagedText); git(cwd, ['add', '.']);
        const after = stagedText.replace('line 30\n', 'unstaged only\n');
        writeFileSync(join(cwd, 'changes.txt'), after);
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const refs = comparison.inventory.files[0]!.occurrences;
        const staged = refs.find((ref) => ref.layer === 'staged')!;
        const unstaged = refs.find((ref) => ref.layer === 'unstaged')!;
        const indexBefore = readFileSync(join(cwd, '.git', 'index'));
        const only = await materializeScmCommitPlan({ cwd, comparison, groups: [{ id: 'unstaged', changeRefs: [unstaged.id] }] });
        expect(git(cwd, ['show', `${only.steps[0]!.targetTreeOid}:changes.txt`])).toBe(before.replace('line 30\n', 'unstaged only\n'));
        const reversed = await materializeScmCommitPlan({ cwd, comparison, groups: [
            { id: 'unstaged', changeRefs: [unstaged.id] }, { id: 'staged', changeRefs: [staged.id] },
        ] });
        expect(reversed.steps[0]!.targetTreeOid).toBe(only.steps[0]!.targetTreeOid);
        expect(git(cwd, ['show', `${reversed.steps[1]!.targetTreeOid}:changes.txt`])).toBe(after);
        expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(indexBefore);
        expect(readFileSync(join(cwd, 'changes.txt'), 'utf8')).toBe(after);
    });
    it('does not import a left-out staged edit through unstaged hunk context', async () => {
        const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`).join('');
        const cwd = repository(before);
        const stagedText = before.replace('line 5\n', 'staged context\n');
        writeFileSync(join(cwd, 'changes.txt'), stagedText); git(cwd, ['add', '.']);
        writeFileSync(join(cwd, 'changes.txt'), stagedText.replace('line 7\n', 'selected unstaged\n'));
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const ref = comparison.inventory.files[0]!.occurrences.find((ref) => ref.layer === 'unstaged')!;
        const result = await materializeScmCommitPlan({ cwd, comparison, groups: [{ id: 'unstaged', changeRefs: [ref.id] }] });
        expect(git(cwd, ['show', `${result.steps[0]!.targetTreeOid}:changes.txt`])).toBe(before.replace('line 7\n', 'selected unstaged\n'));
    });
    it('materializes adjacent staged and unstaged additions as successive exact trees', async () => {
        const cwd = repository('before\nafter\n');
        writeFileSync(join(cwd, 'changes.txt'), 'before\nfirst\nafter\n'); git(cwd, ['add', '.']);
        writeFileSync(join(cwd, 'changes.txt'), 'before\nfirst\nsecond\nafter\n');
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const refs = comparison.inventory.files[0]!.occurrences;
        const result = await materializeScmCommitPlan({ cwd, comparison, groups: [
            { id: 'first', changeRefs: [refs[0]!.id] }, { id: 'second', changeRefs: [refs[1]!.id] },
        ] });
        expect(git(cwd, ['show', `${result.steps[0]!.targetTreeOid}:changes.txt`])).toBe('before\nfirst\nafter\n');
        expect(git(cwd, ['show', `${result.steps[1]!.targetTreeOid}:changes.txt`])).toBe('before\nfirst\nsecond\nafter\n');
        const patch = git(cwd, ['diff', result.steps[0]!.targetTreeOid, result.steps[1]!.targetTreeOid]);
        expect(patch).toContain('+second\n');
        expect(patch).not.toContain('+first\n');
    });
    it('materializes whole-file binary and untracked selections using captured objects', async () => {
        const cwd = repository('base\n');
        writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 255, 23, 0]));
        writeFileSync(join(cwd, 'new.txt'), 'new file');
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const result = await materializeScmCommitPlan({ cwd, comparison,
            groups: [{ id: 'files', changeRefs: comparison.inventory.files.flatMap((file) => file.occurrences.map((ref) => ref.id)) }] });
        expect(execFileSync('git', ['show', `${result.steps[0]!.targetTreeOid}:binary.bin`], { cwd })).toEqual(Buffer.from([0, 255, 23, 0]));
        expect(git(cwd, ['show', `${result.steps[0]!.targetTreeOid}:new.txt`])).toBe('new file');
    });
    it('carries accepted hook additions into later trees and refuses collisions', async () => {
        const cwd = repository('base\n');
        const originalTreeOid = git(cwd, ['rev-parse', 'HEAD^{tree}']).trim();
        writeFileSync(join(cwd, 'hook.txt'), 'accepted hook\n'); git(cwd, ['add', '.']);
        const acceptedHookTreeOid = git(cwd, ['write-tree']).trim();
        git(cwd, ['read-tree', originalTreeOid]);
        writeFileSync(join(cwd, 'changes.txt'), 'later\n'); git(cwd, ['add', 'changes.txt']);
        const targetTreeOid = git(cwd, ['write-tree']).trim();
        const indexBefore = readFileSync(join(cwd, '.git', 'index'));
        const refsBefore = git(cwd, ['show-ref']);
        const merged = await mergeScmCommitPlanHookTree({ cwd, originalTreeOid, acceptedHookTreeOid, targetTreeOid });
        expect(git(cwd, ['show', `${merged.targetTreeOid}:hook.txt`])).toBe('accepted hook\n');
        expect(git(cwd, ['show', `${merged.targetTreeOid}:changes.txt`])).toBe('later\n');
        expect(readFileSync(join(cwd, '.git', 'index'))).toEqual(indexBefore);
        expect(git(cwd, ['show-ref'])).toBe(refsBefore);
        git(cwd, ['read-tree', originalTreeOid]);
        writeFileSync(join(cwd, 'changes.txt'), 'hook collision\n'); git(cwd, ['add', 'changes.txt']);
        await expect(mergeScmCommitPlanHookTree({ cwd, originalTreeOid,
            acceptedHookTreeOid: git(cwd, ['write-tree']).trim(), targetTreeOid })).rejects.toMatchObject({ reason: 'overlapping_selection', path: 'changes.txt' });
    });
    it('rejects stale range identities before producing any target tree', async () => {
        const cwd = repository('before\n');
        writeFileSync(join(cwd, 'changes.txt'), 'after\n');
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const ref = comparison.inventory.files[0]!.occurrences[0]!;
        ref.before.startLine++;
        await expect(materializeScmCommitPlan({ cwd, comparison,
            groups: [{ id: 'stale', changeRefs: [ref.id] }] })).rejects.toMatchObject({ reason: 'stale_evidence' });
    });
    it('preserves exact rename, deletion and executable modes', async () => {
        const cwd = repository('rename me\n');
        writeFileSync(join(cwd, 'deleted.txt'), 'delete me\n');
        writeFileSync(join(cwd, 'mode.txt'), 'keep mode\n');
        git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'metadata base']);
        renameSync(join(cwd, 'changes.txt'), join(cwd, 'renamed café.txt'));
        unlinkSync(join(cwd, 'deleted.txt'));
        git(cwd, ['add', '.']); git(cwd, ['update-index', '--chmod=+x', 'mode.txt']);
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const staged = comparison.inventory.files.flatMap((file) => file.occurrences.filter((ref) => ref.layer === 'staged').map((ref) => ref.id));
        const result = await materializeScmCommitPlan({ cwd, comparison, groups: [{ id: 'metadata', changeRefs: staged }] });
        const target = result.steps[0]!.targetTreeOid;
        expect(git(cwd, ['show', `${target}:renamed café.txt`])).toBe('rename me\n');
        expect(git(cwd, ['ls-tree', target, '--', 'deleted.txt', 'changes.txt'])).toBe('');
        expect(git(cwd, ['ls-tree', target, '--', 'mode.txt'])).toMatch(/^100755 /);
    });
    it('splits text hunks without changing missing final newline or CRLF bytes', async () => {
        const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\r\n`).join('').replace(/\r\n$/, '');
        const cwd = repository(before);
        const after = before.replace('line 4\r\n', 'first\r\n').replace('line 30', 'last');
        writeFileSync(join(cwd, 'changes.txt'), after);
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const refs = comparison.inventory.files[0]!.occurrences;
        const result = await materializeScmCommitPlan({ cwd, comparison,
            groups: [{ id: 'last', changeRefs: [refs[1]!.id] }] });
        expect(git(cwd, ['show', `${result.steps[0]!.targetTreeOid}:changes.txt`])).toBe(before.replace('line 30', 'last'));
    });
    it('materializes an exact copy without deleting or including modifications to its source', async () => {
        const cwd = repository('rename me\n');
        renameSync(join(cwd, 'changes.txt'), join(cwd, 'renamed.txt'));
        writeFileSync(join(cwd, 'changes.txt'), 'new original path\n'); git(cwd, ['add', '.']);
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const file = comparison.inventory.files.find((file) => file.path === 'renamed.txt')!;
        expect(file.changeKind).toBe('copied');
        const source = comparison.inventory.files.find((file) => file.path === 'changes.txt')!;
        const result = await materializeScmCommitPlan({ cwd, comparison, groups: [
            { id: 'copy', changeRefs: file.occurrences.map((ref) => ref.id) },
            { id: 'source', changeRefs: source.occurrences.map((ref) => ref.id) },
        ] });
        const copied = result.steps[0]!.targetTreeOid;
        expect(git(cwd, ['ls-tree', copied, '--', 'changes.txt'])).not.toBe('');
        expect(git(cwd, ['show', `${copied}:changes.txt`])).toBe('rename me\n');
        expect(git(cwd, ['show', `${copied}:renamed.txt`])).toBe('rename me\n');
        const modified = result.steps[1]!.targetTreeOid;
        expect(git(cwd, ['show', `${modified}:changes.txt`])).toBe('new original path\n');
        expect(git(cwd, ['show', `${modified}:renamed.txt`])).toBe('rename me\n');
    });
    it('does not let a configured union driver silently resolve accepted-hook collisions', async () => {
        const cwd = repository('base\n');
        writeFileSync(join(cwd, '.gitattributes'), 'changes.txt merge=union\n');
        git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'union attribute']);
        const originalTreeOid = git(cwd, ['write-tree']).trim();
        writeFileSync(join(cwd, 'changes.txt'), 'accepted hook\n'); git(cwd, ['add', '.']);
        const acceptedHookTreeOid = git(cwd, ['write-tree']).trim();
        writeFileSync(join(cwd, 'changes.txt'), 'remaining group\n'); git(cwd, ['add', '.']);
        const targetTreeOid = git(cwd, ['write-tree']).trim();
        await expect(mergeScmCommitPlanHookTree({ cwd, originalTreeOid, acceptedHookTreeOid, targetTreeOid }))
            .rejects.toMatchObject({ reason: 'unrepresentable_selection', path: 'changes.txt' });
    });
    it('allows separate same-file hook edits but rejects early inclusion of a future exact selection', async () => {
        const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('');
        const cwd = repository(before);
        writeFileSync(join(cwd, 'changes.txt'), before.replace('line 25\n', 'future\n'));
        const { comparison } = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
        const changeRefs = comparison.inventory.files[0]!.occurrences.map((ref) => ref.id);
        const targets = await materializeScmCommitPlan({ cwd, comparison, groups: [{ id: 'future', changeRefs }] });
        writeFileSync(join(cwd, 'changes.txt'), before.replace('line 4\n', 'hook\n')); git(cwd, ['add', '.']);
        const acceptedHookTreeOid = git(cwd, ['write-tree']).trim();
        await expect(validateScmCommitPlanHookSelections({ cwd, comparison, originalTreeOid: targets.baseTreeOid,
            acceptedHookTreeOid, remainingSteps: targets.steps.map((step) => ({ ...step, changeRefs })) })).resolves.toBeUndefined();
        await expect(validateScmCommitPlanHookSelections({ cwd, comparison, originalTreeOid: targets.baseTreeOid,
            acceptedHookTreeOid: targets.steps[0]!.targetTreeOid,
            remainingSteps: targets.steps.map((step) => ({ ...step, changeRefs })) }))
            .rejects.toMatchObject({ reason: 'overlapping_selection', path: 'changes.txt', changeRefs });
    });
});
