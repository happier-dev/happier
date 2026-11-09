import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';
import { WORKTREE_RELATIVE_PARENT_DIR } from '@happier-dev/protocol/scm/worktreeName';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { directoriesAtDepth, check, item, unavailableDirectory, contains, opaqueItemTitle } from './filesystem';
import { StorageCategoryAdapterError, type StorageCategoryAdapter, type StorageCategoryDefinition, type StorageCategoryContext, type StorageCategoryCatalogDeps, type StorageWorktree, type StorageCategoryItem } from './types';
import { worktreeVerdict } from '../worktrees/worktreeVerdicts';
import { assertStoragePathIdentity, readStoragePathIdentity } from '../trash/removeStoragePath';
import { physicalStoragePathWithoutFollowingLeaf } from '../storagePath';

type WorktreeContext = Pick<StorageCategoryContext, 'deps' | 'projects' | 'worktrees' | 'sessions' | 'inUse' | 'discoveryIssues' | 'discoveryPaths'>;

function roots(context: WorktreeContext) {
    const repos = [...context.projects.map(project => project.repositoryRoot), ...context.worktrees.map(worktree => worktree.repositoryRoot)];
    return [...new Set(repos)].map(root => join(root, WORKTREE_RELATIVE_PARENT_DIR));
}
const OwnerData = z.strictObject({ v: z.literal(1), repositoryRoot: z.string().check(z.minLength(1)), worktreePath: z.string().check(z.minLength(1)),
    retentionSupported: z.boolean(), retentionKind: z.optional(z.enum(['main', 'common', 'orphan'])),
    referenceOwnerData: z.optional(StrictJsonValueSchema) });
