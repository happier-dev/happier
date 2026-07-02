import { describe, expect, it, vi } from 'vitest';

import {
    registerExternalSessionFollowLeaseArchiveHandler,
    releaseExternalSessionFollowLeasesForArchivedSession,
} from './externalSessionFollowLeaseArchiveRegistry';

describe('externalSessionFollowLeaseArchiveRegistry', () => {
    it('notifies registered archive handlers and supports idempotent unregister', async () => {
        const handler = vi.fn(async () => {});
        const unregister = registerExternalSessionFollowLeaseArchiveHandler(handler);

        await releaseExternalSessionFollowLeasesForArchivedSession('session-1');
        unregister();
        unregister();
        await releaseExternalSessionFollowLeasesForArchivedSession('session-1');

        expect(handler).toHaveBeenCalledExactlyOnceWith('session-1');
    });

    it('continues archive cleanup when one handler fails', async () => {
        const failingHandler = vi.fn(async () => {
            throw new Error('cleanup failed');
        });
        const succeedingHandler = vi.fn(async () => {});
        const unregisterFailing = registerExternalSessionFollowLeaseArchiveHandler(failingHandler);
        const unregisterSucceeding = registerExternalSessionFollowLeaseArchiveHandler(succeedingHandler);

        await expect(releaseExternalSessionFollowLeasesForArchivedSession('session-2')).resolves.toBeUndefined();

        unregisterFailing();
        unregisterSucceeding();
        expect(failingHandler).toHaveBeenCalledExactlyOnceWith('session-2');
        expect(succeedingHandler).toHaveBeenCalledExactlyOnceWith('session-2');
    });
});
