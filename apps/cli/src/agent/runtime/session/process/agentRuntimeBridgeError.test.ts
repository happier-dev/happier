import { describe, expect, it } from 'vitest';

import { normalizeAgentRuntimeBridgeError } from './agentRuntimeBridgeError';

describe('normalizeAgentRuntimeBridgeError', () => {
  it('bounds provider-controlled codes and messages before strict bridge settlement', () => {
    const error = new Error('m'.repeat(8_192)) as Error & { code: string };
    error.code = `  ${'c'.repeat(512)}  `;

    const normalized = normalizeAgentRuntimeBridgeError(error);

    expect(normalized.code).toHaveLength(256);
    expect(normalized.message).toHaveLength(4_096);
  });

  it('reads only own string data codes without invoking accessors or Proxy get traps', () => {
    let accessorReads = 0;
    const accessorError = new Error('accessor failure');
    Object.defineProperty(accessorError, 'code', {
      get() {
        accessorReads += 1;
        throw new Error('error code accessor must not execute');
      },
    });
    expect(normalizeAgentRuntimeBridgeError(
      accessorError,
      'safe_fallback',
    )).toEqual({
      code: 'safe_fallback',
      message: 'accessor failure',
    });

    const proxyTarget = Object.assign(
      new Error('proxy failure'),
      { code: 'typed_proxy_failure' },
    );
    const proxyError = new Proxy(proxyTarget, {
      get(target, property, receiver) {
        if (property === 'code') {
          accessorReads += 1;
          throw new Error('error code Proxy trap must not execute');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(normalizeAgentRuntimeBridgeError(proxyError)).toEqual({
      code: 'typed_proxy_failure',
      message: 'proxy failure',
    });
    expect(accessorReads).toBe(0);
  });
});
