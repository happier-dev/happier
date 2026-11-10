import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { createExternalActionHeaderRefusalError } from './externalActionHeaderRefusal';

afterEach(() => vi.restoreAllMocks());

it('logs one content-free refusal in the ordinary CLI file log', () => {
  const log = vi.spyOn(logger, 'infoFile');
  const error = createExternalActionHeaderRefusalError();
  expect(error).toMatchObject({ ok: false, errorCode: 'action_failed',
    requestId: expect.any(String), effectAttempted: false,
    details: { authorizationRefusalReason: 'authorization_headers_missing' } });
  expect(log.mock.calls).toEqual([['[ExternalAction] Header authorization refused', {
    reason: 'authorization_headers_missing', requestId: error.requestId,
  }]]);
});
