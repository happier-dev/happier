import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createDeferred } from '@/testkit/async/deferred';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createVendorResumeIdMetadataPublisher } from './createVendorResumeIdMetadataPublisher';

describe('createVendorResumeIdMetadataPublisher', () => {
  it('derives the metadata field from the manifest, preserves metadata, and awaits the write', async () => {
    let metadata = createTestMetadata({ name: 'keep-me' });
    const write = createDeferred<void>();
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (updater) => {
        metadata = updater(metadata);
        await write.promise;
      },
    });

    let settled = false;
    const publishing = publisher.persistBound({
      generation: 3,
      operation: 'create',
      vendorSessionId: ' qwen-1 ',
    }).then(() => { settled = true; });

    await Promise.resolve();
    expect(metadata).toEqual(createTestMetadata({ name: 'keep-me', qwenSessionId: 'qwen-1' }));
    expect(settled).toBe(false);

    write.resolve(undefined);
    await publishing;
    expect(settled).toBe(true);
  });

  it('shares an in-flight write and deduplicates only after success', async () => {
    const write = createDeferred<void>();
    const updateMetadata = vi.fn(async (_updater: (metadata: Metadata) => Metadata) => {
      await write.promise;
    });
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'kimi',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    const event = { generation: 0, operation: 'resume' as const, vendorSessionId: 'kimi-1' };

    const first = publisher.persistBound(event);
    const second = publisher.persistBound(event);
    expect(updateMetadata).toHaveBeenCalledTimes(1);

    write.resolve(undefined);
    await Promise.all([first, second]);
    await publisher.persistBound(event);
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('propagates a write failure and permits an exact retry', async () => {
    const updateMetadata = vi.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined);
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'kilo',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    const event = { generation: 1, operation: 'create' as const, vendorSessionId: 'kilo-1' };

    await expect(publisher.persistBound(event)).rejects.toThrow('write failed');
    await expect(publisher.persistBound(event)).resolves.toBeUndefined();
    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('does not rewrite an exact resume identity that is already durable in metadata', async () => {
    const metadata = createTestMetadata({ qwenSessionId: 'resume-1' });
    const updateMetadata = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => metadata,
      updateMetadata,
    });

    await expect(publisher.persistBound({
      generation: 2,
      operation: 'resume',
      vendorSessionId: ' resume-1 ',
    })).resolves.toBeUndefined();
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('persists and retries a resumed identity when metadata is not already durable', async () => {
    const updateMetadata = vi.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined);
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    const event = { generation: 2, operation: 'resume' as const, vendorSessionId: 'resume-1' };

    await expect(publisher.persistBound(event)).rejects.toThrow('write failed');
    await expect(publisher.persistBound(event)).resolves.toBeUndefined();
    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('still requires an acknowledged write for created identities even when the local snapshot matches', async () => {
    const updateMetadata = vi.fn().mockRejectedValue(new Error('write failed'));
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => createTestMetadata({ qwenSessionId: 'created-1' }),
      updateMetadata,
    });

    await expect(publisher.persistBound({
      generation: 2,
      operation: 'create',
      vendorSessionId: 'created-1',
    })).rejects.toThrow('write failed');
    expect(updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('writes again for a new generation even when the opaque id is unchanged', async () => {
    const updateMetadata = vi.fn(async () => {});
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'copilot',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });

    await publisher.persistBound({ generation: 4, operation: 'create', vendorSessionId: 'same-id' });
    await publisher.persistBound({ generation: 5, operation: 'resume', vendorSessionId: 'same-id' });

    expect(updateMetadata).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty bound identity and an agent without a vendor resume field', async () => {
    const updateMetadata = vi.fn(async () => {});
    const publisher = createVendorResumeIdMetadataPublisher({
      agentId: 'qwen',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    });
    await expect(publisher.persistBound({
      generation: 0,
      operation: 'create',
      vendorSessionId: '   ',
    })).rejects.toThrow(/bound vendor session identity/i);
    expect(updateMetadata).not.toHaveBeenCalled();

    expect(() => createVendorResumeIdMetadataPublisher({
      agentId: 'customAcp',
      getMetadataSnapshot: () => createTestMetadata(),
      updateMetadata,
    })).toThrow(/does not declare a vendor resume metadata field/i);
  });
});
