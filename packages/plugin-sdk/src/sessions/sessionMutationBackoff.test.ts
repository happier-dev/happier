import { afterEach, expect, it, vi } from 'vitest';

import { resolveSessionMutationRetryDelayMs } from './index.public';

afterEach(() => vi.unstubAllEnvs());

it('uses an explicit Session environment while preserving the standalone process default', () => {
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', '700');
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS', '30000');
    vi.stubEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', '0');
    const first = { HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS: '100', HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS: '0' };
    const second = { HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS: '200', HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS: '0' };
    expect([resolveSessionMutationRetryDelayMs(1, first), resolveSessionMutationRetryDelayMs(1, second),
        resolveSessionMutationRetryDelayMs(1)]).toEqual([200, 400, 1400]);
});
