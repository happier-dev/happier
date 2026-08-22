import { describe, expect, it, vi } from 'vitest';

import { createDaemonShutdownCancellationDomains } from './shutdownCancellationDomains';

describe('daemon shutdown cancellation domains', () => {
    it('aborts daemon work and retires the daemon-owned Local Services runtime during shutdown', async () => {
        const domains = createDaemonShutdownCancellationDomains();
        const stop = vi.fn(async () => undefined);

        domains.beginShutdown();
        expect(domains.daemonWorkSignal.aborted).toBe(true);

        await domains.stopManagedLocalServices({ stop });

        expect(stop).toHaveBeenCalledOnce();
    });
});
