import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { ReviewCommentV1 } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSetting: (key: string) => {
            if (key === 'wrapLinesInDiffs') return true;
            if (key === 'showLineNumbers') return true;
            if (key === 'scmReviewMaxFiles') return 25;
            return undefined;
        },
        useWorkspaceReviewCommentsDrafts: () => [
            {
                id: 'draft-1',
                filePath: 'src/a.ts',
                source: 'diff',
                anchor: {
                    kind: 'diffLine',
                    startLine: 5,
                    side: 'after',
                    oldLine: 1,
                    newLine: 1,
                },
                snapshot: {
                    selectedLines: ['+export const a = 2;'],
                    beforeContext: ['-export const a = 1;'],
                    afterContext: [],
                },
                body: 'Please verify this change.',
                createdAt: 1,
            },
        ],
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'files.reviewComments',
}));

vi.mock('@/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides', () => ({
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS: {},
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES: {},
}));

const reviewDraftHandlers = {
    onUpsertReviewCommentDraft: vi.fn(),
    onDeleteReviewCommentDraft: vi.fn(),
    onReviewCommentError: vi.fn(),
};

vi.mock('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers', () => ({
    useWorkspaceReviewCommentDraftHandlers: () => reviewDraftHandlers,
}));

const serverFetchSpy = vi.hoisted(() => vi.fn());
const reviewCommentsSurfaceSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchSpy,
}));

vi.mock('@/components/reviews/ReviewCommentsSessionSurface', () => ({
    ReviewCommentsSessionSurface: (props: any) => {
        reviewCommentsSurfaceSpy(props);
        return React.createElement('ReviewCommentsSessionSurface', props);
    },
}));

const useWorkspaceScmSnapshotControllerSpy = vi.fn();
const workspaceSnapshotMock = {
    repo: { isRepo: true },
    entries: [
        {
            path: 'src/a.ts',
            kind: 'modified',
            previousPath: null,
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 1,
                isBinary: false,
            },
        },
    ],
    branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
    capabilities: {},
};
const machineScmDiffFileSpy = vi.fn<(machineId: string, request: any) => Promise<any>>(async () => ({
    success: true,
    diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 0000000..1111111 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '-export const a = 1;',
        '+export const a = 2;',
        '',
    ].join('\n'),
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: (scope: any) => {
        useWorkspaceScmSnapshotControllerSpy(scope);
        return {
            snapshot: workspaceSnapshotMock,
            loading: false,
            error: null,
            refresh: vi.fn(async () => {}),
        };
    },
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (machineId: string, request: any) => machineScmDiffFileSpy(machineId, request),
}));

const changedFilesReviewSpy = vi.fn();
vi.mock('@/components/workspaces/scm/review/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: any) => {
        changedFilesReviewSpy(props);
        return React.createElement('ChangedFilesReview', props);
    },
}));

