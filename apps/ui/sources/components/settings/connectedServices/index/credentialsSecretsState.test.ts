import { describe, expect, it } from 'vitest';

import { presentCredentialsSecretsState } from './credentialsSecretsState';

describe('presentCredentialsSecretsState (the one Secrets state for the rail and the overview)', () => {
    it('never says there are none before a current read settles', () => {
        expect(presentCredentialsSecretsState({ status: 'loading', stale: true, entryCount: 0 })).toBe('loading');
        expect(presentCredentialsSecretsState({ status: 'refreshing', stale: false, entryCount: 0 })).toBe('loading');
        expect(presentCredentialsSecretsState({ status: 'ready', stale: true, entryCount: 0 })).toBe('loading');
        expect(presentCredentialsSecretsState({ status: 'error', stale: true, entryCount: 0 })).toBe('failed');
        expect(presentCredentialsSecretsState({ status: 'ready', stale: false, entryCount: 0 })).toBe('empty');
    });

    it('keeps known secrets listed while they refresh or a refresh fails', () => {
        expect(presentCredentialsSecretsState({ status: 'refreshing', stale: true, entryCount: 3 })).toBe('ready');
        expect(presentCredentialsSecretsState({ status: 'error', stale: true, entryCount: 3 })).toBe('ready');
    });
});
