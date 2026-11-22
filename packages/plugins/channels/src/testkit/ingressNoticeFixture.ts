import type { PluginServices } from '@happier-dev/plugin-sdk';
import { vi } from 'vitest';

type SendNotice = PluginServices['notifications']['send'];

/** Host boundaries used when ingress sends an Inbox notice without native deliveries. */
export function createIngressNoticeFixture(send?: SendNotice) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    diagnostic: vi.fn(),
  } satisfies PluginServices['logger'];
  const notifications = {
    send: vi.fn<SendNotice>(send ?? (async () => ({ deliveries: [], replayed: false }))),
  };
  return { logger, notifications };
}