const StoredOwnerData = createStoredReadSchema(OwnerData);
function adapter(raw: unknown, deps: StorageCategoryCatalogDeps): StorageCategoryAdapter {
    const parsed = StoredOwnerData.safeParse(raw);
    if (!parsed.success) throw new StorageCategoryAdapterError('owner_data_invalid');
    const data = parsed.data;
    const owner = deps.worktreeOperations;
    if (!owner) throw new StorageCategoryAdapterError('owner_unavailable');
    return {
        ownerData: data, restorable: data.retentionSupported, requiresIdle: true,
        async retire({ payloadPath, beforeEffect }) {
            if (!data.retentionSupported) throw new StorageCategoryAdapterError('restore_unsupported');
            const sourceIdentity = await readStoragePathIdentity(data.worktreePath).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
                throw error;
            });
            await owner.retire({ repositoryRoot: data.repositoryRoot, worktreePath: data.worktreePath,
                targetPath: payloadPath, retentionKind: data.retentionKind, entryId: basename(dirname(payloadPath)),
                beforeEffect: async () => { await beforeEffect?.(); if (data.referenceOwnerData !== undefined) {
                    if (!deps.checkoutReferences) throw new StorageCategoryAdapterError('owner_unavailable');
                    if (sourceIdentity) await deps.checkoutReferences.assertCurrent(data.referenceOwnerData);
                } } });
            if (data.referenceOwnerData !== undefined) {
                if (!deps.checkoutReferences) throw new StorageCategoryAdapterError('owner_unavailable');
                try { await deps.checkoutReferences.retire(data.referenceOwnerData); }
                catch (error) {
                    // A known CAS/topology refusal made no Account write. Return the same bytes
                    // to the vacant original path; indeterminate replies retain the prepared manifest.
                    const code = (error as { code?: unknown } | null)?.code;
                    if (sourceIdentity && (code === 'changed_since_review' || code === 'workspace_ref_in_use')) {
                        await owner.reinstate({ repositoryRoot: data.repositoryRoot, worktreePath: payloadPath,
                            targetPath: data.worktreePath, retentionKind: data.retentionKind, entryId: basename(dirname(payloadPath)),
                            beforeEffect: async () => {
                                await assertStoragePathIdentity(payloadPath, sourceIdentity);
                                if (!canonicalAbsolutePathsEqual(await physicalStoragePathWithoutFollowingLeaf(data.worktreePath), data.worktreePath))
                                    throw Object.assign(new Error('Original path changed'), { code: 'changed_since_review' });
                            } });
                    }
                    throw error;
                }
            }
        },
        async reinstate({ payloadPath, restorePath, beforeEffect }) {
            if (!data.retentionSupported) throw new StorageCategoryAdapterError('restore_unsupported');
            if (data.referenceOwnerData !== undefined && !canonicalAbsolutePathsEqual(restorePath, data.worktreePath))
                throw new StorageCategoryAdapterError('restore_path_unsupported');
            await owner.reinstate({ repositoryRoot: data.repositoryRoot, worktreePath: payloadPath,
                targetPath: restorePath, retentionKind: data.retentionKind, entryId: basename(dirname(payloadPath)), beforeEffect });
            if (data.referenceOwnerData !== undefined) {
                if (!deps.checkoutReferences) throw new StorageCategoryAdapterError('owner_unavailable');
                await deps.checkoutReferences.reinstate(data.referenceOwnerData, data.repositoryRoot);
            }
        },
        async discard({ payloadPath, beforeEffect }) {
            await owner.remove({ repositoryRoot: data.repositoryRoot, worktreePath: payloadPath ?? data.worktreePath,
                retentionKind: data.retentionKind, retainedSourcePath: data.worktreePath, beforeEffect });
            if (data.referenceOwnerData !== undefined) {
                if (!deps.checkoutReferences) throw new StorageCategoryAdapterError('owner_unavailable');
                await deps.checkoutReferences.retire(data.referenceOwnerData);
            }
        },
    };
}
async function resolveWorktree(path: string, context: WorktreeContext): Promise<StorageWorktree | undefined> {
    const registered = context.worktrees.find(worktree => canonicalAbsolutePathsEqual(worktree.path, path));
    if (registered) return registered;
    const repository = context.worktrees.find(worktree => worktree.isMain && worktree.retentionKind !== 'common'
        && contains(join(worktree.repositoryRoot, WORKTREE_RELATIVE_PARENT_DIR), path));
    if (!repository || !context.deps.worktreeOperations) return undefined;
    const result = await context.deps.worktreeOperations.inspect(repository.repositoryRoot, [path]);
    const facts = result.success ? result.worktrees?.find(value => canonicalAbsolutePathsEqual(value.path, path)) : undefined;
    if (facts?.retention?.kind !== 'orphan') return undefined;
    return { path, repositoryRoot: repository.repositoryRoot, facts, fingerprint: facts.retention.fingerprint,
        retentionKind: 'orphan', retentionSupported: repository.retentionSupported, pullRequestState: null };
}
function mainLosses(worktree: StorageWorktree): StorageReasonV1[] | undefined {
    const loss = worktree.facts?.retention?.losses;
    if (!loss) return undefined;
    return [{ code: 'main_checkout', detail: { path: worktree.repositoryRoot,
        unpushedBranches: loss.unpushedBranches.length, stashes: loss.stashes.length,
        uncommittedChanges: loss.changes.filter(change => !change.untracked).length,
        untrackedChanges: loss.changes.filter(change => change.untracked).length,
        dependentWorktrees: loss.dependentWorktrees.length } },
        ...loss.unpushedBranches.map(branch => ({ code: 'unpushed_commits' as const, detail: { branch: branch.name, count: branch.ahead } })),
        ...loss.stashes.map(stash => ({ code: 'contains' as const, detail: { kind: 'stash', name: stash.name, oid: stash.oid } })),
        ...loss.changes.map(change => ({ code: 'changed_files' as const,
            detail: { path: join(change.worktreePath, change.path), untracked: change.untracked } })),
        ...loss.dependentWorktrees.map(path => ({ code: 'contains' as const, detail: { kind: 'dependent_worktree', path } }))];
}
/** Both full catalog discovery and page-scoped SCM supplementation use this owner. */
export async function readStorageWorktreeItems(context: WorktreeContext): Promise<readonly StorageCategoryItem[]> {
        const registered = new Map(context.worktrees.map(worktree => [worktree.path, worktree]));
        const paths = [...new Set([...registered.keys(), ...(await Promise.all(roots(context)
            .map(root => directoriesAtDepth(root, 1, unavailableDirectory(context, 'worktrees'), context.discoveryPaths)))).flat()])]
            .filter(path => !context.deps.trashRoots?.().some(root => contains(root, path)));
        const result: StorageCategoryItem[] = await Promise.all(paths.map(async path => {
            const worktree = await resolveWorktree(path, context);
            const projectIds = [...new Set(context.projects.filter(project => worktree
                ? canonicalAbsolutePathsEqual(project.repositoryRoot, worktree.repositoryRoot)
                : contains(join(project.repositoryRoot, WORKTREE_RELATIVE_PARENT_DIR), path))
                .flatMap(project => project.projectId ? [project.projectId] : []))].sort();
            if (!worktree) return { ...item('worktrees', path, check, { kind: 'worktree', title: opaqueItemTitle(path, 'Worktree'),
                evidence: ['worktree_parent', 'registration_unavailable'] }), projectIds };
            const sessions = context.sessions.filter(session => !session.archived && contains(path, session.cwd));
            const drafts = await Promise.all(sessions.map(session => context.deps.readSessionDraftPresence?.(session.sessionId)
                ?? Promise.resolve({ status: 'unknown' as const })));
            const draft = drafts.some(value => value.status === 'present') ? 'present' : drafts.some(value => value.status === 'unknown') ? 'unknown' : 'absent';
            const inUse = context.inUse.paths.some(live => contains(path, live))
                || (context.inUse.cwdPaths ?? []).some(cwd => contains(path, cwd)) || sessions.some(session => session.running);
            const verdict = worktree.retentionKind === 'orphan'
                ? { verdict: 'caution' as const, collectable: true,
                    reason: { code: 'not_rebuildable' as const, detail: { kind: 'orphan' } } }
                : worktreeVerdict({ isMain: worktree.isMain, inUse: inUse || (context.inUse.reliable ? false : 'unknown'),
                scm: worktree.facts, draft, pullRequest: worktree.pullRequestState === 'open' ? 'open'
                    : worktree.pullRequestState === undefined ? 'unknown' : 'none' });
            const retirementKind = worktree.retentionKind ?? (worktree.isMain ? 'main' as const : undefined);
            const loses = worktree.isMain ? mainLosses(worktree) : undefined;
            let references: Awaited<ReturnType<NonNullable<StorageCategoryCatalogDeps['checkoutReferences']>['prepare']>> | undefined;
            let limitation: StorageReasonV1 | undefined = worktree.isMain && !context.deps.checkoutReferences
                ? { code: 'unsupported', detail: { cause: 'checkout_reference_owner_unavailable', owner: 'scm', path: worktree.repositoryRoot } }
                : undefined;
            if (worktree.isMain && loses && context.deps.checkoutReferences) {
                try { references = await context.deps.checkoutReferences.prepare({ rootPath: worktree.repositoryRoot,
                    dependentWorktreePaths: worktree.facts?.retention?.losses?.dependentWorktrees }); }
                catch (error) {
                    const code = (error as { code?: unknown } | null)?.code;
                    if (code !== 'workspace_ref_in_use' && code !== 'owner_unavailable') throw error;
                    limitation = { code: 'unsupported', detail: { cause: String(code), path: worktree.repositoryRoot } };
                }
            }
            const fingerprint = worktree.fingerprint && (!worktree.isMain || loses && references)
                ? references ? `sha256:${createHash('sha256').update(JSON.stringify([worktree.fingerprint, references.fingerprint])).digest('hex')}`
                    : worktree.fingerprint : undefined;
            return { ...item('worktrees', path, verdict, { kind: 'worktree', title: worktree.title || opaqueItemTitle(path, 'Worktree'),
                ...(worktree.facts?.lastActivityAt !== undefined ? { lastUsedAt: worktree.facts.lastActivityAt } : {}),
                evidence: [retirementKind === 'orphan' ? 'scm_orphan_back_reference' : 'scm_registered_worktree'] }),
                ...(loses ? { loses } : {}), projectIds, repositoryRoot: worktree.repositoryRoot, fingerprintRequired: true,
                ...(limitation ? { reason: limitation } : {}),
                ...(retirementKind ? { retirementKind } : {}), ...(references ? { referenceOwnerData: references.ownerData } : {}),
                ...(fingerprint ? { fingerprint, ownFingerprint: fingerprint } : {}) };
        }));
        return result;
}
export const worktrees: StorageCategoryDefinition = {
    id: 'worktrees', roots: context => [...new Set([...roots(context), ...context.worktrees.map(worktree => worktree.path)])],
    items: readStorageWorktreeItems,
    async bindAdapter(value, context) {
        const worktree = await resolveWorktree(value.path, context);
        if (!worktree) throw new StorageCategoryAdapterError('owner_unavailable');
        return adapter({ v: 1, repositoryRoot: worktree.repositoryRoot, worktreePath: worktree.path,
            ...(value.retirementKind ? { retentionKind: value.retirementKind } : {}),
            ...(value.referenceOwnerData !== undefined ? { referenceOwnerData: value.referenceOwnerData } : {}),
            retentionSupported: worktree.retentionSupported === true && (value.retirementKind !== undefined || worktree.facts?.hasSubmodules === false) }, context.deps);
    },
    async adapterForEntry(data, deps) { return adapter(data, deps); },
};
