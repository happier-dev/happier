import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import type { CustomModalInjectedProps } from '@/modal/types';
import { createModalModuleMock } from './modal';

vi.mock('react-native', async () =>
    (await import('./reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
    (await import('./unistyles')).createUnistylesMock(),
);

afterEach(standardCleanup);

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
