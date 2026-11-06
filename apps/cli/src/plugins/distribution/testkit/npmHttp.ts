import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';

export function npmHttpResponse(body: unknown, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  // Genuine HTTP boundary: only the IncomingMessage fields used by the client are projected.
  return Object.assign(Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]), {
    statusCode: 200, headers: { 'content-type': 'application/json' }, ...overrides,
  }) as unknown as IncomingMessage;
}

export function npmHttpRequestBoundary(params: Readonly<{
  responses: (IncomingMessage | Error | ((respond: (message: IncomingMessage) => void) => void))[];
  seen: RequestOptions[];
  bodies?: (string | undefined)[];
  destroyed?: Error[];
}>): typeof import('node:https').request {
  const request = ((options: RequestOptions, callback: (message: IncomingMessage) => void) => {
    params.seen.push(options);
    const emitter = new EventEmitter() as EventEmitter & { end(body?: string): void; destroy(error?: Error): void; setTimeout(): void };
    emitter.setTimeout = () => undefined;
    emitter.destroy = (error) => { if (error) { params.destroyed?.push(error); emitter.emit('error', error); } };
    emitter.end = (body) => {
      params.bodies?.push(body);
      queueMicrotask(() => {
        const next = params.responses.shift();
        if (next instanceof Error) emitter.emit('error', next);
        else if (typeof next === 'function') next(callback);
        else if (next) callback(next);
        else emitter.emit('error', new Error('Unexpected extra npm HTTP request'));
      });
    };
    // System-boundary fixture: retain real internal owners beneath the native request adapter.
    return emitter as unknown as ClientRequest;
  }) as typeof import('node:https').request;
  return request;
}
