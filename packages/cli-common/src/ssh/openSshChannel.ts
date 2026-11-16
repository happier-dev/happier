import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { buildOpenSshCommand } from './openSshTransport.js';

export type OpenSshRemoteChannel = Duplex & Readonly<{
  /** Observes the SSH carrier only; disconnect never establishes guest-process exit. */
  completion: Promise<Readonly<{ status: number | null; signal: NodeJS.Signals | null }>>;
}>;

/** An unbounded binary protocol channel; SSH owns connection/liveness defaults. */
export function openOpenSshRemoteChannel(request: Omit<Parameters<typeof buildOpenSshCommand>[0], 'sshBin' | 'tty'> & Readonly<{
  sshBin?: string;
  signal?: AbortSignal;
}>): OpenSshRemoteChannel {
  request.signal?.throwIfAborted();
  const invocation = buildOpenSshCommand({ ...request, sshBin: request.sshBin ?? 'ssh', tty: false });
  const child = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    ...(invocation.env ? { env: invocation.env } : {}) });
  let closed = false;
  const closeWhenDrained = () => {
    if (closed && channel.readableEnded && channel.writableFinished) channel.destroy();
  };
  const channel = new Duplex({
    autoDestroy: false,
    read() { child.stdout.resume(); },
    write(chunk: Buffer, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
    final(callback) { child.stdin.end(callback); },
    destroy(error, callback) {
      if (!closed) child.kill('SIGTERM');
      callback(error);
    },
  });
  child.stdout.on('data', (bytes: Buffer) => { if (!channel.destroyed && !channel.push(bytes)) child.stdout.pause(); });
  child.stdout.once('end', () => {
    if (channel.destroyed) return;
    channel.push(null);
    if (!channel.writableEnded) channel.end();
  });
  child.stdin.once('error', error => channel.destroy(error));
  channel.once('end', closeWhenDrained);
  channel.once('finish', closeWhenDrained);
  // Carrier diagnostics cannot enter the guest byte protocol or an Agent transcript.
  child.stderr.resume();
  const completion = new Promise<Readonly<{ status: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
    child.once('close', (status, signal) => { closed = true; resolve({ status, signal }); closeWhenDrained(); });
    child.once('error', error => { reject(error); channel.destroy(error); });
  });
  // Streaming consumers observe errors through the Duplex; finite callers can also await completion.
  void completion.catch(() => {});
  const abort = () => channel.destroy();
  request.signal?.addEventListener('abort', abort, { once: true });
  channel.once('close', () => {
    request.signal?.removeEventListener('abort', abort);
  });
  if (request.signal?.aborted) abort();
  return Object.assign(channel, { completion });
}
