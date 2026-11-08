import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmStatusSnapshotResponseSchema, summarizeScmChanges } from '@happier-dev/protocol/scm';

import type { RpcHandler } from '@/api/rpc/types';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { registerScmHandlers } from './scm';

const execFile = promisify(execFileCallback);

describe('SCM status snapshot RPC payload', () => {
    const directories: string[] = [];
    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
    });

    it('omits repeated neutral values at the real producer while retaining every changed path and current statistics', async () => {
        vi.stubEnv('HAPPIER_SCM_STATUS_SNAPSHOT_CACHE_TTL_MS', '0');
        const root = await mkdtemp(join(tmpdir(), 'scm-payload-'));
        directories.push(root);
        await execFile('git', ['init', '--quiet'], { cwd: root });
        await writeFile(join(root, 'new.txt'), 'first\nsecond\n');
        const registration = createGitScmBackendRuntimeRegistration();
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
            executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
        })]);
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, root, { registry });
        const status = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
        if (!status) throw new Error('Status handler was not registered');
        const wire = JSON.parse(JSON.stringify(await status({ cwd: root, outcomeVersion: 1 }))) as {
            snapshot: { entries: Record<string, unknown>[] };
        };
        expect(wire.snapshot.entries).toHaveLength(1);
        expect.soft(wire.snapshot.entries[0]).not.toHaveProperty('previousPath');
        expect.soft(wire.snapshot.entries[0]).not.toHaveProperty('hasIncludedDelta');
        expect.soft(wire.snapshot.entries[0]?.stats).toEqual({ pendingAdded: 2 });
        const decoded = ScmStatusSnapshotResponseSchema.parse(wire);
        expect(decoded.snapshot?.entries[0]).toMatchObject({
            path: 'new.txt', previousPath: null, kind: 'untracked', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 0, isBinary: false },
        });
        await writeFile(join(root, 'new.txt'), 'changed\n');
        const refreshed = ScmStatusSnapshotResponseSchema.parse(await status({ cwd: root, outcomeVersion: 1 }));
        expect(refreshed.snapshot?.entries[0]?.stats.pendingAdded).toBe(1);
    });

    it('pages demanded entries with full summaries and reuses one Git status scan for summary, pages and full reads', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scm-payload-pages-'));
        directories.push(root);
        await execFile('git', ['init', '--quiet'], { cwd: root });
        await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), `line ${index}\n`)));
        const tracePath = join(root, '.git', 'status-trace');
        vi.stubEnv('GIT_TRACE', tracePath);
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const registration = createGitScmBackendRuntimeRegistration();
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
            executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
        })]);
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, root, { registry });
        const status = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
        if (!status) throw new Error('Status handler was not registered');
        const request = { cwd: root, outcomeVersion: 1 };
        const summary = ScmStatusSnapshotResponseSchema.parse(await status({ ...request, detail: 'summary' }));
        const firstWire = JSON.stringify(await status({ ...request, entriesPage: { limit: 5 } }));
        const first = ScmStatusSnapshotResponseSchema.parse(JSON.parse(firstWire));
        const next = ScmStatusSnapshotResponseSchema.parse(await status({ ...request, entriesPage: { limit: 5, cursor: 5 } }));
        const last = ScmStatusSnapshotResponseSchema.parse(await status({ ...request, entriesPage: { limit: 5, cursor: 78 } }));
        const beyond = ScmStatusSnapshotResponseSchema.parse(await status({ ...request, entriesPage: { limit: 5, cursor: 80 } }));
        const fullWire = JSON.stringify(await status(request));
        const full = ScmStatusSnapshotResponseSchema.parse(JSON.parse(fullWire));
        expect(first.snapshot?.entries).toEqual(full.snapshot?.entries.slice(0, 5));
        expect(next.snapshot?.entries).toEqual(full.snapshot?.entries.slice(5, 10));
        expect(last.snapshot?.entries).toEqual(full.snapshot?.entries.slice(78));
        expect(first.snapshot).toMatchObject({ entriesPage: { totalFiles: 80, nextCursor: 5 }, totals: full.snapshot?.totals, summary: summary.snapshot?.summary });
        expect(last.snapshot).toMatchObject({ entriesPage: { totalFiles: 80, nextCursor: null } });
        expect(beyond.snapshot).toMatchObject({ entries: [], entriesPage: { totalFiles: 80, nextCursor: null } });
        expect(full.snapshot?.entries).toHaveLength(80);
        expect(full.snapshot?.entriesPage).toBeUndefined();
        // Repository/capability metadata is fixed; changed-file bytes scale with demand.
        expect(JSON.stringify(JSON.parse(firstWire).snapshot.entries).length)
            .toBeLessThan(JSON.stringify(JSON.parse(fullWire).snapshot.entries).length / 10);
        const exact = ScmStatusSnapshotResponseSchema.parse(await status({ ...request, entriesPage: { limit: 1, path: 'file-079.txt' } }));
        const absent = ScmStatusSnapshotResponseSchema.parse(await status({ ...request, entriesPage: { limit: 1, path: 'missing.txt' } }));
        expect(exact.snapshot?.entries).toEqual(full.snapshot?.entries.slice(79));
        expect(exact.snapshot?.entriesPage).toEqual({ totalFiles: 80, nextCursor: null });
        expect(absent.snapshot).toMatchObject({ entries: [], entriesPage: { totalFiles: 80, nextCursor: null } });
        expect(await status({ ...request, entriesPage: { limit: 0 } })).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
        const facts = ScmStatusSnapshotResponseSchema.parse(await status({ ...request, detail: 'facts' }));
        expect(facts.snapshot).toMatchObject({ detail: 'facts', entries: [] });
        // Git's own OS trace counts real backend scans; no internal owner is mocked.
        const gitStatusScans = (await readFile(tracePath, 'utf8')).match(/built-in: git status /g) ?? [];
        expect(gitStatusScans).toHaveLength(1);
        const firstEntriesBytes = Buffer.byteLength(JSON.stringify(JSON.parse(firstWire).snapshot.entries));
        console.info('SCM_STATUS_PAGE_METRICS', JSON.stringify({
            firstPageRows: first.snapshot?.entries.length, totalRows: full.snapshot?.entries.length,
            firstPageBytes: Buffer.byteLength(firstWire), fullSnapshotBytes: Buffer.byteLength(fullWire),
            firstEntriesBytes, fixedEnvelopeBytes: Buffer.byteLength(firstWire) - firstEntriesBytes + 2,
            gitStatusScans: gitStatusScans.length,
        }));
    });

    it('answers summary and facts reads without the changed-file list, beside an unaffected full read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scm-payload-detail-'));
        directories.push(root);
        await execFile('git', ['init', '--quiet'], { cwd: root });
        for (let index = 0; index < 40; index += 1) await writeFile(join(root, `file-${index}.txt`), `line ${index}\n`);
        await writeFile(join(root, 'clip.mp4'), 'not really a video\n');
        const registration = createGitScmBackendRuntimeRegistration();
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
            executableDefinition: registration.runtime!, registration,
            hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(),
        })]);
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, root, { registry });
        const status = handlers.get(RPC_METHODS.SCM_STATUS_SNAPSHOT);
        if (!status) throw new Error('Status handler was not registered');

        // All reads inside the producer's short cache window: the levels must not share an answer.
        const summaryWire = JSON.stringify(await status({ cwd: root, outcomeVersion: 1, detail: 'summary' }));
        const factsWire = JSON.stringify(await status({ cwd: root, outcomeVersion: 1, detail: 'facts' }));
        const fullWire = JSON.stringify(await status({ cwd: root, outcomeVersion: 1 }));
        const summary = ScmStatusSnapshotResponseSchema.parse(JSON.parse(summaryWire));
        const facts = ScmStatusSnapshotResponseSchema.parse(JSON.parse(factsWire));
        const full = ScmStatusSnapshotResponseSchema.parse(JSON.parse(fullWire));
        expect(full.snapshot?.entries).toHaveLength(41);
        expect(full.snapshot?.detail).toBeUndefined();
        expect(summary.snapshot).toMatchObject({ detail: 'summary', entries: [],
            summary: summarizeScmChanges(full.snapshot!.entries, full.snapshot!.totals) });
        expect(summary.snapshot?.summary?.changedFiles).toBe(41);
        // The video's numstat lines are not review statistics.
        expect(summary.snapshot?.summary?.pendingAdded).toBe(40);
        expect(facts.snapshot).toMatchObject({ detail: 'facts', entries: [], repo: { rootPath: full.snapshot?.repo.rootPath } });
        expect(facts.snapshot?.summary).toBeUndefined();
        expect(summaryWire.length).toBeLessThan(fullWire.length / 2);
        expect(factsWire.length).toBeLessThan(fullWire.length / 2);
    });
});
