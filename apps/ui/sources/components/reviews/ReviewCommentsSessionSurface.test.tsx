import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewCommentActionIdV1, ReviewCommentV1 } from '@happier-dev/protocol';
import { flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type {
    PluginPermissionGrant,
    PluginPermissionPendingGrantRequest,
} from '@/sync/domains/plugins/permissions/types';

import { ReviewCommentsSessionSurface } from './ReviewCommentsSessionSurface';

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => {
        if (key === 'files.reviewComments.durable.count') return String(params?.count ?? '');
        if (key === 'files.reviewComments.durable.directWriteGrant.body') return String(params?.pluginId ?? '');
        if (key === 'files.reviewComments.durable.bulkFailure') return `${String(params?.commentId ?? '')}:${String(params?.errorCode ?? '')}`;
        return key;
    } });
});

const modalMock = vi.hoisted(() => ({
    prompt: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: modalMock.prompt,
        },
    }).module;
});

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe('ReviewCommentsSessionSurface', () => {
    beforeEach(() => {
        modalMock.prompt.mockReset();
    });

    it('renders durable active/history comments and preserves last-known rows only while refresh is pending', async () => {
        const secondList = deferred<{ items: ReviewCommentV1[]; cursor: null }>();
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            if (execute.mock.calls.length === 1) {
                return {
                    items: [
                        comment({ id: 'open-1', state: 'open', body: 'Keep visible while refreshing.', updatedAt: 2 }),
                        comment({ id: 'resolved-1', state: 'resolved', body: 'Resolved historical issue.', updatedAt: 1 }),
                    ],
                    cursor: null,
                };
            }
            return await secondList.promise;
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Keep visible while refreshing.');
        expect(screen.getTextContent()).not.toContain('Resolved historical issue.');

        const showHistory = screen.findByTestId('review-comments-session-show-history');
        await pressTestInstanceAsync(showHistory, 'review-comments-session-show-history');
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Resolved historical issue.');
        expect(screen.getTextContent()).not.toContain('Keep visible while refreshing.');

        const showActive = screen.findByTestId('review-comments-session-show-active');
        await pressTestInstanceAsync(showActive, 'review-comments-session-show-active');
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Keep visible while refreshing.');

        const refresh = screen.findByTestId('review-comments-session-refresh');
        await pressTestInstanceAsync(refresh, 'review-comments-session-refresh');
        await flushHookEffects({ cycles: 1 });

        expect(screen.getTextContent()).toContain('Keep visible while refreshing.');

        await act(async () => {
            secondList.resolve({ items: [], cursor: null });
        });
        await flushHookEffects();
        expect(screen.getTextContent()).not.toContain('Keep visible while refreshing.');
    });

    it('keeps the product panel closed until the header button is pressed', async () => {
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            return {
                items: [
                    comment({ id: 'open-1', state: 'open', body: 'Opened from product header.', updatedAt: 2 }),
                ],
                cursor: null,
            };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                defaultPanelOpen={false}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(execute).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('Opened from product header.');

        const header = screen.findByTestId('review-comments-session-header');
        await pressTestInstanceAsync(header, 'review-comments-session-header');
        await flushHookEffects();

        expect(execute).toHaveBeenCalledWith('reviews.comments.list', expect.objectContaining({
            projectId: 'project-1',
            sessionId: 'session-1',
            includeHistory: true,
        }));
        expect(screen.getTextContent()).toContain('Opened from product header.');
    });

    it('shows redacted durable comments in history even when their state is still active', async () => {
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            return {
                items: [
                    comment({
                        id: 'redacted-open-1',
                        state: 'open',
                        body: 'Sensitive body.',
                        anchor: { kind: 'file', filePath: 'src/redacted.ts' },
                        flags: { redacted: true },
                        updatedAt: 2,
                    }),
                    comment({ id: 'open-1', state: 'open', body: 'Visible active finding.', updatedAt: 1 }),
                ],
                cursor: null,
            };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Visible active finding.');
        expect(screen.getTextContent()).not.toContain('src/redacted.ts');

        await pressTestInstanceAsync(
            screen.findByTestId('review-comments-session-show-history'),
            'review-comments-session-show-history',
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('src/redacted.ts');
        expect(screen.getTextContent()).not.toContain('Sensitive body.');
    });

    it('filters active durable comments by selected state without changing the unresolved badge count', async () => {
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            return {
                items: [
                    comment({ id: 'open-1', state: 'open', body: 'Open finding.', updatedAt: 3 }),
                    comment({ id: 'proposed-1', state: 'proposed', body: 'Proposed finding.', updatedAt: 2 }),
                    comment({ id: 'resolved-1', state: 'resolved', body: 'Resolved finding.', updatedAt: 1 }),
                ],
                cursor: null,
            };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Open finding.');
        expect(screen.getTextContent()).toContain('Proposed finding.');
        expect(screen.getTextContent()).not.toContain('Resolved finding.');
        expect(screen.getTextContent()).toContain('2');

        await pressTestInstanceAsync(
            screen.findByTestId('review-comment-filter-state-proposed'),
            'review-comment-filter-state-proposed',
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Open finding.');
        expect(screen.getTextContent()).not.toContain('Proposed finding.');
        expect(screen.getTextContent()).not.toContain('Resolved finding.');
        expect(screen.getTextContent()).toContain('2');
    });

    it('projects exact plugin grant rows and routes grant, dismiss, and revoke by durable identity', async () => {
        const onGrantDirectWrite = vi.fn();
        const onCancelDirectWriteGrant = vi.fn();
        const onRevokeDirectWrite = vi.fn();
        const pendingDirectWriteGrantRequest: PluginPermissionPendingGrantRequest = {
            v: 1,
            id: 'request-1',
            accountId: 'account-1',
            pluginId: 'review-coderabbit',
            pluginName: 'CodeRabbit',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'project-1' },
            subject: { kind: 'general' },
            requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
            authoritySource: { kind: 'bundled' },
            reason: 'Write approved review comments without another prompt.',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
        };
        const activeDirectWriteGrant: PluginPermissionGrant = {
            v: 1,
            id: 'grant-1',
            accountId: 'account-1',
            pluginId: 'review-deepsec',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'project-1' },
            subject: { kind: 'general' },
            authoritySource: { kind: 'bundled' },
            status: 'active',
            requestId: 'request-deepsec',
            grantedByUserId: 'user-1',
            grantedAt: 1,
            createdAt: 1,
            updatedAt: 1,
        };
        const secondPendingRequest: PluginPermissionPendingGrantRequest = {
            ...pendingDirectWriteGrantRequest,
            id: 'request-2',
            pluginId: 'review-second',
            pluginName: 'Second reviewer',
            requester: { kind: 'plugin', pluginId: 'review-second', sessionId: 'session-1' },
            createdAt: 2,
            updatedAt: 2,
        };
        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={async () => ({ items: [], cursor: null })}
                directWriteGrants={[activeDirectWriteGrant]}
                pendingDirectWriteGrantRequests={[pendingDirectWriteGrantRequest, secondPendingRequest]}
                permissionGrantActions={{
                    grant: onGrantDirectWrite,
                    dismissRequest: onCancelDirectWriteGrant,
                    revoke: onRevokeDirectWrite,
                }}
                onGrantDirectWrite={onGrantDirectWrite}
                onCancelDirectWriteGrant={onCancelDirectWriteGrant}
                onRevokeDirectWrite={onRevokeDirectWrite}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('CodeRabbit');
        expect(screen.getTextContent()).toContain('review-coderabbit');
        expect(screen.getTextContent()).toContain('reviews.comments.write.direct');
        expect(screen.getTextContent()).toContain('project:project-1');
        expect(screen.getTextContent()).toContain('Write approved review comments without another prompt.');
        expect(screen.getTextContent()).toContain('review-deepsec');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-scope')?.props.children).toBe('project:project-1');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-actor')?.props.children).toBe('user-1');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-authority')?.props.children).toBe('bundled');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-created')?.props.children).toBe('1970-01-01T00:00:00.001Z');
        expect(screen.getTextContent()).toContain('Second reviewer');
        expect(screen.findByTestId('review-comments-session-direct-write-request-request-2')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Direct write enabled');
        expect(onGrantDirectWrite).not.toHaveBeenCalled();

        const grantButton = screen.findByTestId('review-comments-session-direct-write-request-request-1-grant');
        await pressTestInstanceAsync(grantButton, 'review-comments-session-direct-write-request-request-1-grant');

        expect(onGrantDirectWrite).toHaveBeenCalledWith({ requestId: 'request-1' });
        expect(onGrantDirectWrite).toHaveBeenCalledTimes(1);

        const cancelButton = screen.findByTestId('review-comments-session-direct-write-request-request-1-dismiss');
        await pressTestInstanceAsync(cancelButton, 'review-comments-session-direct-write-request-request-1-dismiss');

        expect(onCancelDirectWriteGrant).toHaveBeenCalledWith({ requestId: 'request-1' });
        expect(onCancelDirectWriteGrant).toHaveBeenCalledTimes(1);

        const revokeButton = screen.findByTestId('review-comments-session-direct-write-grant-grant-1-revoke');
        await pressTestInstanceAsync(revokeButton, 'review-comments-session-direct-write-grant-grant-1-revoke');
        expect(onRevokeDirectWrite).toHaveBeenCalledWith({ grantId: 'grant-1' });
        expect(onRevokeDirectWrite).toHaveBeenCalledTimes(1);
        expect(revokeButton?.props.style.minHeight).toBe(44);
    });

    it('keeps projected grants visible offline and exposes an explicit reconnect refresh', async () => {
        const onRefreshPermissionGrants = vi.fn();
        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={async () => ({ items: [], cursor: null })}
                directWriteGrants={[{
                    v: 1,
                    id: 'grant-1',
                    accountId: 'account-1',
                    pluginId: 'review-deepsec',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'project', projectId: 'project-1' },
                    subject: { kind: 'general' },
                    authoritySource: { kind: 'bundled' },
                    status: 'active',
                    grantedByUserId: 'user-1',
                    grantedAt: 1,
                    createdAt: 1,
                    updatedAt: 1,
                }]}
                pendingDirectWriteGrantRequests={[]}
                permissionGrantStatus="error"
                permissionGrantError="offline"
                onRefreshPermissionGrants={onRefreshPermissionGrants}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.findByTestId('review-comments-session-permission-grants-error')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('offline');
        expect(screen.getTextContent()).toContain('review-deepsec');
        await pressTestInstanceAsync(
            screen.findByTestId('review-comments-session-permission-grants-refresh'),
            'review-comments-session-permission-grants-refresh',
        );
        expect(onRefreshPermissionGrants).toHaveBeenCalledTimes(1);
    });

    it('ignores pending grants for capabilities outside review-comment direct writes', async () => {
        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={async () => ({ items: [], cursor: null })}
                directWriteGrants={[]}
                pendingDirectWriteGrantRequests={[{
                    v: 1,
                    id: 'request-1',
                    accountId: 'account-1',
                    pluginId: 'file-plugin',
                    pluginName: 'File Plugin',
                    capability: 'filesystem.write',
                    targetScope: { kind: 'project', projectId: 'project-1' },
                    subject: { kind: 'general' },
                    requester: { kind: 'plugin', pluginId: 'file-plugin', sessionId: 'session-1' },
                    authoritySource: { kind: 'bundled' },
                    reason: 'Write files.',
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }]}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.findByTestId('review-comments-session-direct-write-request-request-1')).toBeNull();
        expect(screen.getTextContent()).not.toContain('filesystem.write');
    });

    it('wires edit reply transition redact and bulk actions through durable review actions', async () => {
        modalMock.prompt
            .mockResolvedValueOnce('Edited body')
            .mockResolvedValueOnce('Reply body');
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1, input: unknown) => {
            if (actionId === 'reviews.comments.list') {
                return {
                    items: [
                        comment({ id: 'open-1', state: 'open', body: 'Open issue.', updatedAt: 2 }),
                        comment({ id: 'proposed-1', state: 'proposed', body: 'Proposed issue.', updatedAt: 1 }),
                    ],
                    cursor: null,
                };
            }
            if (actionId === 'reviews.comments.bulkTransition') {
                return {
                    bulkActionId: 'bulk-1',
                    updated: [],
                    failed: [{ commentId: 'proposed-1', errorCode: 'review_comment_permission_denied', error: 'not allowed' }],
                };
            }
            if (actionId === 'reviews.comments.reply') {
                return {
                    parent: comment({ id: 'open-1', state: 'open', body: 'Open issue.', updatedAt: 2 }),
                    comment: comment({
                        id: 'reply-1',
                        parentCommentId: 'open-1',
                        threadId: 'open-1',
                        body: 'Reply body',
                    }),
                };
            }
            return { comment: comment({ id: 'open-1', body: `${actionId}:${JSON.stringify(input)}` }) };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-edit'), 'review-comment-open-1-edit');
        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-resolve'), 'review-comment-open-1-resolve');
        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-redact'), 'review-comment-open-1-redact');
        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-reply'), 'review-comment-open-1-reply');
        await pressTestInstanceAsync(screen.findByTestId('review-comments-session-panel-bulk-resolve'), 'review-comments-session-panel-bulk-resolve');
        await flushHookEffects();

        expect(execute).toHaveBeenCalledWith('reviews.comments.edit', expect.objectContaining({
            commentId: 'open-1',
            nextBody: 'Edited body',
            expectedBodyVersion: 1,
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.transition', expect.objectContaining({
            commentId: 'open-1',
            toState: 'resolved',
            expectedState: 'open',
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.redact', expect.objectContaining({
            commentId: 'open-1',
            redactBody: true,
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.reply', expect.objectContaining({
            parentCommentId: 'open-1',
            body: 'Reply body',
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.bulkTransition', expect.objectContaining({
            commentIds: ['open-1', 'proposed-1', 'reply-1'],
            toState: 'resolved',
        }));
        expect(screen.getTextContent()).toContain('files.reviewComments.durable.bulkPartialFailure');
        expect(screen.getTextContent()).toContain('proposed-1');
        expect(screen.getTextContent()).toContain('review_comment_permission_denied');
    });
});
