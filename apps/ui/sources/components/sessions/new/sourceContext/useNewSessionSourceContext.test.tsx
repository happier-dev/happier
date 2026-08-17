import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionsRef = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const modalAlertMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
    });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args: any[]) => modalAlertMock(...args));
    return modalMock.module;
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: { getState: () => ({ sessions: sessionsRef.current }) } as any,
    });
});

import { useNewSessionSourceContext } from './useNewSessionSourceContext';

const SOURCE_CONTEXT = {
    v: 1,
    kind: 'session_replay',
    sourceSessionId: 'parent_1',
    forkPoint: { type: 'seq', upToSeqInclusive: 12 },
} as const;

beforeEach(() => {
    modalAlertMock.mockReset();
    sessionsRef.current = {
        parent_1: { id: 'parent_1', metadata: { summary: { text: 'Refactor the fork modal' } } },
    };
});

afterEach(async () => {
    await standardCleanup();
});

describe('useNewSessionSourceContext', () => {
    it('carries no continuation for an ordinary new Session', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: null,
            targetServerId: 'server_1',
        }));
        expect(harness.getCurrent().sourceContext).toBeNull();
        expect(harness.getCurrent().chip).toBeNull();
        expect(harness.getCurrent().serverMismatch).toBe(false);
    });

    it('produces a removable composer badge from the one-shot seed', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            targetServerId: 'server_1',
        }));

        const chip = harness.getCurrent().chip;
        expect(chip?.key).toBe('session-source-context');
        expect(chip?.composerAttachmentBadge).toMatchObject({
            key: 'session-source-context',
            testID: 'agent-input-source-context-attachment-badge',
        });
        expect(typeof chip?.composerAttachmentBadge?.onRemove).toBe('function');
        expect(chip?.composerAttachmentBadge?.removeAccessibilityLabel)
            .toBe('session.sourceContext.removeA11y');
    });

    it('removing the chip clears only the continuation, not any other authored option', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            targetServerId: 'server_1',
        }));
        expect(harness.getCurrent().sourceContext).toEqual(SOURCE_CONTEXT);

        await act(async () => { harness.getCurrent().chip?.composerAttachmentBadge?.onRemove?.(); });

        expect(harness.getCurrent().sourceContext).toBeNull();
        expect(harness.getCurrent().chip).toBeNull();
        // The hook owns nothing but the continuation, so nothing else can be lost.
        expect(Object.keys(harness.getCurrent()).sort())
            .toEqual(['chip', 'remove', 'serverMismatch', 'sourceContext']);
    });

    it('reports a server mismatch instead of silently dropping the continuation', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            targetServerId: 'server_2',
        }));
        expect(harness.getCurrent().serverMismatch).toBe(true);
        expect(harness.getCurrent().sourceContext).toEqual(SOURCE_CONTEXT);
        // The chip says why rather than the recipe being dropped on the way out.
        expect(harness.getCurrent().chip?.composerAttachmentBadge?.accessibilityLabel)
            .toContain('session.sourceContext.serverMismatch');
    });

    it('explains the exact cutoff and offers removal from the detail sheet', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            targetServerId: 'server_1',
        }));
        await act(async () => { harness.getCurrent().chip?.composerAttachmentBadge?.onPress?.(); });

        expect(modalAlertMock).toHaveBeenCalledTimes(1);
        const [, body, actions] = modalAlertMock.mock.calls[0] as [string, string, any[]];
        expect(body).toContain('session.sourceContext.detailBodyAtMessage');
        const remove = actions.find((action) => action.style === 'destructive');
        expect(remove).toBeTruthy();
        await act(async () => { remove.onPress(); });
        expect(harness.getCurrent().sourceContext).toBeNull();
    });

    it('accepts a fresh continuation intent after an earlier one was removed', async () => {
        const seeds = {
            first: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            second: {
                sourceContext: { ...SOURCE_CONTEXT, sourceSessionId: 'parent_2' } as any,
                sourceContextServerId: 'server_1',
            },
        };
        const harness = await renderHook(
            (props: { seed: any }) => useNewSessionSourceContext({
                seed: props.seed,
                targetServerId: 'server_1',
            }),
            { initialProps: { seed: seeds.first } },
        );
        await act(async () => { harness.getCurrent().remove(); });
        expect(harness.getCurrent().sourceContext).toBeNull();

        await harness.rerender({ seed: seeds.second });
        expect(harness.getCurrent().sourceContext?.sourceSessionId).toBe('parent_2');
    });
});
