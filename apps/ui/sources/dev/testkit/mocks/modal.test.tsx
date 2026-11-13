import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { CustomModalInjectedProps } from '@/modal/types';
import { createModalModuleMock } from './modal';

vi.mock('react-native', async () =>
    (await import('./reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
    (await import('./unistyles')).createUnistylesMock(),
);

afterEach(standardCleanup);

it.each([false, true])('keeps an Action review pending until the public person-choice controller answers (%s)', async (accepted) => {
    const decision = createDeferred<boolean>();
    const { module: modal } = createModalModuleMock();
    vi.spyOn(modal.Modal, 'confirm').mockImplementationOnce(() => decision.promise);
    const onAnswer = vi.fn();
    modal.Modal.show({
        component: () => null,
        props: { onAnswer },
        chrome: { kind: 'card', title: 'Review this action', testID: 'actions.confirmation-review.modal' },
    });
    await vi.waitFor(() => expect(modal.Modal.confirm).toHaveBeenCalledOnce());
    expect(onAnswer).not.toHaveBeenCalled();
    decision.resolve(accepted);
    await vi.waitFor(() => expect(onAnswer).toHaveBeenCalledWith(accepted));
});

it('leaves a rendered Action review open for its real controls', async () => {
    const { module: modal } = createModalModuleMock({ renderCustomModals: true, confirmResult: true });
    const onAnswer = vi.fn();
    modal.Modal.show({
        component: () => null,
        props: { onAnswer },
        chrome: { kind: 'card', title: 'Review this action', testID: 'actions.confirmation-review.modal' },
    });
    await Promise.resolve();
    expect(modal.Modal.confirm).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
});

it('publishes custom modal chrome without feeding it back into content, while preserving content updates', async () => {
    const { module: modal } = createModalModuleMock({ renderCustomModals: true });
    let renders = 0;
    function Content(props: CustomModalInjectedProps & Readonly<{ label: string }>) {
        renders += 1;
        // Fail a publication cycle before it starves the runner's timers, as the real modal owner test does.
        if (renders > 8) throw new Error('chrome publication re-entered custom modal content');
        const [phase, setPhase] = React.useState(0);
        React.useEffect(() => {
            props.setChrome?.({ kind: 'card', footer: React.createElement('ModalFooter', { testID: 'modal-footer' }, phase) });
        });
        return React.createElement('ModalContent', { testID: 'modal-content', onPress: () => setPhase(value => value + 1) }, `${props.label}:${phase}`);
    }
    const id = modal.Modal.show({ component: Content, props: { label: 'First' } });
    const screen = await renderScreen(<modal.ModalProvider />);
    try {
        expect(screen.findByTestId('modal-footer')?.children).toEqual(['0']);
        await screen.pressByTestIdAsync('modal-content');
        expect(screen.findByTestId('modal-footer')?.children).toEqual(['1']);
        await act(async () => { modal.Modal.update(id, { label: 'Updated' }); });
        expect(screen.getTextContent()).toContain('Updated:1');
        expect(renders).toBe(3);
    } finally { await screen.unmount(); }
});
