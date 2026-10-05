import { createGitTemporaryIndex } from '@happier-dev/cli-common/scm/gitTemporaryIndex';
import { buildScmComparisonIdentity, type ScmChangeOccurrence, type ScmComparison } from '@happier-dev/protocol';
import { runGitCheckpointCommand } from '../checkpoints/gitCheckpointCommands';
import { readGitCheckpointDiffOutput } from '../checkpoints/gitCheckpointDiffOutput';
import { encodeRepositoryCheckpointScope } from '../checkpoints/refs';
import { readGitComparisonFiles, type GitComparisonFile } from '../comparisons/readGitComparisonFiles';

export type ScmCommitPlanMaterializationConflictReason = 'foreign_selection' | 'duplicate_selection'
    | 'overlapping_selection' | 'stale_evidence' | 'unrepresentable_selection';

export class ScmCommitPlanMaterializationConflict extends Error {
    readonly code = 'SCM_COMMIT_PLAN_SELECTION_CONFLICT';
    constructor(readonly reason: ScmCommitPlanMaterializationConflictReason, message: string,
        readonly path?: string, readonly changeRefs: readonly string[] = []) {
        super(message); this.name = 'ScmCommitPlanMaterializationConflict';
    }
}

export async function validateScmCommitPlanHookSelections(input: Readonly<{
    cwd: string; comparison: ScmComparison; originalTreeOid: string; acceptedHookTreeOid: string;
    remainingSteps: readonly Readonly<{ groupId: string; changeRefs: readonly string[]; targetTreeOid: string }>[];
}>): Promise<void> {
    const original = await tree(input.cwd, input.originalTreeOid);
    const accepted = await tree(input.cwd, input.acceptedHookTreeOid);
    const hooks = await treeEdits(input.cwd, original, accepted);
    const occurrences = new Map(input.comparison.inventory.files.flatMap((file) => file.occurrences.map((ref) => [ref.id, ref] as const)));
    for (const step of input.remainingSteps) {
        for (const id of step.changeRefs) if (!occurrences.has(id)) {
            throw new ScmCommitPlanMaterializationConflict('foreign_selection', 'Remaining hook-check selection is outside the comparison', undefined, [id]);
        }
        const future = await treeEdits(input.cwd, original, await tree(input.cwd, step.targetTreeOid));
        for (const hook of hooks) for (const edit of future) {
            const paths = hook.paths.filter((path) => edit.paths.includes(path));
            if (!paths.length || (!hook.wholeFile && !edit.wholeFile
                && !hook.hunks.some((left) => edit.hunks.some((right) => rangesOverlap(left.before, right.before))))) continue;
            const refs = step.changeRefs.filter((id) => {
                const ref = occurrences.get(id)!;
                return paths.includes(ref.path) || (ref.previousPath !== undefined && paths.includes(ref.previousPath));
            });
            if (refs.length) throw new ScmCommitPlanMaterializationConflict('overlapping_selection',
                `Accepted hook changes overlap selections reserved for remaining group ${step.groupId}`, paths[0], refs);
        }
    }
}

type TreeEntry = Readonly<{ mode: string; oid: string }>;
type Hunk = Readonly<{ before: ScmChangeOccurrence['before']; after: ScmChangeOccurrence['after']; oldLines: readonly string[]; newLines: readonly string[];
    body: readonly Readonly<{ kind: ' ' | '-' | '+'; text: string }>[] }>;
type TextEdit = Readonly<{ beforeOffset: number; afterOffset: number; oldLines: readonly string[]; newLines: readonly string[]; changeRef: string }>;
type LayerFile = Readonly<{ file: GitComparisonFile; beforeTree: string; afterTree: string;
    layer: 'staged' | 'unstaged' | 'untracked'; occurrences: readonly ScmChangeOccurrence[]; hunks: readonly Hunk[] }>;

function rangesOverlap(left: ScmChangeOccurrence['before'], right: ScmChangeOccurrence['before']): boolean {
    const start = (range: ScmChangeOccurrence['before']) => range.lineCount ? range.startLine - 1 : range.startLine;
    const a = start(left); const b = start(right);
    if (!left.lineCount && !right.lineCount) return a === b;
    if (!left.lineCount) return a >= b && a <= b + right.lineCount;
    if (!right.lineCount) return b >= a && b <= a + left.lineCount;
    return Math.max(a, b) < Math.min(a + left.lineCount, b + right.lineCount);
}

