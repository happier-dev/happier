// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';

import { standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '../views/sessionFilesViewTestkit';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { resolveCompactAppDestinations, hrefForDestinationRef } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { TranscriptTurnChangesCard } = await import('./TranscriptTurnChangesCard');
const { TurnChangesCard } = await import('./TurnChangesCard');
const { readTurnChangesFromDiffTool } = await import('./readTurnChangesFromDiffTool');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('transcript captured file navigation', () => {
    it.each([
        { basis: 'checkpoint', publishAfterMount: false },
        { basis: 'checkpoint', publishAfterMount: true },
        { basis: 'provider', publishAfterMount: false },
        { basis: 'projectedProvider', publishAfterMount: true },
        { basis: 'unavailableCheckpoint', publishAfterMount: true },
    ] as const)('opens $basis evidence with its producer base (published after mount: $publishAfterMount)', async ({ basis, publishAfterMount }) => {
        const repositoryRelative = basis !== 'provider';
        const path = repositoryRelative ? 'nested/a.ts' : 'a.ts';
        const turn = readTurnChangesFromDiffTool({ name: 'Diff', input: {
            _happier: { sessionChangeScope: 'turn', sessionId: 'session-1', turnId: 'turn-nested',
                provider: 'codex', source: basis === 'checkpoint' ? 'scm_checkpoint' : 'provider_native', confidence: 'exact',
                turnStatus: 'completed', seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
                ...(repositoryRelative ? { repositoryCheckpoint: { version: 1, scopeId: 'scope',
                    baseRefSource: basis === 'unavailableCheckpoint' ? 'unavailable' : 'turn_start',
                    contentConfidence: basis === 'unavailableCheckpoint' ? 'unavailable' : 'exact', attributionScope: 'unknown', receipts: [],
                    ...(basis === 'unavailableCheckpoint' ? { unavailableReason: 'missing_final' } : {}) } } : {}),
            }, files: [
                { file_path: path, source: basis === 'checkpoint' ? 'scm_checkpoint' : 'provider_native', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' },
            ],
        } });
        expect(turn).not.toBeNull();
        const comparison = ScmComparisonSchema.parse({ id: 'd'.repeat(64),
            source: { kind: 'turnCheckpoint', turnId: 'turn-nested' }, repository: { rootPath: '/repo' }, endpoints: {},
            inventory: { state: 'complete', reasons: [], files: [{ path: 'nested/a.ts', changeKind: 'modified',
                binary: false, generated: false, lockfile: false, occurrences: [],
                evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' } }] } });
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo/nested', serverIdentityId: 'srv_transcript_nested',
            rpc: request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE
                ? { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } } : undefined });
        fixture.setSnapshot(null);
        fixture.storage.setState({ isDataReady: true });
        const source = createTestSessionTranscriptSource({ sessionId: fixture.session.id, serverId: fixture.scope.serverId,
            workspacePath: '/repo/nested', navigate: () => {} });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        let navigation: WorkspaceNavigationContextValue | undefined;
        const screen = await fixture.render(<WorkspaceProvider enabled catalog={catalog}>{owner => {
            navigation = owner;
            return wrapWithSessionTranscriptSource(<TranscriptTurnChangesCard sessionId={fixture!.session.id}
                serverId={fixture!.scope.serverId} {...turn!} fileOpenEnabled />, source);
        }}</WorkspaceProvider>);
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toHaveLength(0);
        if (publishAfterMount) {
            await act(async () => fixture!.setSnapshot(fileViewSnapshot({ rootPath: '/repo' })));
            if (repositoryRelative) expect(screen.findByType(TurnChangesCard).props.frontSession.rootPath).toBe('/repo');
        }
        await act(async () => screen.findByType(TurnChangesCard).props.onOpenFile(path));
        await vi.waitFor(() => {
            const hrefs = Object.values(navigation!.state.tabs).map(tab => hrefForDestinationRef(catalog, tab.target));
            expect(hrefs.some(href => {
                if (!href) return false;
                const query = new URL(href, 'https://happier.test').searchParams;
                return query.get('path') === path && query.get('rootPath') === (repositoryRelative ? '/repo' : null);
            })).toBe(true);
        });
        const captures = fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE);
        if (publishAfterMount || !repositoryRelative) expect(captures).toHaveLength(0);
        else {
            expect(captures).toHaveLength(1);
            expect(captures[0]?.payload).toMatchObject({ cwd: '/repo/nested', source: { kind: 'turnCheckpoint', turnId: 'turn-nested' } });
        }
        await act(async () => screen.findByType(TurnChangesCard).props.onOpenFile(path));
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE)).toHaveLength(captures.length);
    });
});
