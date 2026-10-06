import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storage';
import {
    removeServerProfile,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
import { useNewSessionSourceContext } from './useNewSessionSourceContext';

const SOURCE_CONTEXT = {
    v: 1,
    kind: 'session_replay',
    sourceSessionId: 'parent_1',
    forkPoint: { type: 'seq', upToSeqInclusive: 12 },
} as const;

let previousState: ReturnType<typeof storage.getState>;
beforeEach(() => {
    previousState = storage.getState();
    modalAlertMock.mockReset();
    storage.setState({ sessions: {
        parent_1: createSessionFixture({ id: 'parent_1', serverId: 'server_1', metadata: {
            path: '/repo', host: 'source.local', summary: { text: 'Refactor the fork modal', updatedAt: 1 },
        } }),
    }, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
});

afterEach(async () => {
    await standardCleanup();
    storage.setState(previousState, true);
});

describe('useNewSessionSourceContext', () => {
    it('keeps the seeded Home title through duplicate ids, source changes, and unavailable source data', async () => {
        const sourceA = createSessionFixture({ id: 'parent_1', serverId: 'source-a', metadata: { name: 'Source A', path: '/repo-a', host: 'a.local' } });
        const sourceB = createSessionFixture({ id: 'parent_1', serverId: 'source-b', metadata: { name: 'Source B', path: '/repo-b', host: 'b.local' } });
        storage.setState({
            sessions: { parent_1: sourceA },
            sessionListRowsByServerId: { 'source-b': { parent_1: buildSessionListRenderableFromSession(sourceB) } },
        });
        const harness = await renderHook(({ serverId }: { serverId: string }) => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT, sourceContextServerId: serverId },
            targetServerId: serverId,
        }), { initialProps: { serverId: 'source-b' } });

        expect.soft(harness.getCurrent().presentation?.attachmentRowItem?.label).toContain('Source B');
        await act(async () => { storage.setState({ sessionListRowsByServerId: {} }); });
        expect.soft(harness.getCurrent().presentation?.attachmentRowItem?.label).toContain('session.sourceContext.unknownSession');
        await harness.rerender({ serverId: 'source-a' });
        expect.soft(harness.getCurrent().presentation?.attachmentRowItem?.label).toContain('Source A');
        await harness.rerender({ serverId: 'source-missing' });
        expect.soft(harness.getCurrent().presentation?.attachmentRowItem?.label).toContain('session.sourceContext.unknownSession');
        expect(harness.getCurrent().presentation?.attachmentRowItem?.label).not.toContain('Source A');
    });

    it('carries no continuation for an ordinary new Session', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: null,
            targetServerId: 'server_1',
        }));
        expect(harness.getCurrent().sourceContext).toBeNull();
        expect(harness.getCurrent().presentation).toBeNull();
        expect(harness.getCurrent().serverMismatch).toBe(false);
    });

    it('produces both halves of the removable chip from the one-shot seed', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            targetServerId: 'server_1',
        }));

        const presentation = harness.getCurrent().presentation;
        expect(presentation?.actionChip.key).toBe('session-source-context');
        expect(presentation?.attachmentRowItem).toMatchObject({
            kind: 'badge',
            key: 'session-source-context',
            testID: 'agent-input-source-context-attachment-badge',
        });
        expect(typeof presentation?.attachmentRowItem?.onRemove).toBe('function');
        expect(presentation?.attachmentRowItem?.removeAccessibilityLabel)
            .toBe('session.sourceContext.removeA11y');
    });

    it('removing the chip clears only the continuation, not any other authored option', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            targetServerId: 'server_1',
        }));
        expect(harness.getCurrent().sourceContext).toEqual(SOURCE_CONTEXT);

        await act(async () => { harness.getCurrent().presentation?.attachmentRowItem?.onRemove?.(); });

        expect(harness.getCurrent().sourceContext).toBeNull();
        expect(harness.getCurrent().presentation).toBeNull();
        // The hook owns nothing but the continuation, so nothing else can be lost.
        expect(Object.keys(harness.getCurrent()).sort())
            .toEqual(['presentation', 'remove', 'serverMismatch', 'sourceContext']);
    });

    it('reports a server mismatch instead of silently dropping the continuation', async () => {
        const harness = await renderHook(() => useNewSessionSourceContext({
            seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: 'server_1' },
            targetServerId: 'server_2',
        }));
        expect(harness.getCurrent().serverMismatch).toBe(true);
        expect(harness.getCurrent().sourceContext).toEqual(SOURCE_CONTEXT);
        // The chip says why instead of the recipe being dropped on the way out.
        expect(harness.getCurrent().presentation?.attachmentRowItem).toMatchObject({
            availability: 'invalid',
            error: 'session.sourceContext.serverMismatch',
        });
    });

    it('accepts a source Home alias when the target uses its canonical profile identity', async () => {
        const profileUrl = `https://source-alias-${Date.now()}-${Math.random().toString(16).slice(2)}.example.test`;
        const canonicalServerId = `srv_source_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const profile = await upsertServerProfile({ serverUrl: profileUrl, name: 'Alias test', source: 'manual' });
        const identifiedProfile = await setServerProfileIdentityForUrl(profileUrl, canonicalServerId);
        expect(identifiedProfile?.serverIdentityId).toBe(canonicalServerId);
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    parent_1: createSessionFixture({
                        id: 'parent_1',
                        serverId: profile.id,
                        metadata: { name: 'Alias source', path: '/alias-repo', host: 'alias.local' },
                    }),
                },
            }));
            const harness = await renderHook(() => useNewSessionSourceContext({
                seed: { sourceContext: SOURCE_CONTEXT as any, sourceContextServerId: profile.id },
                targetServerId: canonicalServerId,
            }));

            expect(harness.getCurrent().serverMismatch).toBe(false);
            expect(harness.getCurrent().presentation?.attachmentRowItem?.availability).not.toBe('invalid');
            await harness.unmount();
        } finally {
            await removeServerProfile(profile.id);
        }
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
