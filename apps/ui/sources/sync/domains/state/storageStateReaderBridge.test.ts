import { expect, it } from 'vitest';

import { readRegisteredStorageState, subscribeRegisteredStorageState } from './storageStateReaderBridge';

it('delivers Session publications to a subscriber admitted before storage initializes', async () => {
    expect(readRegisteredStorageState()).toBeNull();
    let publications = 0;
    const stop = subscribeRegisteredStorageState(() => { publications += 1; }, { sessions: true });
    const { storage } = await import('./storageStore');
    const initial = storage.getState();
    try {
        storage.setState({ sessions: { ...initial.sessions } });
        expect(publications).toBe(1);
        stop?.();
        storage.setState({ sessions: { ...initial.sessions } });
        expect(publications).toBe(1);
    } finally {
        stop?.();
        storage.setState(initial, true);
    }
});
