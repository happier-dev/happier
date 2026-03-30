import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';

import { createAcpSubprocessEnvScope } from '../testkit/subprocessHarness';

const createdCaptureStreams: PassThrough[] = [];

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    createWriteStream: vi.fn((_path: string, _opts: unknown) => {
      const stream = new PassThrough();
      createdCaptureStreams.push(stream);
      return stream as any;
    }),
  };
});

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('nodeToWebStreams (capture stream errors)', () => {
  const envScope = createAcpSubprocessEnvScope();

  beforeEach(() => {
    createdCaptureStreams.length = 0;
    vi.mocked(createWriteStream).mockImplementation((_path: any, _opts?: any) => {
      const stream = new PassThrough();
      createdCaptureStreams.push(stream);
      return stream as any;
    });
    envScope.patch({
      HAPPIER_ACP_CAPTURE_IO: '1',
      HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/happier-nodeToWebStreams-capture-errors.trace',
    });
  });

  afterEach(() => {
    envScope.restore();
  });

  it('attaches error listeners to capture streams', async () => {
    const { nodeToWebStreams } = await import('../nodeToWebStreams');
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    nodeToWebStreams(stdin, stdout);

    expect(createdCaptureStreams).toHaveLength(2);
    expect(createdCaptureStreams[0].listenerCount('error')).toBeGreaterThan(0);
    expect(createdCaptureStreams[1].listenerCount('error')).toBeGreaterThan(0);
  });

  it('closes stdin capture stream when stdout capture setup fails', async () => {
    const firstStream = new PassThrough();
    let callCount = 0;
    vi.mocked(createWriteStream).mockImplementation((_path: any, _opts?: any) => {
      callCount += 1;
      if (callCount === 1) {
        createdCaptureStreams.push(firstStream);
        return firstStream as any;
      }
      throw new Error('failed to create stdout capture stream');
    });

    const { nodeToWebStreams } = await import('../nodeToWebStreams');
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    nodeToWebStreams(stdin, stdout);

    expect(callCount).toBe(2);
    expect(firstStream.writableEnded || firstStream.destroyed).toBe(true);
  });
});
