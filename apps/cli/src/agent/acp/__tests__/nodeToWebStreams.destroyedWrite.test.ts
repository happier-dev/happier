import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { nodeToWebStreams } from '../nodeToWebStreams';

class DestroyedWriteStream extends Writable {
  _write(_chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const err: any = new Error('Cannot call write after a stream was destroyed');
    err.code = 'ERR_STREAM_DESTROYED';
    callback(err);
  }
}

describe('nodeToWebStreams', () => {
  it('rejects a destroyed active stdin write so custody is not fabricated', async () => {
    const stdin = new DestroyedWriteStream();
    stdin.destroy();

    const stdout = new PassThrough();
    const { writable } = nodeToWebStreams(stdin, stdout);

    const writer = writable.getWriter();
    await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'ERR_STREAM_DESTROYED',
    });
    writer.releaseLock();
  });
});

