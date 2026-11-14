import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMachineFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

installSessionFilesViewBoundaries({ platformOS: 'android' });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');

// A checkout with many changes (QA-BREADTH B3: 59k changes, 12.1 MB per open): the open file is past the first page.
const totalFiles = 400;
const entry = { previousPath: null, kind: 'modified' as const, includeStatus: '', pendingStatus: 'M',
    hasIncludedDelta: false, hasPendingDelta: true,
    stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } };
const entries = Array.from({ length: totalFiles }, (_, index) => ({ ...entry, path: `src/file-${index}.ts` }));
type StatusPayload = Readonly<{ detail?: string; entriesPage?: Readonly<{ limit: number; cursor?: number; path?: string }> }>;
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let statusReads: StatusPayload[];

beforeEach(async () => {
    standardCleanup();
    statusReads = [];
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_scm_row', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile',
        execute: async () => ({ success: true, content: Buffer.from('export const x = 1;\n').toString('base64') }) });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_scm_row',
        machine: createMachineFixture({ id: 'm1', operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { scmStatusSnapshotPaging: { protocolVersions: [1] } } }),
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? new Response('{}', { status: 404 });
        },
        rpc: (request) => {
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) {
                const input = (request.payload ?? {}) as StatusPayload;
                statusReads.push(input);
                const base = fileViewSnapshot({ entries: [] });
                const totals = { ...base.totals, pendingFiles: totalFiles, pendingAdded: totalFiles, pendingRemoved: totalFiles };
                const summary = { changedFiles: totalFiles, includedAdded: 0, includedRemoved: 0, pendingAdded: totalFiles, pendingRemoved: totalFiles };
                if (input.detail) return { success: true, snapshot: { ...base, totals, summary, detail: input.detail } };
                const page = input.entriesPage;
                const cursor = page?.cursor ?? 0;
                const rows = page?.path ? entries.filter(row => row.path === page.path)
                    : page ? entries.slice(cursor, cursor + page.limit) : entries;
                return { success: true, snapshot: { ...base, entries: rows, totals, summary,
                    ...(page ? { entriesPage: { totalFiles, nextCursor: !page.path && cursor + page.limit < totalFiles ? cursor + page.limit : null } } : {}) } };
            }
            if (request.method === RPC_METHODS.SCM_DIFF_FILE) return { success: true, diff: '' };
            return { success: true, exists: true, kind: 'file', sizeBytes: 20 };
        } });
    // The Project header already read the shared counts; the file opens on top of that summary slot.
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, { ...fileViewSnapshot(), detail: 'summary',
        summary: { changedFiles: totalFiles, includedAdded: 0, includedRemoved: 0, pendingAdded: totalFiles, pendingRemoved: totalFiles } });
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

function render(filePath: string) {
    return <PluginSurfaceFocusEligibilityProvider active><KeyboardShortcutProvider handlers={{}}>
        <WorkspaceFileDetailsView scopeId="project:scm-row" scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
    </KeyboardShortcutProvider></PluginSurfaceFocusEligibilityProvider>;
}

it('reads the open file\'s own change row, never the checkout\'s whole changed-file list', async () => {
    const filePath = 'src/file-321.ts';
    const screen = await fixture.render(render(filePath));
    try {
        await vi.waitFor(() => expect(statusReads.some(read => read.entriesPage?.path === filePath)).toBe(true));
        await flushHookEffects({ cycles: 20 });
        expect(statusReads.filter(read => !read.detail && !read.entriesPage), 'full changed-file list reads').toHaveLength(0);
        expect(fixture.storage.getState().getWorkspaceScmSnapshot(fixture.scope)?.entries.map(row => row.path)).toContain(filePath);
    } finally { await screen.unmount(); }
});

it('asks once for an unchanged file\'s row and settles', async () => {
    const filePath = 'src/unchanged.ts';
    const screen = await fixture.render(render(filePath));
    try {
        await vi.waitFor(() => expect(statusReads.some(read => read.entriesPage?.path === filePath)).toBe(true));
        await flushHookEffects({ cycles: 30 });
        expect(statusReads.filter(read => read.entriesPage?.path === filePath)).toHaveLength(1);
        expect(statusReads.filter(read => !read.detail && !read.entriesPage)).toHaveLength(0);
    } finally { await screen.unmount(); }
});
