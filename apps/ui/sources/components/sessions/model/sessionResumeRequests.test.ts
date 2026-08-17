import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    emitSessionResumeRequest,
    useSessionResumeRequestListener,
} from './sessionResumeRequests';

describe('sessionResumeRequests', () => {
    it('rejects when the requested session has no registered resume listener', async () => {
        await expect(emitSessionResumeRequest('session-without-listener')).rejects.toThrow();
    });

    it('awaits only listeners registered for the requested session and unregisters on unmount', async () => {
        const requestedListener = vi.fn(async () => false);
        const otherSessionListener = vi.fn(async () => true);

        function ResumeListeners() {
            useSessionResumeRequestListener('requested-session', requestedListener);
            useSessionResumeRequestListener('other-session', otherSessionListener);
            return null;
        }

        const screen = await renderScreen(React.createElement(ResumeListeners));

        await expect(emitSessionResumeRequest('requested-session')).resolves.toBe(false);
        expect(requestedListener).toHaveBeenCalledTimes(1);
        expect(otherSessionListener).not.toHaveBeenCalled();

        await screen.unmount();
        await expect(emitSessionResumeRequest('requested-session')).rejects.toThrow();
    });
});
