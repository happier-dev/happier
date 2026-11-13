import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Network/guest OS boundary only; constructed from Railway API v2 and files wire v3.16.0. */
export function railwayVendor() {
  const home = mkdtempSync(join(tmpdir(), 'railway-'));
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const sockets: { url: string; protocols: string[]; closed: boolean }[] = [];
  const writes: { path: string; parentMode: number }[] = [];
  let present = false, foreignPresent = true, failure = false, loseCreate = false, status = 'RUNNING', badFile = false, timedOut = false;
  let abortFile: (() => void) | undefined;
  const dto = () => ({ id: 'sandbox-one', environmentId: 'environment-one', status: present ? status : 'DESTROYED', idleTimeoutMinutes: 0, region: 'us-west2', networkIsolation: 'ISOLATED', domains: [], createdAt: '2026-11-01T00:00:00Z' });
  const request: typeof fetch = async (_url, init) => {
    init?.signal?.throwIfAborted();
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    const { query, variables } = body;
    let data: unknown;
    if (failure) return Response.json({ errors: [{ message: 'private-token', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
    if (query.includes('sandboxCreate(')) { present = true; data = { sandboxCreate: dto() }; if (loseCreate) throw new Error('lost create'); }
    else if (query.includes('sandboxDestroy(')) {
      if (variables.id === 'sandbox-foreign') { foreignPresent = false; data = { sandboxDestroy: { ...dto(), id: 'sandbox-foreign', status: 'DESTROYED' } }; }
      else if (variables.id === 'sandbox-one') { present = false; data = { sandboxDestroy: dto() }; }
      else data = { sandboxDestroy: null };
    }
    else if (query.includes('sandboxExec(')) {
      const command = String(variables.command);
      const result = spawnSync('sh', ['-c', command], { env: { ...process.env, HOME: home } });
      if ('error' in result && result.error) throw result.error;
      const commandTimedOut = timedOut && command.includes('2>');
      data = { sandboxExec: { exitCode: commandTimedOut ? -1 : result.status ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString(), truncated: false, timedOut: commandTimedOut } };
    } else if (query.includes('generateShellToken(')) data = { generateShellToken: 'scoped-files-token' };
    else if (query.includes('sandbox(')) data = { sandbox: variables.id === 'sandbox-foreign'
      ? foreignPresent ? { ...dto(), id: 'sandbox-foreign', status: 'RUNNING' } : null
      : variables.id === 'sandbox-one' && present ? dto() : null };
    else if (query.includes('me')) data = { me: { id: 'account-one', name: 'Railway account', email: 'owner@example.test' } };
    else throw new Error('Unrecognized GraphQL boundary');
    return Response.json({ data });
  };
  class Socket extends EventTarget {
    binaryType = 'arraybuffer';
    bufferedAmount = 0;
    private path = '';
    private chunks: Uint8Array[] = [];
    private size = 0;
    private sequence = 0;
    private record: typeof sockets[number];
    constructor(url: string | URL, protocols?: string | string[]) {
      super(); this.record = { url: String(url), protocols: typeof protocols === 'string' ? [protocols] : protocols ?? [], closed: false }; sockets.push(this.record);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    private message(data: string | ArrayBuffer) { queueMicrotask(() => { if (!this.record.closed) this.dispatchEvent(new MessageEvent('message', { data })); }); }
    send(value: string | ArrayBufferView | ArrayBuffer) {
      if (typeof value === 'string') {
        const frame = JSON.parse(value);
        if (frame.id !== '1') throw new Error('Unexpected request ID');
        if (frame.type === 'write_start') {
          this.path = frame.data.path; this.size = frame.data.size;
          writes.push({ path: this.path, parentMode: statSync(dirname(this.path)).mode & 0o777 });
          if (abortFile) { abortFile(); return; }
          this.message(JSON.stringify({ type: badFile ? 'ok' : 'write_ready', id: '1', data: {} }));
        } else if (frame.type === 'read') {
          const content = readFileSync(frame.data.path);
          let sequence = 0;
          for (let offset = 0; offset < content.length; offset += 64 * 1024) {
            const chunk = content.subarray(offset, offset + 64 * 1024);
            const result = new Uint8Array(chunk.length + 12), view = new DataView(result.buffer);
            view.setUint16(0, 1); view.setUint16(2, 1); view.setUint32(4, sequence++); view.setUint32(8, chunk.length); result.set(chunk, 12);
            this.message(result.buffer);
          }
          const end = new ArrayBuffer(12), header = new DataView(end);
          header.setUint16(0, 1); header.setUint16(2, 2); header.setUint32(4, sequence);
          this.message(end);
        } else throw new Error('Unexpected files request');
      } else {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), type = header.getUint16(2);
        if (header.getUint16(0) !== 1 || header.getUint32(4) !== this.sequence++ || header.getUint32(8) !== bytes.length - 12 || ![3, 4].includes(type)) throw new Error('Invalid files binary frame');
        if (bytes.length - 12 > 64 * 1024) throw new Error('Oversized Railway content frame');
        this.chunks.push(bytes.slice(12));
        if (type === 4) {
          const content = Buffer.concat(this.chunks);
          if (content.length !== this.size) throw new Error('Wrong file size');
          mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, content);
          this.message(JSON.stringify({ type: 'ok', id: '1', data: {} }));
        }
      }
    }
    close() { if (this.record.closed) return; this.record.closed = true; this.dispatchEvent(new Event('close')); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
  return { home, request, calls, sockets, writes, dto,
    get present() { return present; }, get foreignPresent() { return foreignPresent; }, setFailure(v: boolean) { failure = v; }, loseCreate() { loseCreate = true; },
    abortFiles(callback: () => void) { abortFile = callback; }, setStatus(v: string) { status = v; }, badFile(v: boolean) { badFile = v; }, timeout(v: boolean) { timedOut = v; },
    cleanup() { if (original) Object.defineProperty(globalThis, 'WebSocket', original); else Reflect.deleteProperty(globalThis, 'WebSocket'); rmSync(home, { recursive: true, force: true }); } };
}
