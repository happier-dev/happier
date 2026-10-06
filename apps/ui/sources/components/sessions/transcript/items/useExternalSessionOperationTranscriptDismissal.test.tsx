import { act } from 'react-test-renderer';
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionOperationSharedPresentationV1Schema,
    type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { createTestSessionTranscriptSource, renderHook, wrapWithSessionTranscriptSource } from '@/dev/testkit';

import { useExternalSessionOperationTranscriptDismissal } from './useExternalSessionOperationTranscriptDismissal';

function createInteractiveSource(sessionId = 'session-1') {
    return createTestSessionTranscriptSource({ sessionId, actions: {
        respondToPermission: vi.fn(async () => {}), answerUserAction: vi.fn(async () => {}),
        abort: vi.fn(async () => {}), submitMessage: vi.fn(async () => {}),
    } });
}

function InteractiveTranscriptProvider(props: React.PropsWithChildren) {
    return wrapWithSessionTranscriptSource(props.children as React.ReactElement, createInteractiveSource());
}

function createPresentation(
    overrides: Partial<ExternalSessionOperationSharedPresentationV1> = {},
): ExternalSessionOperationSharedPresentationV1 {
    return ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        kind: 'materialize',
        status: 'completed',
        phase: 'publishing',
        ...overrides,
    });
}

describe('useExternalSessionOperationTranscriptDismissal', () => {
    it('dismisses an exact terminal presentation locally without granting read-only actions', async () => {
        const presentation = createPresentation();
        const source = createTestSessionTranscriptSource({ sessionId: 'shared-session' });
        const hook = await renderHook(() => useExternalSessionOperationTranscriptDismissal({ sessionId: 'viewer-session', presentation }), {
            wrapper: (props) => wrapWithSessionTranscriptSource(props.children as React.ReactElement, source),
        });
        act(() => hook.getCurrent().onDismiss({ operationId: presentation.operationId, revision: presentation.revision }));
        expect(hook.getCurrent().dismissal).toEqual({
            sessionId: 'shared-session', operationId: presentation.operationId, revision: presentation.revision,
        });
        expect(source.actions).toBeNull();
        await hook.unmount();
    });
    it('retains one exact terminal dismissal for the mounted session and resets it for another session', async () => {
        const presentation = createPresentation();
        let source = createInteractiveSource();
        const hook = await renderHook(
            (props: Readonly<{
                sessionId: string;
                presentation: ExternalSessionOperationSharedPresentationV1 | null;
            }>) => useExternalSessionOperationTranscriptDismissal(props),
            {
                wrapper: (props) => wrapWithSessionTranscriptSource(props.children as React.ReactElement, source),
                initialProps: {
                    sessionId: 'session-1',
                    presentation,
                },
            },
        );

        act(() => {
            hook.getCurrent().onDismiss({
                operationId: presentation.operationId,
                revision: presentation.revision,
            });
        });
        expect(hook.getCurrent().dismissal).toEqual({
            sessionId: 'session-1',
            operationId: 'operation-1',
            revision: 4,
        });

        await hook.rerender({
            sessionId: 'session-1',
            presentation: { ...presentation, revision: 5 },
        });
        expect(hook.getCurrent().dismissal).toEqual(expect.objectContaining({
            revision: 4,
        }));

        source = createInteractiveSource('session-2');
        await hook.rerender({
            sessionId: 'session-2',
            presentation,
        });
        expect(hook.getCurrent().dismissal).toBeNull();
        await hook.unmount();
    });

    it('rejects stale and nonterminal dismissal attempts and resets on remount', async () => {
        const running = createPresentation({
            status: 'running',
            phase: 'importing',
        });
        const hook = await renderHook(
            () => useExternalSessionOperationTranscriptDismissal({
                sessionId: 'session-1',
                presentation: running,
            }),
            { wrapper: InteractiveTranscriptProvider },
        );

        act(() => {
            hook.getCurrent().onDismiss({
                operationId: running.operationId,
                revision: running.revision,
            });
            hook.getCurrent().onDismiss({
                operationId: running.operationId,
                revision: running.revision - 1,
            });
        });
        expect(hook.getCurrent().dismissal).toBeNull();
        await hook.unmount();

        const remounted = await renderHook(
            () => useExternalSessionOperationTranscriptDismissal({
                sessionId: 'session-1',
                presentation: createPresentation(),
            }),
            { wrapper: InteractiveTranscriptProvider },
        );
        expect(remounted.getCurrent().dismissal).toBeNull();
        act(() => {
            remounted.getCurrent().onDismiss({ operationId: 'another-operation', revision: 4 });
            remounted.getCurrent().onDismiss({ operationId: 'operation-1', revision: 3 });
        });
        expect(remounted.getCurrent().dismissal).toBeNull();
        await remounted.unmount();
    });
});
