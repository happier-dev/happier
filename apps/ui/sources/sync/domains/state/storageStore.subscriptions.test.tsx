import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMessagesFixture, standardCleanup } from '@/dev/testkit';
import { storage } from './storageStore';
import { subscribeRegisteredStorageState } from './storageStateReaderBridge';

const initial = storage.getState();
afterEach(() => {
    standardCleanup();
    storage.setState(initial, true);
});

describe('storage notification locality', () => {
    it('delivers replaced snapshot keys through the registered path and leaves unchanged keys quiet', () => {
        const messages = vi.fn();
        const machines = vi.fn();
        const stopMessages = subscribeRegisteredStorageState(messages, { sessionMessages: ['snapshot-session'] });
        const stopMachines = subscribeRegisteredStorageState(machines, { machines: true });
        try {
            const before = storage.getState();
            const transcript = createSessionMessagesFixture({ isLoaded: true, messagesVersion: 7 });
            storage.setState({ ...before, sessionMessages: { 'snapshot-session': transcript } }, true);
            expect(messages).toHaveBeenCalledTimes(1);
            expect(messages.mock.calls[0][0].sessionMessages['snapshot-session']).toBe(transcript);
            expect(machines).not.toHaveBeenCalled();
            const nextMachines = { ...before.machines };
            storage.setState({ ...storage.getState(), machines: nextMachines }, true);
            expect(machines).toHaveBeenCalledTimes(1);
            expect(machines.mock.calls[0][0].machines).toBe(nextMachines);
            expect(messages).toHaveBeenCalledTimes(1);
        } finally { stopMessages?.(); stopMachines?.(); }
    });
});
