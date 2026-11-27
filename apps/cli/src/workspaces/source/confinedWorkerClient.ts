import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { clearTimeout, setTimeout } from 'node:timers';

import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';

import type { SessionHolderChild, SessionHolderStreamProcess } from '@/subprocess/supervision/sessionHolder';

import type { WorkspaceChildProcess } from './workspaceSource';

export type ConfinedTargetEntry = Readonly<{
  kind: string;
  size: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  dev: number;
  ino: number;
}>;

export type ConfinedTargetListEntry = Readonly<{
  name: string;
  kind: string;
  stats?: Pick<ConfinedTargetEntry, 'size' | 'mtimeMs'> | null;
}>;

export type ConfinedTargetResult = Readonly<{
  status: string;
  entry?: ConfinedTargetEntry;
  entries?: readonly ConfinedTargetListEntry[];
  target?: string;
  path?: string;
  sha256?: string;
  digest?: string;
  contentBase64?: string;
  code?: string;
  message?: string;
}>;

export type ConfinedSyncResult = Readonly<{
  v: number;
  t: string;
  status: string;
  code?: string;
  message?: string;
  recoveryPath?: string;
  expectation?: unknown;
  sizeBytes?: number;
  materialPath?: string | null;
  contentBase64?: string;
  digest?: string;
  actualDigest?: string;
  size?: number;
  rootPath?: string;
  operationId?: string;
}>;

export type ConfinedWorkerRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export class ConfinedWorkerUnsupportedError extends Error {
  readonly code = 'confined_worker_unsupported';
  constructor(message = 'Guest helper does not support workspace-confined-serve') {
    super(message);
    this.name = 'ConfinedWorkerUnsupportedError';
  }
}

type ServeResponseHeader = Readonly<{
  v: number;
  id?: string;
  t: string;
  bodyBytes?: number;
  result?: unknown;
  results?: readonly ConfinedTargetResult[];
  code?: string;
  message?: string;
}>;

type FrameHandler = (header: ServeResponseHeader, body: Buffer) => void;