async function treeEdits(cwd: string, before: string, after: string): Promise<readonly Readonly<{
    paths: readonly string[]; wholeFile: boolean; hunks: readonly Hunk[];
}>[]> {
    const read = await readGitComparisonFiles({ cwd, before, after });
    if (!read.enumerationComplete || read.reasons.length) throw new ScmCommitPlanMaterializationConflict('stale_evidence', read.reasons.join('\n') || 'Hook selection comparison is unavailable');
    return Promise.all(read.files.map(async (file) => {
        const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
        const source = await entry(cwd, before, file.previousPath ?? file.path);
        const destination = await entry(cwd, after, file.path);
        const wholeFile = file.changeKind !== 'modified' || file.binary !== false || source?.mode !== destination?.mode;
        if (wholeFile) return { paths, wholeFile, hunks: [] };
        const diff = await readGitCheckpointDiffOutput({ cwd, args: ['--binary', '--full-index', '--unified=0', before, after, '--', ...paths] });
        if (!diff.success) throw new ScmCommitPlanMaterializationConflict('stale_evidence', diff.stderr || 'Exact hook edit coordinates could not be read', file.path);
        return { paths, wholeFile, hunks: parseHunks(diff.stdout) };
    }));
}

async function assertNativeHookMergeDrivers(cwd: string, original: string, accepted: string, target: string): Promise<void> {
    const hooks = await treeEdits(cwd, original, accepted);
    const future = await treeEdits(cwd, original, target);
    const paths = [...new Set(hooks.flatMap((hook) => hook.paths).filter((path) => future.some((edit) => edit.paths.includes(path))))];
    if (!paths.length) return;
    const configured = await runGitCheckpointCommand({ cwd, args: ['config', '--get', 'merge.default'] });
    if (!configured.success && configured.exitCode !== 1) throw new ScmCommitPlanMaterializationConflict('stale_evidence', configured.stderr || 'Default merge-driver configuration is unavailable');
    const defaultDriver = configured.success ? configured.stdout.trim() : 'text';
    const created = await createGitTemporaryIndex({ cwd, seed: { kind: 'tree', treeOid: original }, runGit: runGitCheckpointCommand });
    if (!created.success) throw new ScmCommitPlanMaterializationConflict('stale_evidence', created.error);
    try {
        for (const treeOid of [original, accepted, target]) {
            await git(cwd, ['read-tree', treeOid], { env: created.tempIndex.env });
            const attributes = (await git(cwd, ['check-attr', '--cached', '-z', 'merge', '--', ...paths], { env: created.tempIndex.env })).split('\0');
            for (let i = 0; i + 2 < attributes.length; i += 3) {
                const value = attributes[i + 2];
                const driver = value === 'unspecified' ? defaultDriver : value === 'set' ? 'text' : value === 'unset' ? 'binary' : value;
                if (driver !== 'text' && driver !== 'binary') throw new ScmCommitPlanMaterializationConflict('unrepresentable_selection',
                    'Configured merge driver can silently resolve accepted-hook selection conflicts; reselect these changes', attributes[i]);
            }
        }
    } finally { created.tempIndex.cleanup(); }
}

async function git(cwd: string, args: readonly string[], options: Readonly<{ stdin?: string; env?: Record<string, string> }> = {}): Promise<string> {
    const result = await runGitCheckpointCommand({ cwd, args, ...options });
    if (!result.success) throw new ScmCommitPlanMaterializationConflict('stale_evidence', result.stderr || 'Captured Git objects could not be read');
    return result.stdout;
}

async function tree(cwd: string, oid: string | undefined): Promise<string> {
    if (!oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) {
        throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'An immutable captured tree endpoint is required');
    }
    return (await git(cwd, ['rev-parse', '--verify', `${oid}^{tree}`])).trim();
}