function reviewComment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: overrides.projectId ?? 'project-1',
        workspaceId: overrides.workspaceId,
        runId: overrides.runId,
        engineId: overrides.engineId,
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'body',
        bodyVersion: 1,
        edits: [],
        author: overrides.author ?? { kind: 'plugin', pluginId: 'review-coderabbit' },
        state: overrides.state ?? 'open',
        flags: overrides.flags ?? {},
        dispositions: {},
        threadId: overrides.threadId ?? overrides.id ?? 'comment-1',
        transitions: [
            {
                transitionId: 'transition-1',
                toState: overrides.state ?? 'open',
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                serverRevision: 1,
            },
        ],
        createdAt: 1,
        updatedAt: overrides.updatedAt ?? 1,
        serverRevision: overrides.serverRevision ?? 1,
        ...overrides,
    };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('WorkspaceScmReviewDetailsView', () => {
    beforeEach(() => {
        useWorkspaceScmSnapshotControllerSpy.mockClear();
        machineScmDiffFileSpy.mockClear();
        changedFilesReviewSpy.mockClear();
        serverFetchSpy.mockReset();
        reviewCommentsSurfaceSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    async function settle(): Promise<void> {
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    }

    it('loads the workspace SCM snapshot and renders the shared review surface', async () => {
        const { WorkspaceScmReviewDetailsView } = await import('./WorkspaceScmReviewDetailsView');
        await renderScreen(
            <WorkspaceScmReviewDetailsView
                scopeId="project:wr_1"
                workspaceRefId="wr_1"
                workspaceCacheKey="wk_1"
                machineId="m1"
                rootPath="/repo"
                serverId="s1"
            />,
        );

        await settle();

        expect(useWorkspaceScmSnapshotControllerSpy).toHaveBeenCalledWith({
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
        });
        const reviewProps = changedFilesReviewSpy.mock.calls[0]?.[0];
        expect(reviewProps).toEqual(expect.objectContaining({
            sessionId: 'project:wr_1',
            changedFilesViewMode: 'repository',
            allRepositoryChangedFiles: [expect.objectContaining({ fullPath: 'src/a.ts' })],
            repositoryOnlyFiles: [expect.objectContaining({ fullPath: 'src/a.ts' })],
            sessionAttributedFiles: [],
            turnAttributedFiles: [],
            reviewCommentsEnabled: true,
            reviewCommentDrafts: [
                expect.objectContaining({
                    id: 'draft-1',
                    filePath: 'src/a.ts',
                    body: 'Please verify this change.',
                }),
            ],
            onUpsertReviewCommentDraft: reviewDraftHandlers.onUpsertReviewCommentDraft,
            onDeleteReviewCommentDraft: reviewDraftHandlers.onDeleteReviewCommentDraft,
            onReviewCommentError: reviewDraftHandlers.onReviewCommentError,
            workspaceScope: {
                serverId: 's1',
                machineId: 'm1',
                rootPath: '/repo',
            },
            fetchUnifiedDiffForPath: expect.any(Function),
        }));

        const result = await reviewProps.fetchUnifiedDiffForPath({
            path: 'src/a.ts',
            diffArea: 'both',
            file: reviewProps.allRepositoryChangedFiles[0],
            normalizeError: (value: unknown) => String(value),
            fallbackError: 'failed',
        });

        expect(machineScmDiffFileSpy).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', path: 'src/a.ts', area: 'both' }));
        expect(result).toEqual(expect.objectContaining({ success: true }));
    });

    it('mounts durable review comments in the project SCM review surface', async () => {
        serverFetchSpy
            .mockResolvedValueOnce(jsonResponse({
                grants: [],
                pendingRequests: [],
                cursor: null,
            }))
            .mockResolvedValue(jsonResponse({
                items: [reviewComment({ workspaceId: 'wr_1', body: 'Durable project review comment.' })],
                cursor: null,
            }));
        const { WorkspaceScmReviewDetailsView } = await import('./WorkspaceScmReviewDetailsView');
        const screen = await renderScreen(
            <WorkspaceScmReviewDetailsView
                scopeId="project:wr_1"
                workspaceRefId="wr_1"
                workspaceCacheKey="wk_1"
                machineId="m1"
                rootPath="/repo"
                serverId="s1"
            />,
        );

        expect(screen.getTextContent()).not.toContain('Durable project review comment.');

        expect(reviewCommentsSurfaceSpy).toHaveBeenCalledWith(expect.objectContaining({
            workspaceId: 'wr_1',
            directWriteGrants: [],
            pendingDirectWriteGrantRequests: [],
            defaultPanelOpen: false,
            testID: 'workspace-review-comments',
            execute: expect.any(Function),
        }));
        expect(serverFetchSpy).toHaveBeenCalledWith(
            '/v1/plugins/permissions/grants/list',
            expect.objectContaining({
                body: expect.stringContaining('"targetScope":{"kind":"project","projectId":"wr_1"}'),
            }),
            expect.any(Object),
        );

        const surfaceProps = reviewCommentsSurfaceSpy.mock.calls.at(-1)?.[0];
        await expect(surfaceProps.execute('reviews.comments.list', {
            workspaceId: surfaceProps.workspaceId,
            includeHistory: true,
        })).resolves.toEqual({
            items: [expect.objectContaining({ body: 'Durable project review comment.' })],
            cursor: null,
        });
        const [path] = serverFetchSpy.mock.calls.find(([calledPath]) => String(calledPath).startsWith('/v1/reviews/comments?')) ?? [];
        expect(String(path)).toContain('/v1/reviews/comments?');
        expect(String(path)).toContain('workspaceId=wr_1');
    });
});