type PendingRequest = {
  onFrame: FrameHandler;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export const CONFINED_WORKER_MAX_BODY_BYTES = 128 * 1024 * 1024;
export const CONFINED_WORKER_MAX_HEADER_BYTES = 64 * 1024 * 1024;
export const VIRTUAL_SYNC_MAX_REQUEST_LINE_BYTES = 64 * 1024;

const EMPTY_BUFFER = Buffer.alloc(0);

const CONFINED_SYNC_COMMAND_TO_OP: ReadonlyMap<string, string> = new Map<string, string>([
  ['workspace-confined-read', 'read'],
  ['workspace-confined-delete', 'delete'],
  ['workspace-confined-observe', 'observe'],
  ['workspace-confined-capture', 'capture'],
  ['workspace-confined-apply', 'apply'],
  ['workspace-confined-recover', 'recover'],
  ['workspace-confined-inspect', 'inspect'],
]);

function ioFailed(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'io_failed' });
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return Object.assign(new Error(typeof reason === 'string' && reason ? reason : 'The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

function timeoutError(timeoutMs: number): Error {
  return Object.assign(new Error(`Confined workspace worker request timed out after ${timeoutMs}ms`), {
    name: 'TimeoutError',
    code: 'ETIMEDOUT',
  });
}

export type ConfinedWorkerFrameDecoderLimits = Readonly<{
  maxHeaderBytes?: number;
  maxBodyBytes?: number;
}>;

export function createFrameDecoder(
  onFrame: FrameHandler,
  onError: (error: Error) => void,
  limits?: ConfinedWorkerFrameDecoderLimits,
): (chunk: Buffer) => void {
  const maxHeaderBytes = limits?.maxHeaderBytes ?? CONFINED_WORKER_MAX_HEADER_BYTES;
  const maxBodyBytes = limits?.maxBodyBytes ?? CONFINED_WORKER_MAX_BODY_BYTES;
  let mode: 'header' | 'body' = 'header';
  let headerChunks: Buffer[] = [];
  let headerBytes = 0;
  let bodyChunks: Buffer[] = [];
  let bodyBytesCollected = 0;
  let currentHeader: ServeResponseHeader | null = null;
  let expectedBodyBytes = 0;
  let failed = false;

  const fail = (error: Error): void => {
    if (failed) return;
    failed = true;
    headerChunks = [];
    headerBytes = 0;
    bodyChunks = [];
    bodyBytesCollected = 0;
    currentHeader = null;
    expectedBodyBytes = 0;
    onError(error);
  };

  return (chunk: Buffer) => {
    if (failed || chunk.byteLength === 0) return;
    let pos = 0;
    while (!failed && pos < chunk.byteLength) {
      if (mode === 'header') {
        const nl = chunk.indexOf(0x0a, pos);
        if (nl < 0) {
          const rem = chunk.byteLength - pos;
          if (headerBytes + rem > maxHeaderBytes) {
            fail(ioFailed(`Confined worker header line exceeds limit (${maxHeaderBytes} bytes)`));
            return;
          }
          headerChunks.push(pos === 0 ? chunk : chunk.subarray(pos));
          headerBytes += rem;
          return;
        }
        const partLen = nl - pos;
        if (headerBytes + partLen > maxHeaderBytes) {
          fail(ioFailed(`Confined worker header line exceeds limit (${maxHeaderBytes} bytes)`));
          return;
        }
        const tail = chunk.subarray(pos, nl);
        const lineBuf = headerChunks.length === 0
          ? tail
          : Buffer.concat([...headerChunks, tail], headerBytes + partLen);
        headerChunks = [];
        headerBytes = 0;
        pos = nl + 1;

        const line = lineBuf.toString('utf8').replace(/\r$/u, '');
        if (!line) continue;
        let parsed: ServeResponseHeader;
        try {
          parsed = JSON.parse(line) as ServeResponseHeader;
        } catch (error) {
          fail(ioFailed(`Confined worker returned invalid JSON frame: ${String(error)}`));
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(ioFailed('Confined worker returned non-object JSON frame'));
          return;
        }
        if (
          parsed.bodyBytes !== undefined
          && (
            typeof parsed.bodyBytes !== 'number'
            || !Number.isSafeInteger(parsed.bodyBytes)
            || parsed.bodyBytes < 0
            || parsed.bodyBytes > maxBodyBytes
          )
        ) {
          fail(ioFailed(`Confined worker returned invalid bodyBytes: ${String(parsed.bodyBytes)}`));
          return;
        }
        const bodyBytes = typeof parsed.bodyBytes === 'number' && parsed.bodyBytes > 0 ? parsed.bodyBytes : 0;
        if (bodyBytes > 0) {
          currentHeader = parsed;
          expectedBodyBytes = bodyBytes;
          bodyChunks = [];
          bodyBytesCollected = 0;
          mode = 'body';
          continue;
        }
        onFrame(parsed, EMPTY_BUFFER);
        continue;
      }

      const need = expectedBodyBytes - bodyBytesCollected;
      const avail = chunk.byteLength - pos;
      if (avail < need) {
        bodyChunks.push(pos === 0 ? chunk : chunk.subarray(pos));
        bodyBytesCollected += avail;
        return;
      }
      const slice = chunk.subarray(pos, pos + need);
      const body = bodyChunks.length === 0
        ? Buffer.from(slice)
        : Buffer.concat([...bodyChunks, slice], expectedBodyBytes);
      bodyChunks = [];
      bodyBytesCollected = 0;
      const header = currentHeader!;
      currentHeader = null;
      expectedBodyBytes = 0;
      mode = 'header';
      pos += need;
      onFrame(header, body);
    }
  };
}

function waitForWritableDrain(
  stream: Writable,
  extraCloseEmitter: EventEmitter | null,
  callback: () => void,
): void {
  if (stream.writableEnded || stream.destroyed) {
    callback();
    return;
  }
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    stream.off('drain', done);
    stream.off('close', done);
    stream.off('error', done);
    stream.off('finish', done);
    extraCloseEmitter?.off('close', done);
    extraCloseEmitter?.off('error', done);
    callback();
  };
  stream.once('drain', done);
  stream.once('close', done);
  stream.once('error', done);
  stream.once('finish', done);
  extraCloseEmitter?.once('close', done);
  extraCloseEmitter?.once('error', done);
}

class LiveWorkerProcess {
  readonly ready: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private readySettled = false;
  private closed = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly onHolderGone: () => void;

  constructor(
    private readonly holder: SessionHolderChild,
    private readonly helperPath: string,
    private readonly guestRoot: string,
    private readonly onUnsupported: () => void,
    private readonly onClosed: (worker: LiveWorkerProcess) => void,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Avoid unhandled rejection warnings if startup fails while no caller awaits `ready` synchronously.
    this.ready.catch(() => undefined);

    this.stream = holder.spawnStream({
      argv: [helperPath, 'workspace-confined-serve', '--root', guestRoot],
    });
    this.onHolderGone = () => {
      this.failAll(ioFailed('Holder channel closed while confined worker was active'));
      if (!this.stream.stdin.writableEnded) {
        this.stream.stdin.end();
      }
    };
    holder.once('holderDisconnected', this.onHolderGone);
    holder.once('close', this.onHolderGone);
    holder.once('exit', this.onHolderGone);

    let stderr = '';
    const decode = createFrameDecoder(
      (header, body) => this.handleFrame(header, body),
      (error) => {
        this.failAll(error);
        this.closeGracefully();
      },
    );
    this.stream.stdout.on('data', (chunk: Buffer) => decode(chunk));
    this.stream.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });
    this.stream.stdin.on('error', (error: Error) => {
      this.failAll(error);
    });
    this.stream.once('error', (error: Error) => {
      this.failAll(error);
    });
    this.stream.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.readySettled && code === 2) {
        this.onUnsupported();
        this.failAll(new ConfinedWorkerUnsupportedError());
        return;
      }
      const detail = stderr.trim();
      const message = detail
        ? `Confined workspace worker exited (${code ?? signal ?? 'unknown'}): ${detail}`
        : `Confined workspace worker exited (${code ?? signal ?? 'unknown'})`;
      this.failAll(ioFailed(message));
    });
  }

  private readonly stream: SessionHolderStreamProcess;

  get isClosed(): boolean {
    return this.closed;
  }

  allocateId(): string {
    return String(this.nextId++);
  }

  writeFrame(header: Record<string, unknown>, body?: Uint8Array): boolean {
    if (this.closed) throw ioFailed('Confined workspace worker is closed');
    const bodyBytes = body?.byteLength ?? 0;
    if (bodyBytes > CONFINED_WORKER_MAX_BODY_BYTES) {
      throw ioFailed(`Confined worker request body exceeds limit (${CONFINED_WORKER_MAX_BODY_BYTES} bytes)`);
    }
    const headerObj = bodyBytes > 0 ? { v: 1, ...header, bodyBytes } : { v: 1, ...header };
    const headerBuf = Buffer.from(`${JSON.stringify(headerObj)}\n`, 'utf8');
    if (body && bodyBytes > 0) {
      const payload = Buffer.concat([headerBuf, Buffer.from(body.buffer, body.byteOffset, bodyBytes)]);
      return this.stream.stdin.write(payload);
    }
    return this.stream.stdin.write(headerBuf);
  }

  waitForStdinDrain(callback: () => void): void {
    if (this.closed) {
      callback();
      return;
    }
    waitForWritableDrain(this.stream.stdin, this.stream as unknown as EventEmitter, callback);
  }

  registerHandler(id: string, entry: PendingRequest): void {
    if (this.closed) {
      entry.cleanup();
      entry.reject(ioFailed('Confined workspace worker is closed'));
      return;
    }
    this.pending.set(id, entry);
  }

  unregisterHandler(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.cleanup();
  }

  sendCancel(id: string): void {
    if (this.closed) return;
    try {
      this.writeFrame({ id, op: 'cancel' });
    } catch {
      // Best-effort cancel on a closing worker.
    }
  }

  closeGracefully(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachHolderListeners();
    this.onClosed(this);
    if (!this.stream.stdin.writableEnded) {
      this.stream.stdin.end();
    }
  }

  private detachHolderListeners(): void {
    this.holder.off('holderDisconnected', this.onHolderGone);
    this.holder.off('close', this.onHolderGone);
    this.holder.off('exit', this.onHolderGone);
  }

  private handleFrame(header: ServeResponseHeader, body: Buffer): void {
    if (!this.readySettled) {
      if (header.t === 'workspace-confined-serve-ready') {
        this.readySettled = true;
        this.resolveReady();
        return;
      }
      if (header.t === 'workspace-confined-serve-error') {
        this.failAll(new PluginError({
          code: header.code ?? 'workspace_root_unsafe',
          message: header.message ?? 'Workspace root could not be pinned safely',
          retryable: false,
        }));
        return;
      }
    }
    if (!header.id) return;
    const pending = this.pending.get(header.id);
    if (!pending) return;
    pending.onFrame(header, body);
  }

  private failAll(error: Error): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.detachHolderListeners();
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    if (!wasClosed) {
      this.onClosed(this);
    }
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
      entry.reject(error);
    }
  }
}