async function entry(cwd: string, treeOid: string, path: string): Promise<TreeEntry | undefined> {
    const entries = (await git(cwd, ['ls-tree', '-z', treeOid, '--', path])).split('\0');
    for (const value of entries) {
        const match = /^(\d+) (?:blob|commit|tree) ([a-f0-9]+)\t([\s\S]*)$/.exec(value);
        if (match?.[3] === path) return { mode: match[1]!, oid: match[2]! };
    }
    return undefined;
}

function parseHunks(patch: string): Hunk[] {
    const lines = patch.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const hunks: Hunk[] = [];
    let current: { before: ScmChangeOccurrence['before']; after: ScmChangeOccurrence['after']; oldLines: string[]; newLines: string[];
        body: Array<{ kind: ' ' | '-' | '+'; text: string }> } | undefined;
    let previousPrefix = '';
    for (const line of lines) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            current = { before: { startLine: Number(header[1]), lineCount: Number(header[2] ?? 1) },
                after: { startLine: Number(header[3]), lineCount: Number(header[4] ?? 1) }, oldLines: [], newLines: [], body: [] };
            hunks.push(current); previousPrefix = ''; continue;
        }
        if (!current) continue;
        const prefix = line[0];
        if (prefix === '\\') {
            if (previousPrefix === ' ' || previousPrefix === '-') current.oldLines[current.oldLines.length - 1] = current.oldLines.at(-1)!.replace(/\n$/, '');
            if (previousPrefix === ' ' || previousPrefix === '+') current.newLines[current.newLines.length - 1] = current.newLines.at(-1)!.replace(/\n$/, '');
            if (current.body.length) current.body.at(-1)!.text = current.body.at(-1)!.text.replace(/\n$/, '');
        } else if (prefix === ' ' || prefix === '-' || prefix === '+') {
            if (prefix !== '+') current.oldLines.push(line.slice(1));
            if (prefix !== '-') current.newLines.push(line.slice(1));
            current.body.push({ kind: prefix, text: line.slice(1) });
            previousPrefix = prefix;
        }
    }
    for (const hunk of hunks) if (hunk.oldLines.length !== hunk.before.lineCount || hunk.newLines.length !== hunk.after.lineCount) {
        throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Captured hunk counts do not match the exact patch');
    }
    return hunks;
}

function hunkEdits(hunk: Hunk, changeRef: string): TextEdit[] {
    let beforeOffset = hunk.before.lineCount ? hunk.before.startLine - 1 : hunk.before.startLine;
    let afterOffset = hunk.after.lineCount ? hunk.after.startLine - 1 : hunk.after.startLine;
    const edits: TextEdit[] = [];
    let edit: { beforeOffset: number; afterOffset: number; oldLines: string[]; newLines: string[]; changeRef: string } | undefined;
    for (const line of hunk.body) {
        if (line.kind === ' ') {
            edit = undefined; beforeOffset++; afterOffset++; continue;
        }
        if (!edit) { edit = { beforeOffset, afterOffset, oldLines: [], newLines: [], changeRef }; edits.push(edit); }
        if (line.kind === '-') { edit.oldLines.push(line.text); beforeOffset++; }
        else { edit.newLines.push(line.text); afterOffset++; }
    }
    return edits;
}

function applyTextEdits(lines: readonly string[], edits: readonly TextEdit[], path: string): string {
    let previousEnd = 0;
    const output: string[] = [];
    for (const edit of [...edits].sort((a, b) => a.beforeOffset - b.beforeOffset)) {
        const offset = edit.beforeOffset;
        if (offset < previousEnd) throw new ScmCommitPlanMaterializationConflict('overlapping_selection', 'Selected source edits overlap', path, [edit.changeRef]);
        if (offset < 0 || offset + edit.oldLines.length > lines.length || lines.slice(offset, offset + edit.oldLines.length).join('') !== edit.oldLines.join('')) {
            throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Selected edit does not match its exact source coordinates', path, [edit.changeRef]);
        }
        output.push(lines.slice(previousEnd, offset).join(''), edit.newLines.join(''));
        previousEnd = offset + edit.oldLines.length;
    }
    output.push(lines.slice(previousEnd).join(''));
    return output.join('');
}

