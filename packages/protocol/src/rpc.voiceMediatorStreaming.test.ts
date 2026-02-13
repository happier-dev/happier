import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS } from './rpc.js';

describe('SESSION_RPC_METHODS voice mediator streaming methods', () => {
  it('defines voice mediator turn streaming method constants', () => {
    expect(SESSION_RPC_METHODS.VOICE_MEDIATOR_SEND_TURN_STREAM_START).toBe('voice.mediator.sendTurnStream.start');
    expect(SESSION_RPC_METHODS.VOICE_MEDIATOR_SEND_TURN_STREAM_READ).toBe('voice.mediator.sendTurnStream.read');
    expect(SESSION_RPC_METHODS.VOICE_MEDIATOR_SEND_TURN_STREAM_CANCEL).toBe('voice.mediator.sendTurnStream.cancel');
  });
});
