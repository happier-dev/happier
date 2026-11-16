import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createAcpNdJsonStream } from '../createAcpNdJsonStream';

const capture = vi.hoisted(() => ({ chunks: [] as string[] }));

// Filesystem writes are the boundary; the real ACP stream and Session owner run.
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  createWriteStream: () => new Writable({ write(chunk, _encoding, done) {
    capture.chunks.push(chunk.toString());
    done();
  } }),
}));

afterEach(() => { capture.chunks.length = 0; vi.unstubAllEnvs(); });

it.each(['0', '1'])('captures only the enabled hosted Session messages with host capture flag %s', async hostFlag => {
  vi.stubEnv('HAPPIER_ACP_CAPTURE_IO', hostFlag);
  await Promise.all(['0', '1'].map(flag => runAddedHostedSession({
    environment: { NODE_ENV: 'test', HAPPIER_ACP_CAPTURE_IO: flag }, workingDirectory: process.cwd(), end() {},
  }, async () => {
    await Promise.resolve();
    const stream = createAcpNdJsonStream(new WritableStream<Uint8Array>(), new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    }));
    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: '2.0', id: Number(flag), method: `session-${flag}`, params: {} });
    await writer.close();
  })));
  expect(capture.chunks.map(chunk => JSON.parse(chunk).method)).toEqual(['session-1']);
});