async function blobText(cwd: string, oid: string): Promise<string> {
    const emptyBlob = (await git(cwd, ['hash-object', '-w', '--stdin'], { stdin: '' })).trim();
    // The existing disk-streaming reader avoids stdout truncation and split UTF-8 chunks.
    const read = await readGitCheckpointDiffOutput({ cwd, args: ['--text', '--unified=0', emptyBlob, oid] });
    if (!read.success) throw new ScmCommitPlanMaterializationConflict('stale_evidence', read.stderr || 'Captured blob could not be read');
    const text = parseHunks(read.stdout).flatMap((hunk) => hunk.newLines).join('');
    const roundtrip = (await git(cwd, ['hash-object', '--stdin'], { stdin: text })).trim();
    if (roundtrip !== oid) throw new ScmCommitPlanMaterializationConflict('unrepresentable_selection', 'This blob cannot be split as lossless UTF-8 text');
    return text;
}

async function selectedEntry(cwd: string, input: LayerFile, selected: ReadonlySet<string>): Promise<TreeEntry | undefined> {
    const refs = input.occurrences.filter((occurrence) => selected.has(occurrence.id));
    const source = await entry(cwd, input.beforeTree, input.file.previousPath ?? input.file.path);
    const destination = await entry(cwd, input.afterTree, input.file.path);
    if (refs.length === input.occurrences.length) return destination;
    if (!source || !destination || source.mode !== destination.mode || !['100644', '100755'].includes(source.mode)
        || input.file.binary || input.file.previousPath || input.file.changeKind !== 'modified' || !input.hunks.length) {
        throw new ScmCommitPlanMaterializationConflict('unrepresentable_selection', 'This file metadata change requires all of its captured occurrences', input.file.path, refs.map((ref) => ref.id));
    }
    const lines = (await blobText(cwd, source.oid)).match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const edits = refs.flatMap((ref) => hunkEdits(input.hunks[ref.position]!, ref.id));
    const oid = (await git(cwd, ['hash-object', '-w', '--stdin'], { stdin: applyTextEdits(lines, edits, input.file.path) })).trim();
    return { mode: source.mode, oid };
}

