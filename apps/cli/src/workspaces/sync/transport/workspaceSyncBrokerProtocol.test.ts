import { describe, expect, it } from 'vitest';
import {
  BrokerControlFrameDecoder,
  BrokerRequestStateMachine,
  createBrokerHelloProof,
  encodeBrokerControlFrame,
  parseBrokerControlV1,
} from './workspaceSyncBrokerProtocol';

describe('workspace sync broker protocol', () => {
  it('frames control JSON with a big-endian length and decodes fragmented input', () => {
    const frame = encodeBrokerControlFrame({ t: 'open_data', requestId: 'r1', endpointId: 'ws1_ep', expiresAtMs: 100 });
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    const decoder = new BrokerControlFrameDecoder();
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2))).toEqual([{ t: 'open_data', requestId: 'r1', endpointId: 'ws1_ep', expiresAtMs: 100 }]);
  });

  it('rejects unknown fields and oversized frames', () => {
    expect(() => parseBrokerControlV1({ t: 'open_data', requestId: 'r', endpointId: 'e', expiresAtMs: 1, extra: true })).toThrow(/unknown broker control field/);
    const decoder = new BrokerControlFrameDecoder();
    const bad = Buffer.alloc(4); bad.writeUInt32BE(65 * 1024);
    expect(() => decoder.push(bad)).toThrow(/invalid broker frame length/);
    expect(() => parseBrokerControlV1({ t: 'command', requestId: 'outer', command: { t: 'list', requestId: 'inner', nope: true } })).toThrow(/unknown mutagen command field/);
  });

  it('uses a stable length-delimited hello proof', () => {
    const hello = { protocol: 1 as const, brokerInstanceId: 'b', launchNonce: 'n', sidecarPid: 42 };
    expect(createBrokerHelloProof(Buffer.alloc(32, 1), hello)).toBe(createBrokerHelloProof(Buffer.alloc(32, 1), hello));
    expect(createBrokerHelloProof(Buffer.alloc(32, 1), hello)).not.toBe(createBrokerHelloProof(Buffer.alloc(32, 2), hello));
  });

  it('enforces the explicit request state machine', () => {
    const state = new BrokerRequestStateMachine();
    state.transition('CONTROL_AUTHENTICATING'); state.transition('CONTROL_READY'); state.transition('OPEN_VALIDATING');
    expect(() => state.transition('STREAMING')).toThrow(/invalid broker state transition/);
    state.fail(); expect(state.state).toBe('CLOSED');
  });
});