export class ConfinedWorkerClient {
  private active: LiveWorkerProcess | null = null;
  private unsupported = false;

  constructor(
    private readonly holder: SessionHolderChild,
    private readonly helperPath: string,
    private readonly guestRoot: string,
  ) {}

  get isUnsupported(): boolean {
    return this.unsupported;
  }

  close(): void {
    const worker = this.active;
    this.active = null;
    worker?.closeGracefully();
  }

  private async ensureWorker(): Promise<LiveWorkerProcess> {
    if (this.unsupported) throw new ConfinedWorkerUnsupportedError();
    if (this.holder.holderConnectionFailed) {
      throw ioFailed('Holder channel is disconnected');
    }
    let worker = this.active;
    if (!worker || worker.isClosed) {
      worker = new LiveWorkerProcess(
        this.holder,
        this.helperPath,
        this.guestRoot,
        () => { this.unsupported = true; },
        (closed) => {
          if (this.active === closed) this.active = null;
        },
      );
      this.active = worker;
    }
    await worker.ready;
    return worker;
  }

  async callSingle(
    request: Record<string, unknown>,
    body?: Uint8Array,
    options?: ConfinedWorkerRequestOptions,
  ): Promise<Readonly<{ header: ServeResponseHeader; body: Buffer }>> {
    if (options?.signal?.aborted) throw abortError(options.signal.reason);
    const worker = await this.ensureWorker();
    if (options?.signal?.aborted) throw abortError(options.signal.reason);
    const id = worker.allocateId();
    return await new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        worker.unregisterHandler(id);
        worker.sendCancel(id);
        reject(abortError(options?.signal?.reason));
      };
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        options?.signal?.removeEventListener('abort', onAbort);
      };
      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          worker.unregisterHandler(id);
          worker.sendCancel(id);
          reject(timeoutError(options.timeoutMs!));
        }, options.timeoutMs);
      }
      worker.registerHandler(id, {
        onFrame: (header, responseBody) => {
          worker.unregisterHandler(id);
          if (header.t === 'cancelled') {
            reject(abortError('Confined worker request cancelled'));
            return;
          }
          resolve({ header, body: responseBody });
        },
        reject,
        cleanup,
      });
      try {
        worker.writeFrame({ ...request, id }, body);
      } catch (error) {
        worker.unregisterHandler(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async meta(
    op: 'lstat' | 'stat' | 'list' | 'readlink' | 'realpath' | 'access-executable' | 'capture-leaf',
    relativePath: string,
    options?: ConfinedWorkerRequestOptions,
  ): Promise<ConfinedTargetResult> {
    const { header } = await this.callSingle({ op: op === 'list' ? 'readdir' : op, relativePath }, undefined, options);
    if (!header.result || typeof header.result !== 'object') {
      throw ioFailed('Confined worker returned no meta result');
    }
    return header.result as ConfinedTargetResult;
  }

  async statBatch(
    paths: readonly string[],
    options?: Readonly<{ followSymlinks?: boolean }> & ConfinedWorkerRequestOptions,
  ): Promise<readonly ConfinedTargetResult[]> {
    const { header } = await this.callSingle({
      op: 'statBatch',
      paths: [...paths],
      ...(options?.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks }),
    }, undefined, options);
    if (!Array.isArray(header.results)) throw ioFailed('Confined worker returned no statBatch results');
    return header.results;
  }

  async captureBatch(
    paths: readonly string[],
    options?: Readonly<{ maxTotalInlineBytes?: number }> & ConfinedWorkerRequestOptions,
  ): Promise<readonly ConfinedTargetResult[]> {
    const { header } = await this.callSingle({
      op: 'captureBatch',
      paths: [...paths],
      ...(options?.maxTotalInlineBytes === undefined ? {} : { maxTotalInlineBytes: options.maxTotalInlineBytes }),
    }, undefined, options);
    if (!Array.isArray(header.results)) throw ioFailed('Confined worker returned no captureBatch results');
    return header.results;
  }

  async readFile(
    relativePath: string,
    options?: Readonly<{ maxBytes?: number }> & ConfinedWorkerRequestOptions,
  ): Promise<Readonly<{ result: ConfinedTargetResult; body: Buffer }>> {
    const { header, body } = await this.callSingle({
      op: 'readFile',
      relativePath,
      ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    }, undefined, options);
    if (!header.result || typeof header.result !== 'object') {
      throw ioFailed('Confined worker returned no readFile result');
    }
    return { result: header.result as ConfinedTargetResult, body };
  }

  async write(
    request: Record<string, unknown>,
    content?: Uint8Array,
    options?: ConfinedWorkerRequestOptions,
  ): Promise<ConfinedTargetResult> {
    const { header } = await this.callSingle(request, content, options);
    if (!header.result || typeof header.result !== 'object') {
      throw ioFailed('Confined worker returned no write result');
    }
    return header.result as ConfinedTargetResult;
  }

  async openExclusive(
    relativePath: string,
    options?: ConfinedWorkerRequestOptions,
  ): Promise<Readonly<{
    result: ConfinedTargetResult;
    finish?: (input?: Readonly<{ relativePath?: string; mode?: number }>) => Promise<ConfinedTargetResult>;
  }>> {
    if (options?.signal?.aborted) throw abortError(options.signal.reason);
    const worker = await this.ensureWorker();
    const id = worker.allocateId();
    const opened = await new Promise<Readonly<{ frame: ServeResponseHeader }>>((resolve, reject) => {
      const cleanup = () => undefined;
      worker.registerHandler(id, {
        onFrame: (header) => {
          if (header.t === 'opened') {
            resolve({ frame: header });
            return;
          }
          worker.unregisterHandler(id);
          resolve({ frame: header });
        },
        reject,
        cleanup,
      });
      try {
        worker.writeFrame({ id, op: 'open-exclusive', relativePath });
      } catch (error) {
        worker.unregisterHandler(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const result = opened.frame.result as ConfinedTargetResult | undefined;
    if (!result || typeof result !== 'object') {
      worker.unregisterHandler(id);
      throw ioFailed('Confined worker returned no open-exclusive result');
    }
    if (opened.frame.t !== 'opened') {
      return { result };
    }

    let settled: Promise<ConfinedTargetResult> | undefined;
    const finish = (input?: Readonly<{ relativePath?: string; mode?: number }>) => settled ??= new Promise<ConfinedTargetResult>((resolve, reject) => {
      worker.registerHandler(id, {
        onFrame: (header) => {
          worker.unregisterHandler(id);
          if (header.t === 'cancelled') {
            reject(abortError('open-exclusive cancelled'));
            return;
          }
          if (!header.result || typeof header.result !== 'object') {
            reject(ioFailed('Confined worker returned no open-exclusive-finish result'));
            return;
          }
          resolve(header.result as ConfinedTargetResult);
        },
        reject,
        cleanup: () => undefined,
      });
      try {
        worker.writeFrame({
          id,
          op: 'open-exclusive-finish',
          ...(input?.relativePath ? { relativePath: input.relativePath } : {}),
          ...(input?.mode === undefined ? {} : { mode: input.mode }),
        });
      } catch (error) {
        worker.unregisterHandler(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return { result, finish };
  }

  async runConfinedSyncOp(input: Readonly<{
    op: 'read' | 'delete' | 'observe' | 'capture' | 'apply' | 'recover' | 'inspect';
    request: Record<string, unknown>;
    body?: Uint8Array;
    assertCurrentAuthority?: () => Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }>): Promise<ConfinedSyncResult> {
    if (input.signal?.aborted) throw abortError(input.signal.reason);
    const worker = await this.ensureWorker();
    if (input.signal?.aborted) throw abortError(input.signal.reason);
    const id = worker.allocateId();
    const requireAuthorityCommit = input.assertCurrentAuthority !== undefined;

    return await new Promise<ConfinedSyncResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let phase: 'preparing' | 'authority' | 'committing' | 'aborting' | 'done' = 'preparing';
      let authorityError: unknown;

      const onAbort = () => {
        if (phase === 'done') return;
        phase = 'done';
        worker.unregisterHandler(id);
        worker.sendCancel(id);
        reject(abortError(input.signal?.reason));
      };
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        input.signal?.removeEventListener('abort', onAbort);
      };
      if (input.signal) {
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (phase === 'done') return;
          phase = 'done';
          worker.unregisterHandler(id);
          worker.sendCancel(id);
          reject(timeoutError(input.timeoutMs!));
        }, input.timeoutMs);
      }

      worker.registerHandler(id, {
        onFrame: (header) => {
          if (phase === 'done') return;
          if (header.t === 'prepared' && phase === 'preparing' && requireAuthorityCommit) {
            phase = 'authority';
            void Promise.resolve()
              .then(() => input.assertCurrentAuthority!())
              .then(() => {
                if (phase !== 'authority') return;
                phase = 'committing';
                try {
                  worker.writeFrame({ id, op: 'commit' });
                } catch (error) {
                  phase = 'done';
                  worker.unregisterHandler(id);
                  reject(error instanceof Error ? error : new Error(String(error)));
                }
              }, (error: unknown) => {
                if (phase !== 'authority') return;
                phase = 'aborting';
                authorityError = error;
                try {
                  worker.writeFrame({ id, op: 'abort' });
                } catch {
                  phase = 'done';
                  worker.unregisterHandler(id);
                  reject(error instanceof Error ? error : new Error(String(error)));
                }
              });
            return;
          }
          if (phase === 'aborting' && (header.t === 'aborted' || header.t === 'cancelled')) {
            phase = 'done';
            worker.unregisterHandler(id);
            reject(authorityError instanceof Error ? authorityError : new Error(String(authorityError)));
            return;
          }
          if (header.t === 'cancelled') {
            phase = 'done';
            worker.unregisterHandler(id);
            reject(abortError('Confined sync operation cancelled'));
            return;
          }
          if (header.t === 'result' && header.result && typeof header.result === 'object') {
            phase = 'done';
            worker.unregisterHandler(id);
            resolve(header.result as ConfinedSyncResult);
            return;
          }
          phase = 'done';
          worker.unregisterHandler(id);
          reject(ioFailed(`Unexpected frame ${header.t} during confined sync ${input.op}`));
        },
        reject: (error) => {
          phase = 'done';
          reject(error);
        },
        cleanup,
      });

      try {
        worker.writeFrame({
          id,
          op: input.op,
          requireAuthorityCommit,
          request: input.request,
        }, input.body);
      } catch (error) {
        phase = 'done';
        worker.unregisterHandler(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async observe(relativePath: string, options?: ConfinedWorkerRequestOptions): Promise<WorkspaceSyncEntryExpectationV1> {
    const result = await this.runConfinedSyncOp({
      op: 'observe',
      request: { v: 1, rootPath: this.guestRoot, relativePath },
      ...options,
    });
    if (result.status === 'error') {
      throw Object.assign(new Error(result.message ?? 'Workspace observe failed'), {
        code: result.code ?? 'workspace_root_unsafe',
        ...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
      });
    }
    if (result.status !== 'observed') {
      throw Object.assign(new Error('native workspace confinement returned an invalid observation result'), {
        code: 'workspace_root_unsafe',
      });
    }
    const parsed = WorkspaceSyncEntryExpectationV1Schema.safeParse(result.expectation);
    if (!parsed.success) {
      throw Object.assign(new Error('native workspace confinement returned an invalid entry expectation'), {
        code: 'workspace_root_unsafe',
      });
    }
    return parsed.data;
  }

  async deleteEntry(input: Readonly<{
    relativePath: string;
    expectedKind: 'missing' | 'file' | 'directory' | 'symlink';
    expectedDigest?: string;
    assertCurrentAuthority?: () => Promise<void>;
  }> & ConfinedWorkerRequestOptions): Promise<void> {
    const result = await this.runConfinedSyncOp({
      op: 'delete',
      request: {
        v: 1,
        rootPath: this.guestRoot,
        relativePath: input.relativePath,
        expectedKind: input.expectedKind,
        ...(input.expectedDigest === undefined ? {} : { expectedDigest: input.expectedDigest }),
      },
      assertCurrentAuthority: input.assertCurrentAuthority,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    if (result.status === 'error') {
      throw Object.assign(new Error(result.message ?? 'Workspace delete failed'), {
        code: result.code ?? 'workspace_root_unsafe',
        ...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
      });
    }
    if (result.status !== 'deleted') {
      throw Object.assign(new Error('native workspace confinement returned an invalid deletion result'), {
        code: 'workspace_root_unsafe',
      });
    }
  }

  /**
   * Virtual child-process bridge for callers (e.g., `managedWorkspaceReturnTarget.ts`)
   * that invoke `source.spawn({ command: helperPath, args: ['workspace-confined-apply', ...] })`.
   * Multiplexes the full 1-RTT or 2-phase (`prepared` -> `commit`/`abort`) protocol
   * including streaming tar material over the single persistent worker, falling back
   * transparently to a one-shot helper spawn if the guest binary is older or targets
   * a different root.
   */
  spawnVirtualConfinedSyncCommand(
    args: readonly string[],
    fallbackSpawn: () => WorkspaceChildProcess,
  ): WorkspaceChildProcess | null {
    if (this.unsupported) return null;
    if (args.length < 1 || args.length > 2) return null;
    const op = CONFINED_SYNC_COMMAND_TO_OP.get(args[0]!);
    if (!op) return null;
    const autoCommit = args.length === 2 && args[1] === '--auto-commit';
    if (args.length === 2 && !autoCommit) return null;

    return new VirtualConfinedSyncProcess(
      this,
      this.guestRoot,
      op,
      !autoCommit,
      fallbackSpawn,
    ) as unknown as WorkspaceChildProcess;
  }

  /** @internal */
  acquireWorkerForBridge(): Promise<LiveWorkerProcess> {
    return this.ensureWorker();
  }
}

class VirtualConfinedSyncProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new Readable({ read() {} });
  readonly stderr = new Readable({ read() {} });

  private phase: 'request' | 'starting' | 'staging' | 'decision' | 'fallback' | 'closed' = 'request';
  private lineBuffer: Buffer = EMPTY_BUFFER;
  private queuedChunks: Buffer[] = [];
  private stdinEnded = false;
  private decisionSent = false;
  private abortSent = false;
  private worker: LiveWorkerProcess | null = null;
  private requestId: string | null = null;
  private fallback: WorkspaceChildProcess | null = null;
  private rawFirstLine: Buffer = EMPTY_BUFFER;
  private stageStreaming = false;
  private decisionBuffer = '';

  constructor(
    private readonly client: ConfinedWorkerClient,
    private readonly guestRoot: string,
    private readonly op: string,
    private readonly requireAuthorityCommit: boolean,
    private readonly fallbackSpawn: () => WorkspaceChildProcess,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const needsDrain = this.handleStdinChunk(Buffer.from(chunk));
        if (!needsDrain || this.phase === 'closed') {
          callback();
          return;
        }
        if (this.phase === 'fallback' && this.fallback) {
          waitForWritableDrain(this.fallback.stdin, this.fallback as unknown as EventEmitter, () => callback());
          return;
        }
        if (this.worker) {
          this.worker.waitForStdinDrain(() => callback());
          return;
        }
        callback();
      },
      final: (callback) => {
        this.handleStdinEnd();
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.phase === 'closed') return false;
    if (this.fallback) return this.fallback.kill(signal);
    if (this.worker && this.requestId) {
      this.worker.unregisterHandler(this.requestId);
      this.worker.sendCancel(this.requestId);
    }
    this.finishClose(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  }

  async terminateTree(): Promise<void> {
    if (this.fallback) {
      await this.fallback.terminateTree();
      return;
    }
    this.kill('SIGTERM');
  }

  private sendAbortOnEof(): void {
    if (this.abortSent || this.decisionSent || this.phase === 'closed') return;
    if (!this.worker || !this.requestId) return;
    this.abortSent = true;
    try {
      this.worker.writeFrame({ id: this.requestId, op: 'abort' });
    } catch {
      this.worker.unregisterHandler(this.requestId);
      this.finishClose(1, null);
    }
  }

  private handleStdinChunk(chunk: Buffer): boolean {
    if (this.phase === 'closed') return false;
    if (this.phase === 'fallback') {
      return this.fallback ? !this.fallback.stdin.write(chunk) : false;
    }
    if (this.phase === 'request') {
      const nextSize = this.lineBuffer.byteLength + chunk.byteLength;
      const chunkNewline = chunk.indexOf(0x0a);
      if (chunkNewline < 0) {
        if (nextSize > VIRTUAL_SYNC_MAX_REQUEST_LINE_BYTES) {
          this.lineBuffer = EMPTY_BUFFER;
          this.stderr.push(`Confined sync request header exceeds limit (${VIRTUAL_SYNC_MAX_REQUEST_LINE_BYTES} bytes)\n`);
          this.finishClose(1, null);
          return false;
        }
        this.lineBuffer = this.lineBuffer.byteLength === 0 ? chunk : Buffer.concat([this.lineBuffer, chunk]);
        return false;
      }
      const lineLen = this.lineBuffer.byteLength + chunkNewline;
      if (lineLen > VIRTUAL_SYNC_MAX_REQUEST_LINE_BYTES) {
        this.lineBuffer = EMPTY_BUFFER;
        this.stderr.push(`Confined sync request header exceeds limit (${VIRTUAL_SYNC_MAX_REQUEST_LINE_BYTES} bytes)\n`);
        this.finishClose(1, null);
        return false;
      }
      const combined = this.lineBuffer.byteLength === 0 ? chunk : Buffer.concat([this.lineBuffer, chunk]);
      this.rawFirstLine = combined.subarray(0, lineLen + 1);
      const rest = combined.subarray(lineLen + 1);
      this.lineBuffer = EMPTY_BUFFER;
      if (rest.byteLength > 0) this.queuedChunks.push(rest);
      this.beginDispatch(this.rawFirstLine.toString('utf8').trim());
      return false;
    }
    if (this.phase === 'starting') {
      this.queuedChunks.push(chunk);
      return false;
    }
    if (this.phase === 'staging') {
      if (this.stageStreaming && this.worker && this.requestId && chunk.byteLength > 0) {
        try {
          return !this.worker.writeFrame({ id: this.requestId, op: 'apply-chunk' }, chunk);
        } catch (error) {
          this.worker.unregisterHandler(this.requestId);
          this.stderr.push(`${error instanceof Error ? error.message : String(error)}\n`);
          this.finishClose(1, null);
        }
      }
      return false;
    }
    if (this.phase === 'decision') {
      return this.consumeDecisionText(chunk.toString('utf8'));
    }
    return false;
  }

  private handleStdinEnd(): void {
    this.stdinEnded = true;
    if (this.phase === 'closed') return;
    if (this.phase === 'fallback') {
      this.fallback?.stdin.end();
      return;
    }
    if (this.phase === 'request') {
      this.lineBuffer = EMPTY_BUFFER;
      this.stderr.push('Confined sync stdin ended before complete request header\n');
      this.finishClose(1, null);
      return;
    }
    if (this.phase === 'staging') {
      if (this.stageStreaming && this.worker && this.requestId) {
        try {
          this.worker.writeFrame({ id: this.requestId, op: 'apply-eof' });
        } catch {
          this.worker.unregisterHandler(this.requestId);
          this.finishClose(1, null);
        }
      }
      return;
    }
    if (this.phase === 'decision' && this.requireAuthorityCommit && !this.decisionSent) {
      this.sendAbortOnEof();
    }
  }

  private beginDispatch(firstLine: string): void {
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(firstLine);
    } catch {
      this.switchToFallback();
      return;
    }
    if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
      this.stderr.push('Confined sync request header must be a JSON object\n');
      this.finishClose(1, null);
      return;
    }
    const parsed = parsedRaw as Record<string, unknown>;
    if (
      typeof parsed.rootPath === 'string'
      && path.posix.resolve(parsed.rootPath) !== this.guestRoot
    ) {
      this.switchToFallback();
      return;
    }
    this.phase = 'starting';
    this.stageStreaming = this.op === 'apply' && parsed.stageOnTarget === true && parsed.materialPath !== null && parsed.materialPath !== undefined;

    void this.client.acquireWorkerForBridge().then(
      (worker) => {
        if (this.phase === 'closed') return;
        this.worker = worker;
        const id = worker.allocateId();
        this.requestId = id;
        this.phase = this.stageStreaming ? 'staging' : 'decision';

        worker.registerHandler(id, {
          onFrame: (header) => {
            if (this.phase === 'closed') return;
            if (header.t === 'prepared') {
              this.phase = 'decision';
              this.stdout.push(`${JSON.stringify({ v: 1, t: 'workspace-confined-prepared' })}\n`);
              if (this.decisionBuffer.length > 0) {
                this.consumeDecisionText('');
              }
              if (this.stdinEnded && this.requireAuthorityCommit && !this.decisionSent) {
                this.sendAbortOnEof();
              }
              return;
            }
            if (header.t === 'aborted' || header.t === 'cancelled') {
              worker.unregisterHandler(id);
              this.finishClose(this.decisionSent ? 0 : 1, null);
              return;
            }
            if (header.t === 'result') {
              worker.unregisterHandler(id);
              this.stdout.push(`${JSON.stringify(header.result)}\n`);
              this.finishClose(0, null);
              return;
            }
            worker.unregisterHandler(id);
            this.stderr.push(`Unexpected worker frame: ${header.t}\n`);
            this.finishClose(1, null);
          },
          reject: (error) => {
            this.stderr.push(`${error.message}\n`);
            this.finishClose(1, null);
          },
          cleanup: () => undefined,
        });

        try {
          worker.writeFrame({
            id,
            op: this.op,
            requireAuthorityCommit: this.requireAuthorityCommit,
            ...(this.stageStreaming ? { streamMaterial: true } : {}),
            request: parsed,
          });
          const pending = this.queuedChunks.splice(0);
          if (this.stageStreaming) {
            for (const chunk of pending) {
              if (chunk.byteLength > 0) worker.writeFrame({ id, op: 'apply-chunk' }, chunk);
            }
            if (this.stdinEnded) {
              worker.writeFrame({ id, op: 'apply-eof' });
            }
          } else {
            for (const chunk of pending) {
              this.consumeDecisionText(chunk.toString('utf8'));
            }
            if (this.stdinEnded && this.requireAuthorityCommit && !this.decisionSent) {
              this.sendAbortOnEof();
            }
          }
        } catch (error) {
          worker.unregisterHandler(id);
          this.stderr.push(`${error instanceof Error ? error.message : String(error)}\n`);
          this.finishClose(1, null);
        }
      },
      (error: unknown) => {
        if (this.phase === 'closed') return;
        if (error instanceof ConfinedWorkerUnsupportedError) {
          this.switchToFallback();
          return;
        }
        this.stderr.push(`${error instanceof Error ? error.message : String(error)}\n`);
        this.finishClose(1, null);
      },
    );
  }

  private consumeDecisionText(text: string): boolean {
    this.decisionBuffer += text;
    const newline = this.decisionBuffer.indexOf('\n');
    if (newline < 0) return false;
    const line = this.decisionBuffer.slice(0, newline).trim();
    this.decisionBuffer = this.decisionBuffer.slice(newline + 1);
    if (!line || !this.worker || !this.requestId || this.decisionSent) return false;
    let op: 'commit' | 'abort' = 'abort';
    try {
      const parsed = JSON.parse(line) as { decision?: unknown };
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.decision === 'commit' || parsed.decision === 'abort')) {
        op = parsed.decision;
      }
    } catch {
      // Invalid decision falls through to abort.
    }
    this.decisionSent = true;
    try {
      return !this.worker.writeFrame({ id: this.requestId, op });
    } catch (error) {
      this.worker.unregisterHandler(this.requestId);
      this.stderr.push(`${error instanceof Error ? error.message : String(error)}\n`);
      this.finishClose(1, null);
      return false;
    }
  }

  private switchToFallback(): void {
    this.phase = 'fallback';
    const child = this.fallbackSpawn();
    this.fallback = child;
    child.stdout.on('data', (chunk: Buffer) => this.stdout.push(chunk));
    child.stdout.once('end', () => this.stdout.push(null));
    child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    child.stderr.once('end', () => this.stderr.push(null));
    child.once('error', (error: Error) => this.emit('error', error));
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => this.emit('exit', code, signal));
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.phase = 'closed';
      this.emit('close', code, signal);
    });
    if (this.rawFirstLine.byteLength > 0) child.stdin.write(this.rawFirstLine);
    for (const chunk of this.queuedChunks.splice(0)) child.stdin.write(chunk);
    if (this.stdinEnded) child.stdin.end();
  }

  private finishClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

const workersByHolder = new WeakMap<SessionHolderChild, Map<string, ConfinedWorkerClient>>();

export function getHolderConfinedWorkerClient(
  holder: SessionHolderChild,
  helperPath: string,
  guestRoot: string,
): ConfinedWorkerClient {
  let byKey = workersByHolder.get(holder);
  if (!byKey) {
    byKey = new Map();
    workersByHolder.set(holder, byKey);
  }
  const key = `${helperPath}\0${guestRoot}`;
  let client = byKey.get(key);
  if (!client) {
    client = new ConfinedWorkerClient(holder, helperPath, guestRoot);
    byKey.set(key, client);
  }
  return client;
}

export function closeHolderConfinedWorkers(holder: SessionHolderChild): void {
  const byKey = workersByHolder.get(holder);
  if (!byKey) return;
  for (const client of byKey.values()) {
    client.close();
  }
  byKey.clear();
}
