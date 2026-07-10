import { describe, expect, it, vi } from 'vitest';

import type { SessionStateFieldWriteValue } from '@happier-dev/agents';

import { writeSessionStateFieldWithMetadataPort } from './writeSessionStateFieldWithMetadataPort';

describe('writeSessionStateFieldWithMetadataPort', () => {
  it('fails closed for durable-required fields instead of writing metadata without an outbox', async () => {
    const updateMetadata = vi.fn(async () => undefined);
    const workState: SessionStateFieldWriteValue<'runtime.workState'> = {
      v: 1,
      backendId: 'codex-app-server',
      updatedAt: 123,
      items: [],
    };

    await expect(writeSessionStateFieldWithMetadataPort({
      sessionId: 'session-1',
      fieldId: 'runtime.workState',
      value: workState,
      updateMetadata,
      reason: 'reconciliation',
      metadataReason: 'work-state',
    })).resolves.toBe(false);

    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
