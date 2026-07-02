import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useOpenApprovalSessionIds } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

function artifact(
    id: string,
    header: NonNullable<DecryptedArtifact['header']>,
    body?: unknown,
): DecryptedArtifact {
    return {
        id,
        header,
        title: header.title ?? null,
        sessions: header.sessions,
        draft: header.draft,
        body: typeof body === 'undefined' ? undefined : JSON.stringify(body),
        headerVersion: 1,
        bodyVersion: typeof body === 'undefined' ? undefined : 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
    };
}

afterEach(() => {
    standardCleanup();
});

describe('useOpenApprovalSessionIds', () => {
    it('projects only non-draft open approval session ids and ignores unrelated artifact churn', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                artifacts: {
                    open: artifact('open', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                    }),
                    draft: artifact('draft', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Draft approve',
                        approvalStatus: 'open',
                        sessionId: 'draft-session',
                        draft: true,
                    }),
                    note: artifact('note', {
                        v: 1,
                        kind: 'note',
                        title: 'Note',
                        sessionId: 'session-b',
                    }),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useOpenApprovalSessionIds();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const first = hook.getCurrent();

            expect(first).toEqual(['session-a']);
            expect(renderCount).toBe(1);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    artifacts: {
                        ...state.artifacts,
                        note: {
                            ...state.artifacts.note,
                            updatedAt: 2,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(first);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('projects server-scoped session identities when approval artifacts include a server id', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                artifacts: {
                    open: artifact('open', {
                        v: 1,
                        kind: 'approval_request.v1',
                        title: 'Approve',
                        approvalStatus: 'open',
                        sessionId: 'session-a',
                        serverId: 'server-a',
                    }),
                },
            }));

            const hook = await renderHook(() => useOpenApprovalSessionIds(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual(['server-a:session-a']);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
