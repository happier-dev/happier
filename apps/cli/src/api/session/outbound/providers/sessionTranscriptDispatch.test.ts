import { describe, expect, it, vi } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import {
  prepareAcpTranscriptDispatch,
  prepareCodexTranscriptDispatch,
} from '@/api/session/outbound/providers/sessionTranscriptDispatch';

describe('sessionTranscriptDispatch', () => {
  it('prepares ACP transcript dispatch payloads through the provider seam', () => {
    const prepared = prepareAcpTranscriptDispatch({
      provider: 'codex',
      body: { type: 'message', message: 'hello', sidechainId: 'side-1' } as any,
      localId: 'local-1',
      toolCallCanonicalNameByProviderAndId: new Map(),
      permissionToolCallRawInputByProviderAndId: new Map(),
      toolCallInputByProviderAndId: new Map(),
    });

    expect(prepared.normalizedBody).toEqual({
      type: 'message',
      message: 'hello',
      sidechainId: 'side-1',
    });
    expect(prepared.localId).toBe('local-1');
    expect(prepared.sidechainId).toBe('side-1');
    expect(prepared.content).toEqual({
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'codex',
        data: {
          type: 'message',
          message: 'hello',
          sidechainId: 'side-1',
        },
      },
      meta: {
        sentFrom: 'cli',
        source: 'cli',
      },
    });
  });

  it('prepares codex transcript dispatch payloads through the provider seam', () => {
    const prepared = prepareCodexTranscriptDispatch({
      body: {
        type: 'token_count',
        id: 'codex-token-1',
        tokens: { total: 9, input: 4, output: 5 },
        source: 'codex-app-server-token-usage',
        scope: 'session_cumulative',
      },
      metadata: createTestMetadata({ codexBackendMode: 'appServer' }),
      toolCallCanonicalNameByProviderAndId: new Map(),
      debug: vi.fn(),
    });

    expect(prepared.normalizedBody).toEqual(
      expect.objectContaining({
        type: 'token_count',
        id: 'codex-token-1',
      }),
    );
    expect(prepared.content).toEqual({
      role: 'agent',
      content: {
        type: 'codex',
        data: expect.objectContaining({
          type: 'token_count',
          id: 'codex-token-1',
        }),
      },
      meta: {
        sentFrom: 'cli',
        source: 'cli',
      },
    });
    expect(prepared.backendMode).toBe('appServer');
    expect(prepared.externalKey).toBe('codex-token-1');
  });
});
