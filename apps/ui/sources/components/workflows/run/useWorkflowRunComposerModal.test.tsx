import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import type { WorkflowRunComposerModalProps } from './useWorkflowRunComposerModal';
import { useWorkflowRunComposerModal } from './useWorkflowRunComposerModal';

const modalMock = vi.hoisted(() => {
    const show = vi.fn(() => 'modal-1');
    const update = vi.fn();
    const hide = vi.fn();
    return { show, update, hide };
});
const viewport = vi.hoisted(() => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }));

vi.mock('@/modal', () => ({
    Modal: { show: modalMock.show, update: modalMock.update, hide: modalMock.hide },
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => viewport });
});

function sheetProps(overrides: Partial<WorkflowRunComposerModalProps> = {}): WorkflowRunComposerModalProps {
    return {
        inputs: [],
        values: {},
        onChangeValues: () => {},
        onRun: () => {},
        onCancel: () => {},
        pending: false,
        ...overrides,
    } as WorkflowRunComposerModalProps;
}

describe('useWorkflowRunComposerModal', () => {
    afterEach(() => {
        viewport.width = 1440;
        modalMock.show.mockClear();
        modalMock.update.mockClear();
        modalMock.hide.mockClear();
    });

    it('uses one canonical phone sheet rather than a button-sized anchored popup', async () => {
        viewport.width = 390;
        const anchorRef = React.createRef<React.ElementRef<typeof View>>();
        const hook = await renderHook(() => useWorkflowRunComposerModal({ open: true, props: sheetProps(), anchorRef }));
        expect(hook.getCurrent()).toBeNull();
        expect(modalMock.show).toHaveBeenCalledWith(expect.objectContaining({
            focusReturnRef: anchorRef,
            chrome: expect.objectContaining({ phonePresentation: 'sheet', material: 'solid' }),
        }));
    });

    it('returns an anchored start surface without opening a second modal card', async () => {
        const anchorRef = React.createRef<React.ElementRef<typeof View>>();
        const hook = await renderHook(() => useWorkflowRunComposerModal({
            open: true, props: sheetProps(), anchorRef,
        }));
        expect(modalMock.show).not.toHaveBeenCalled();
        expect(React.isValidElement(hook.getCurrent())).toBe(true);
    });

    it('presents through the canonical modal owner and updates in place instead of stacking', async () => {
        const hook = await renderHook(
            (input: Readonly<{ props: WorkflowRunComposerModalProps }>) =>
                useWorkflowRunComposerModal({ open: true, props: input.props }),
            { initialProps: { props: sheetProps() } },
        );

        expect(modalMock.show).toHaveBeenCalledTimes(1);

        // A changed value must not open a second sheet over the first.
        await hook.rerender({ props: sheetProps({ pending: true }) });
        expect(modalMock.show).toHaveBeenCalledTimes(1);
        expect(modalMock.update).toHaveBeenCalledWith('modal-1', expect.objectContaining({ pending: true }));
    });

    it('presents nothing until the caller has both intent and a read definition', async () => {
        await renderHook(() => useWorkflowRunComposerModal({ open: false, props: sheetProps() }));
        expect(modalMock.show).not.toHaveBeenCalled();

        await renderHook(() => useWorkflowRunComposerModal({ open: true, props: null }));
        expect(modalMock.show).not.toHaveBeenCalled();
    });

    it('hides the sheet when the caller closes it and when the surface unmounts', async () => {
        const hook = await renderHook(
            (input: Readonly<{ open: boolean }>) =>
                useWorkflowRunComposerModal({ open: input.open, props: sheetProps() }),
            { initialProps: { open: true } },
        );
        expect(modalMock.show).toHaveBeenCalledTimes(1);

        await hook.rerender({ open: false });
        expect(modalMock.hide).toHaveBeenCalledWith('modal-1');

        // Reopening presents again rather than reusing a hidden id.
        modalMock.hide.mockClear();
        await hook.rerender({ open: true });
        expect(modalMock.show).toHaveBeenCalledTimes(2);

        await hook.unmount();
        expect(modalMock.hide).toHaveBeenCalledWith('modal-1');
    });
});
