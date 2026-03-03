import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scheduled: Array<() => void> = [];
const cancelSpy = vi.fn();

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'ios' },
        InteractionManager: {
            runAfterInteractions: (cb: () => void) => {
                scheduled.push(cb);
                return { cancel: cancelSpy };
            },
        },
        View: (props: any) => React.createElement('View', props, props.children),
    };
});

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 's1' }),
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: any) => React.createElement('SessionView', props),
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => null,
}));

describe('session/[id] route', () => {
    afterEach(() => {
        scheduled.length = 0;
        vi.useRealTimers();
        vi.resetModules();
        cancelSpy.mockClear();
    });

    it('defers mounting SessionView on native to keep navigation snappy', async () => {
        vi.useFakeTimers();
        const Route = (await import('@/app/(app)/session/[id]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Route />);
        });

        expect((tree as any).root.findAllByType('SessionView')).toHaveLength(0);
        expect(scheduled).toHaveLength(1);

        await act(async () => {
            scheduled[0]!();
        });

        expect((tree as any).root.findAllByType('SessionView')).toHaveLength(1);
    });
});
