import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
    ExternalSessionOperationSharedPresentationV1Schema,
    type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';

import { useExternalSessionOperationTranscriptDismissal } from './useExternalSessionOperationTranscriptDismissal';

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
    it('retains one exact terminal dismissal for the mounted session and resets it for another session', async () => {
        const presentation = createPresentation();
        const hook = await renderHook(
            (props: Readonly<{
                sessionId: string;
                presentation: ExternalSessionOperationSharedPresentationV1 | null;
            }>) => useExternalSessionOperationTranscriptDismissal(props),
            {
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
        );
        expect(remounted.getCurrent().dismissal).toBeNull();
        await remounted.unmount();
    });
});
