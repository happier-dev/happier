import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
    InitialPresentationReadinessProvider,
    type InitialPresentationReadinessBoundary,
    useInitialPresentationProducer,
} from './InitialPresentationReadinessContext';

function TerminalProducer(): null {
    useInitialPresentationProducer({
        producerKey: 'cached-terminal-producer',
        terminal: true,
    });
    return null;
}

function Harness(props: Readonly<{
    boundary: InitialPresentationReadinessBoundary;
}>): React.ReactElement {
    return (
        <InitialPresentationReadinessProvider value={props.boundary}>
            <TerminalProducer />
        </InitialPresentationReadinessProvider>
    );
}

describe('useInitialPresentationProducer', () => {
    it('completes an already-terminal producer when a pending presentation boundary replaces a disabled boundary', async () => {
        const complete = vi.fn();
        const dispose = vi.fn();
        const disabledBoundary: InitialPresentationReadinessBoundary = {
            presentationPending: false,
            registerProducer: vi.fn(),
        };
        const pendingBoundary: InitialPresentationReadinessBoundary = {
            presentationPending: true,
            registerProducer: vi.fn(() => ({ complete, dispose })),
        };
        const screen = await renderScreen(<Harness boundary={disabledBoundary} />);

        await screen.update(<Harness boundary={pendingBoundary} />);

        expect(pendingBoundary.registerProducer).toHaveBeenCalledWith('cached-terminal-producer');
        expect(complete).toHaveBeenCalledTimes(1);
        await screen.unmount();
        expect(dispose).toHaveBeenCalledTimes(1);
    });
});
