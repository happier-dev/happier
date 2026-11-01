import { EventEmitter } from 'node:events';
import type { CDPSession } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { collectNetworkTransfer } from './networkTransfer';

class NetworkSource extends EventEmitter {
  async send() {}
  async detach() {}
}

async function fixture() {
  const source = new NetworkSource();
  // CDP is an external browser boundary; replay its network events without a browser.
  const capture = await collectNetworkTransfer(source as unknown as CDPSession, 'http://api.test');
  return { source, capture };
}

describe('network transfer capture', () => {
  it('keeps between-phase fixture traffic out of the completed phase while retaining its late responses', async () => {
    const { source, capture } = await fixture();
    capture.beginPhase('burst');
    source.emit('Network.requestWillBeSent', { requestId: 'late', request: { url: 'http://api.test/v2/sessions', method: 'GET' } });
    capture.endPhase();
    source.emit('Network.loadingFinished', { requestId: 'late', encodedDataLength: 20 });
    source.emit('Network.requestWillBeSent', { requestId: 'setup', request: { url: 'http://api.test/v2/sessions', method: 'GET' } });
    source.emit('Network.webSocketFrameReceived', { requestId: 'socket', response: { opcode: 1, payloadData: '42["update",{"body":{"t":"new-message"}}]' } });
    const phase = capture.snapshot().phases[0];
    expect(phase.http[0]).toMatchObject({ requests: 1, lateResponses: 1 });
    expect(phase.webSocket).toEqual([]);
    await capture.stop();
  });

  it('excludes non-network data URLs without calling their body events lost HTTP evidence', async () => {
    const { source, capture } = await fixture();
    capture.beginPhase('home');
    source.emit('Network.requestWillBeSent', { requestId: 'inline', request: { url: 'data:image/svg+xml,private-image', method: 'GET' } });
    source.emit('Network.responseReceived', { requestId: 'inline', response: { status: 200, headers: {} } });
    source.emit('Network.dataReceived', { requestId: 'inline', dataLength: 20, encodedDataLength: 0 });
    source.emit('Network.loadingFinished', { requestId: 'inline', encodedDataLength: 0 });
    expect(capture.snapshot()).toMatchObject({ status: 'complete', lostEvents: 0, phases: [{ http: [] }] });
    await capture.stop();
  });

  it('keeps decoded, encoded body and header-inclusive response evidence distinct and sanitizes routes', async () => {
    const { source, capture } = await fixture();
    capture.beginPhase('cold');
    source.emit('Network.requestWillBeSent', { requestId: 'secret-id', type: 'Fetch', request: {
      url: 'http://api.test/v2/sessions?requiredSessionIds=private-session&token=secret-token', method: 'GET',
    } });
    source.emit('Network.responseReceived', { requestId: 'secret-id', response: {
      status: 200, headers: { 'content-encoding': 'gzip', authorization: 'secret-token' },
    } });
    source.emit('Network.dataReceived', { requestId: 'secret-id', dataLength: 4000, encodedDataLength: 400 });
    source.emit('Network.loadingFinished', { requestId: 'secret-id', encodedDataLength: 650 });
    const result = capture.snapshot();
    expect(result.phases[0].http[0]).toMatchObject({
      method: 'GET', route: 'session-list-targeted', requests: 1,
      decodedBodyBytes: 4000, encodedBodyBytes: 400, encodedResponseBytes: 650,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-session|secret-token|secret-id/);
    expect(result.status).toBe('complete');
    await capture.stop();
  });

  it('does not treat a cached decoded body as zero encoded body transfer evidence', async () => {
    const { source, capture } = await fixture();
    capture.beginPhase('warm');
    source.emit('Network.requestWillBeSent', { requestId: 'r', request: { url: 'http://api.test/v2/sessions', method: 'GET' } });
    source.emit('Network.responseReceived', { requestId: 'r', response: { status: 200, headers: {}, fromDiskCache: true } });
    source.emit('Network.dataReceived', { requestId: 'r', dataLength: 100, encodedDataLength: 0 });
    source.emit('Network.loadingFinished', { requestId: 'r', encodedDataLength: 0 });
    expect(capture.snapshot().phases[0].http[0]).toMatchObject({
      decodedBodyBytes: 100, encodedBodyBytes: 'unavailable', encodedResponseBytes: 0, cached: 1,
    });
    await capture.stop();
  });

  it('counts an OPTIONS response body and recognizes a protocol-bodyless HEAD response', async () => {
    const { source, capture } = await fixture();
    capture.beginPhase('home');
    for (const method of ['OPTIONS', 'HEAD']) {
      source.emit('Network.requestWillBeSent', { requestId: method, request: { url: 'http://api.test/v2/sessions', method } });
      source.emit('Network.responseReceived', { requestId: method, response: { status: 200, headers: {} } });
      if (method === 'OPTIONS') source.emit('Network.dataReceived', { requestId: method, dataLength: 12, encodedDataLength: 12 });
      source.emit('Network.loadingFinished', { requestId: method, encodedDataLength: 100 });
    }
    expect(capture.snapshot().phases[0].http.find((row) => row.method === 'OPTIONS')).toMatchObject({ decodedBodyBytes: 12, encodedBodyBytes: 12 });
    expect(capture.snapshot().phases[0].http.find((row) => row.method === 'HEAD')).toMatchObject({ decodedBodyBytes: 0, encodedBodyBytes: 0 });
    await capture.stop();
  });

  it('reports missing body evidence, failures and cross-phase responses rather than a zero baseline', async () => {
    const { source, capture } = await fixture();
    capture.beginPhase('cold');
    source.emit('Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', request: {
      url: 'http://api.test/v2/sessions/private', method: 'GET',
    } });
    capture.beginPhase('warm');
    source.emit('Network.loadingFailed', { requestId: 'r' });
    const result = capture.snapshot();
    expect(result.phases[0]).toMatchObject({ inFlightAtEnd: 1 });
    expect(result.phases[0].http[0]).toMatchObject({
      decodedBodyBytes: 'unavailable', encodedBodyBytes: 'unavailable', encodedResponseBytes: 'unavailable',
      failed: 1, lateResponses: 1,
    });
    expect(result.status).toBe('incomplete');
    await capture.stop();
  });

  it('counts namespaced events, acknowledgements, binary attachments, heartbeat and unknown frames without exporting contents', async () => {
    const { source, capture } = await fixture();
    capture.beginPhase('burst');
    source.emit('Network.webSocketCreated', { requestId: 'socket', url: 'ws://api.test/v1/updates?token=private' });
    const frame = (payloadData: string, opcode = 1) => source.emit('Network.webSocketFrameReceived', {
      requestId: 'socket', response: { opcode, payloadData },
    });
    const textEvent = '42/private[namespace],17["update",{"body":{"t":"new-message","text":"private-content"}}]';
    const binaryEvent = '451-/private[namespace],18["update",{"body":{"t":"new-message"},"data":{"_placeholder":true,"num":0}}]';
    frame(textEvent);
    frame(binaryEvent);
    expect(capture.snapshot().phases[0].webSocket.find((row) => row.family === 'unknown')).toMatchObject({
      frames: 1, messages: 0, applicationBytes: Buffer.byteLength(binaryEvent),
    });
    frame(Buffer.from([1, 2, 3, 4]).toString('base64'), 2);
    frame('43/private,17[{"private":"ack"}]');
    frame(Buffer.from([1, 2, 3]).toString('base64'), 9);
    frame('2'); frame('3'); frame('42["private-new-event",{"body":{"t":"private-new-type"}}]');
    const result = capture.snapshot();
    const ws = result.phases[0].webSocket;
    expect(ws.find((row) => row.family === 'update' && row.type === 'new-message')).toMatchObject({
      frames: 3, messages: 2, applicationBytes: Buffer.byteLength(textEvent + binaryEvent) + 4,
    });
    expect(ws.find((row) => row.family === 'engine' && row.type === 'ping')).toMatchObject({ frames: 1, applicationBytes: 1 });
    expect(ws.find((row) => row.family === 'engine' && row.type === 'pong')).toMatchObject({ frames: 1 });
    expect(ws.find((row) => row.family === 'websocket' && row.type === 'ping')).toMatchObject({ frames: 1, applicationBytes: 3 });
    expect(ws.find((row) => row.family === 'socket' && row.type === 'ack')).toMatchObject({ frames: 1 });
    expect(ws.find((row) => row.family === 'unknown')).toMatchObject({ frames: 1 });
    expect(result.wsEncodedBytes).toBe('unavailable');
    expect(JSON.stringify(result)).not.toMatch(/private/);
    await capture.stop();
  });
});
