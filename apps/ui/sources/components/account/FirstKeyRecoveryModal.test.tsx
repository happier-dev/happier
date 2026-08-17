import * as React from 'react';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { act } from 'react-test-renderer';

import {
    installModalComponentCommonModuleMocks,
} from '@/modal/components/modalComponentTestHelpers';

installModalComponentCommonModuleMocks();

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
}));

vi.mock('@/modal', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('@/modal')
        >();
    return {
        ...actual,
        Modal: {
            ...actual.Modal,
            confirm: mocks.confirm,
        },
    };
});

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

type FooterElement = React.ReactElement<{
    children: readonly React.ReactElement<{
        action: () => Promise<void>;
        onPress: () => void;
    }>[];
}>;

describe('FirstKeyRecoveryModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.confirm.mockResolvedValue(false);
    });

    it('runs finish single-flight and closes only after successful completion', async () => {
        const { createDeferred, renderScreen } =
            await import('@/dev/testkit');
        const {
            FirstKeyRecoveryModal,
        } = await import('./FirstKeyRecoveryModal');
        const deferred = createDeferred<
            Readonly<{ kind: 'completed' }>
        >();
        const finish = vi.fn(() => deferred.promise);
        const onSettled = vi.fn();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const screen = await renderScreen(
            <FirstKeyRecoveryModal
                finish={finish}
                abandon={vi.fn()}
                onSettled={onSettled}
                onClose={onClose}
                setChrome={setChrome}
            />,
        );
        const footer = setChrome.mock.calls.at(-1)?.[0]
            ?.footer as FooterElement;
        const finishAction =
            footer.props.children[0].props.action;

        let first!: Promise<void>;
        await act(async () => {
            first = finishAction();
            void finishAction();
        });
        expect(finish).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            deferred.resolve({ kind: 'completed' });
            await first;
        });
        expect(onSettled).toHaveBeenCalledWith(
            'finish',
        );
        expect(onClose).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('keeps a failed finish open, shows failure, and permits retry', async () => {
        const { renderScreen } =
            await import('@/dev/testkit');
        const {
            FirstKeyRecoveryModal,
        } = await import('./FirstKeyRecoveryModal');
        const finish = vi.fn()
            .mockResolvedValueOnce({
                kind: 'recovery_failed',
            })
            .mockResolvedValueOnce({
                kind: 'completed',
            });
        const onSettled = vi.fn();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const screen = await renderScreen(
            <FirstKeyRecoveryModal
                finish={finish}
                abandon={vi.fn()}
                onSettled={onSettled}
                onClose={onClose}
                setChrome={setChrome}
            />,
        );

        await act(async () => {
            const footer =
                setChrome.mock.calls.at(-1)?.[0]
                    ?.footer as FooterElement;
            await footer.props.children[0].props
                .action();
        });
        expect(
            screen.findByTestId(
                'first-key-recovery-error',
            ),
        ).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => {
            const footer =
                setChrome.mock.calls.at(-1)?.[0]
                    ?.footer as FooterElement;
            await footer.props.children[0].props
                .action();
        });
        expect(finish).toHaveBeenCalledTimes(2);
        expect(onSettled).toHaveBeenCalledWith(
            'finish',
        );
        expect(onClose).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('does not abandon when destructive confirmation is cancelled', async () => {
        const { renderScreen } =
            await import('@/dev/testkit');
        const {
            FirstKeyRecoveryModal,
        } = await import('./FirstKeyRecoveryModal');
        const abandon = vi.fn();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const screen = await renderScreen(
            <FirstKeyRecoveryModal
                finish={vi.fn()}
                abandon={abandon}
                onSettled={vi.fn()}
                onClose={onClose}
                setChrome={setChrome}
            />,
        );
        const footer = setChrome.mock.calls.at(-1)?.[0]
            ?.footer as FooterElement;

        await act(async () => {
            footer.props.children[2].props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(abandon).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
