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
});