/** Map index-source lines through captured staged edits, never through content search. */
async function selectedUnstagedSubset(cwd: string, input: LayerFile, staged: readonly LayerFile[], selected: ReadonlySet<string>): Promise<TreeEntry> {
    const dependencies = staged.flatMap((layer) => layer.occurrences.filter((ref) => !selected.has(ref.id)).map((ref) => ref.id));
    const conflict = (refs: readonly string[] = dependencies): never => {
        throw new ScmCommitPlanMaterializationConflict('unrepresentable_selection',
            'Selected unstaged source lines or boundaries depend on excluded staged occurrences', input.file.path, refs);
    };
    if (staged.length !== 1 || input.file.changeKind !== 'modified' || input.file.previousPath || input.file.binary || !input.hunks.length) return conflict();
    const layer = staged[0]!;
    if (layer.file.changeKind !== 'modified' || layer.file.previousPath || layer.file.binary || !layer.hunks.length || !layer.file.beforeBlobId || !layer.file.afterBlobId) return conflict();
    const source = await entry(cwd, layer.beforeTree, layer.file.path);
    const index = await entry(cwd, layer.afterTree, layer.file.path);
    const destination = await entry(cwd, input.afterTree, input.file.path);
    if (!source || !index || !destination || source.mode !== index.mode || index.mode !== destination.mode || !['100644', '100755'].includes(source.mode)) return conflict();
    const before = (await blobText(cwd, source.oid)).match(/[^\n]*\n|[^\n]+$/g) ?? [];
    type SourceLine = Readonly<{ text: string; currentLine: number }> | Readonly<{ text: string; dependency: string }>;
    const indexLines: SourceLine[] = [];
    const currentLines: string[] = [];
    const restoredGaps = new Map<number, string[]>();
    let previousEnd = 0;
    const unchanged = (until: number) => {
        for (let i = previousEnd; i < until; i++) { indexLines.push({ text: before[i]!, currentLine: currentLines.length }); currentLines.push(before[i]!); }
    };
    const stagedEdits = layer.occurrences.flatMap((ref) => hunkEdits(layer.hunks[ref.position]!, ref.id));
    for (const edit of stagedEdits) {
        if (edit.beforeOffset < previousEnd || before.slice(edit.beforeOffset, edit.beforeOffset + edit.oldLines.length).join('') !== edit.oldLines.join('')) {
            throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Staged edit no longer matches its immutable original lines', input.file.path, [edit.changeRef]);
        }
        unchanged(edit.beforeOffset);
        if (indexLines.length !== edit.afterOffset) throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Staged edit coordinates do not identify the captured index source', input.file.path, [edit.changeRef]);
        if (selected.has(edit.changeRef)) {
            for (const text of edit.newLines) { indexLines.push({ text, currentLine: currentLines.length }); currentLines.push(text); }
        } else {
            if (edit.oldLines.length && !edit.newLines.length) restoredGaps.set(indexLines.length, [...(restoredGaps.get(indexLines.length) ?? []), edit.changeRef]);
            for (const text of edit.oldLines) currentLines.push(text);
            for (const text of edit.newLines) indexLines.push({ text, dependency: edit.changeRef });
        }
        previousEnd = edit.beforeOffset + edit.oldLines.length;
    }
    unchanged(before.length);
    if ((await git(cwd, ['hash-object', '--stdin'], { stdin: indexLines.map((line) => line.text).join('') })).trim() !== index.oid) {
        throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Captured staged edit map does not reconstruct its immutable index blob', input.file.path);
    }
    const refs = input.occurrences.filter((ref) => selected.has(ref.id));
    const mappedEdits: TextEdit[] = [];
    for (const edit of refs.flatMap((ref) => hunkEdits(input.hunks[ref.position]!, ref.id))) {
        const start = edit.beforeOffset; const end = start + edit.oldLines.length;
        if (start < 0 || end > indexLines.length || indexLines.slice(start, end).map((line) => line.text).join('') !== edit.oldLines.join('')) {
            throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Unstaged edit does not match its immutable index source', input.file.path, [edit.changeRef]);
        }
        const involved = edit.oldLines.length ? indexLines.slice(start, end) : indexLines.slice(Math.max(0, start - 1), Math.min(indexLines.length, start + 1));
        const missing = involved.flatMap((line) => 'dependency' in line ? [line.dependency] : []);
        for (const [boundary, ids] of restoredGaps) if (edit.oldLines.length ? boundary > start && boundary < end : boundary === start) missing.push(...ids);
        if (missing.length) return conflict([...new Set(missing)]);
        let offset: number;
        if (edit.oldLines.length) {
            const first = indexLines[start]!;
            if (!('currentLine' in first)) return conflict();
            offset = first.currentLine;
            if (involved.some((line, i) => !('currentLine' in line) || line.currentLine !== offset + i)) return conflict();
        } else {
            const left = indexLines[start - 1]; const right = indexLines[start];
            offset = left && 'currentLine' in left ? left.currentLine + 1 : 0;
            const next = right && 'currentLine' in right ? right.currentLine : currentLines.length;
            if (offset !== next) return conflict();
        }
        mappedEdits.push({ ...edit, beforeOffset: offset });
    }
    const oid = (await git(cwd, ['hash-object', '-w', '--stdin'], { stdin: applyTextEdits(currentLines, mappedEdits, input.file.path) })).trim();
    return { mode: source.mode, oid };
}

export async function mergeScmCommitPlanHookTree(input: Readonly<{
    cwd: string; originalTreeOid: string; acceptedHookTreeOid: string; targetTreeOid: string;
}>): Promise<Readonly<{ targetTreeOid: string }>> {
    const original = await tree(input.cwd, input.originalTreeOid);
    const accepted = await tree(input.cwd, input.acceptedHookTreeOid);
    const target = await tree(input.cwd, input.targetTreeOid);
    if (original === accepted) return { targetTreeOid: target };
    if (original === target) return { targetTreeOid: accepted };
    await assertNativeHookMergeDrivers(input.cwd, original, accepted, target);
    // These unreferenced objects only let Git's merge owner compare immutable trees.
    // They are never publication candidates and do not run hooks or sign.
    const env = { GIT_AUTHOR_NAME: 'Happier tree comparison', GIT_AUTHOR_EMAIL: 'tree-comparison@happier.dev',
        GIT_COMMITTER_NAME: 'Happier tree comparison', GIT_COMMITTER_EMAIL: 'tree-comparison@happier.dev' };
    const base = (await git(input.cwd, ['-c', 'commit.gpgSign=false', 'commit-tree', original], { env, stdin: 'Tree comparison base\n' })).trim();
    const left = (await git(input.cwd, ['-c', 'commit.gpgSign=false', 'commit-tree', accepted, '-p', base], { env, stdin: 'Accepted hook tree\n' })).trim();
    const right = (await git(input.cwd, ['-c', 'commit.gpgSign=false', 'commit-tree', target, '-p', base], { env, stdin: 'Remaining accepted tree\n' })).trim();
    const merged = await runGitCheckpointCommand({ cwd: input.cwd, args: ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', left, right] });
    if (!merged.success) throw new ScmCommitPlanMaterializationConflict(merged.exitCode === 1 ? 'overlapping_selection' : 'unrepresentable_selection',
        merged.exitCode === 1 ? 'Accepted hook changes conflict with a remaining commit group; reselect the remaining changes'
            : merged.stderr || 'This Git executable could not merge the accepted hook tree',
        merged.exitCode === 1 ? merged.stdout.split('\0')[1] || undefined : undefined);
    return { targetTreeOid: await tree(input.cwd, merged.stdout.split('\0')[0]?.trim()) };
}

export async function materializeScmCommitPlan(input: Readonly<{
    cwd: string; comparison: ScmComparison; sessionId?: string;
    groups: readonly Readonly<{ id: string; changeRefs: readonly string[] }>[];
}>): Promise<Readonly<{ baseTreeOid: string; indexTreeOid: string; steps: readonly Readonly<{ groupId: string; targetTreeOid: string }>[] }>> {
    const { cwd, comparison } = input;
    if (comparison.source.kind !== 'workingTree' || comparison.inventory.state !== 'complete') {
        throw new ScmCommitPlanMaterializationConflict('unrepresentable_selection', 'Only a complete pending comparison can authorize a commit plan');
    }
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (root !== comparison.repository.rootPath) throw new ScmCommitPlanMaterializationConflict('foreign_selection', 'Comparison belongs to another repository');
    const baseTreeOid = await tree(cwd, comparison.endpoints.before);
    const afterTreeOid = await tree(cwd, comparison.endpoints.after);
    const indexRef = `refs/happier/comparisons/${input.sessionId ? encodeRepositoryCheckpointScope(input.sessionId) : 'repository'}/${comparison.id}/index`;
    const indexTreeOid = await tree(cwd, (await git(cwd, ['rev-parse', '--verify', indexRef])).trim());
    if (buildScmComparisonIdentity({ source: comparison.source, repositoryRootPath: root,
        beforeOid: comparison.endpoints.before, afterOid: comparison.endpoints.after, indexOid: indexTreeOid }) !== comparison.id) {
        throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Retained index no longer matches this comparison identity');
    }
    const byId = new Map(comparison.inventory.files.flatMap((file) => file.occurrences.map((occurrence) => [occurrence.id, occurrence] as const)));
    const allSelected = new Set<string>();
    for (const group of input.groups) for (const id of group.changeRefs) {
        if (!byId.has(id)) throw new ScmCommitPlanMaterializationConflict('foreign_selection', 'Selection is not an exact occurrence in the captured comparison', undefined, [id]);
        if (allSelected.has(id)) throw new ScmCommitPlanMaterializationConflict('duplicate_selection', 'An occurrence cannot belong to more than one accepted group', byId.get(id)!.path, [id]);
        allSelected.add(id);
    }
    const layers: LayerFile[] = [];
    for (const [beforeTree, afterTree, staged] of [[baseTreeOid, indexTreeOid, true], [indexTreeOid, afterTreeOid, false]] as const) {
        const read = await readGitComparisonFiles({ cwd, before: beforeTree, after: afterTree });
        if (!read.enumerationComplete || read.reasons.length) throw new ScmCommitPlanMaterializationConflict('stale_evidence', read.reasons.join('\n') || 'Captured layer inventory is incomplete');
        for (const file of read.files) {
            const layer = staged ? 'staged' : file.beforeBlobId ? 'unstaged' : 'untracked';
            const occurrences = comparison.inventory.files.find((value) => value.path === file.path)?.occurrences.filter((value) => value.layer === layer) ?? [];
            if ((file.unifiedDiff?.match(/^diff --git /gm)?.length ?? 0) > 1 && occurrences.some((ref) => allSelected.has(ref.id))) {
                throw new ScmCommitPlanMaterializationConflict('unrepresentable_selection',
                    'Captured file evidence contains multiple file diffs and cannot authorize a single-file selection', file.path, occurrences.map((ref) => ref.id));
            }
            const hunks = parseHunks(file.unifiedDiff ?? '');
            if (occurrences.length !== Math.max(1, hunks.length)) throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Captured layer occurrences no longer match the immutable diff', file.path);
            for (const [position, occurrence] of occurrences.entries()) {
                const hunk = hunks[position];
                if (occurrence.position !== position || occurrence.beforeBlobId !== file.beforeBlobId || occurrence.afterBlobId !== file.afterBlobId
                    || occurrence.previousPath !== file.previousPath || occurrence.evidence?.state === 'unavailable'
                    || occurrence.before.startLine !== (hunk?.before.startLine ?? 0) || occurrence.before.lineCount !== (hunk?.before.lineCount ?? 0)
                    || occurrence.after.startLine !== (hunk?.after.startLine ?? 0) || occurrence.after.lineCount !== (hunk?.after.lineCount ?? 0)) {
                    throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Occurrence does not match its captured layer, blob and range', file.path, [occurrence.id]);
                }
            }
            layers.push({ file, beforeTree, afterTree, layer, occurrences, hunks });
        }
    }
    for (const id of allSelected) if (!layers.some((value) => value.occurrences.some((ref) => ref.id === id))) {
        throw new ScmCommitPlanMaterializationConflict('stale_evidence', 'Selected occurrence has no captured immutable layer', byId.get(id)!.path, [id]);
    }
    const created = await createGitTemporaryIndex({ cwd, seed: { kind: 'tree', treeOid: baseTreeOid }, runGit: runGitCheckpointCommand });
    if (!created.success) throw new ScmCommitPlanMaterializationConflict('stale_evidence', created.error);
    const steps: Array<{ groupId: string; targetTreeOid: string }> = [];
    const cumulative = new Set<string>();
    try {
        for (const group of input.groups) {
            for (const id of group.changeRefs) cumulative.add(id);
            await git(cwd, ['read-tree', baseTreeOid], { env: created.tempIndex.env });
            for (const layer of layers) {
                if (!layer.occurrences.some((ref) => cumulative.has(ref.id))) continue;
                let target: TreeEntry | undefined;
                if (layer.layer !== 'staged') {
                    const paths = new Set([layer.file.path, layer.file.previousPath]);
                    const prerequisite = layers.filter((value) => value.layer === 'staged'
                        && (paths.has(value.file.path) || (value.file.previousPath !== undefined && paths.has(value.file.previousPath))));
                    const missing = prerequisite.flatMap((value) => value.occurrences.filter((ref) => !cumulative.has(ref.id)).map((ref) => ref.id));
                    if (missing.length) target = await selectedUnstagedSubset(cwd, layer, prerequisite, cumulative);
                }
                target ??= await selectedEntry(cwd, layer, cumulative);
                const updates = [...(layer.file.changeKind === 'renamed' && layer.file.previousPath ? [`0 ${'0'.repeat(baseTreeOid.length)}\t${layer.file.previousPath}\0`] : []),
                    `${target?.mode ?? '0'} ${target?.oid ?? '0'.repeat(baseTreeOid.length)}\t${layer.file.path}\0`].join('');
                await git(cwd, ['update-index', '-z', '--index-info'], { env: created.tempIndex.env, stdin: updates });
            }
            steps.push({ groupId: group.id, targetTreeOid: (await git(cwd, ['write-tree'], { env: created.tempIndex.env })).trim() });
        }
    } finally { created.tempIndex.cleanup(); }
    return { baseTreeOid, indexTreeOid, steps };
}
