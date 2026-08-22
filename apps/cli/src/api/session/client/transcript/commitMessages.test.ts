import { describe, expect, it, vi } from 'vitest';

import type { SessionClientTranscriptSendPort } from './sendMessages';
import {
  prepareCommittedAgentMessageViaPort,
  prepareCommittedUserTextMessageViaPort,
} from './commitMessages';

function createTranscriptSendPort(): SessionClientTranscriptSendPort {
  return {
    sessionId: 'session-1',
    socket: {
      connected: true,
      emit: vi.fn(),
    },
    outboundShapeLogger: {
      log: vi.fn(),
    },
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    getMetadataSnapshot: () => null,
    buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
    toolCallCanonicalNameByProviderAndId: new Map(),
    permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
  };
}

describe('commitMessages', () => {
  it('prepares committed ACP transcript payloads through the transcript port seam', async () => {
    const port = createTranscriptSendPort();

    const prepared = await prepareCommittedAgentMessageViaPort(
      port,
      'codex',
      { type: 'message', message: 'hello', sidechainId: 'side-1' } as any,
      { localId: 'local-1' },
    );

    expect(prepared.normalizedBody).toEqual({
      type: 'message',
      message: 'hello',
      sidechainId: 'side-1',
    });
    expect(prepared.localId).toBe('local-1');
    expect(prepared.sidechainId).toBe('side-1');
    expect(prepared.payload).toEqual({
      t: 'plain',
      v: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'codex',
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
      },
    });
  });

  it('does not invoke a legacy whole-content materializer before the plain payload boundary', async () => {
    const port = createTranscriptSendPort();
    const structuredPresentation = {
      v: 1,
      profile: 'pluginTranscriptV1',
      owner: {
        pluginId: 'acme.preview',
        contributionLocalId: 'preview-card',
      },
      snapshot: {
        kind: 'status',
        label: 'Preview',
        value: 'Ready',
      },
    } as const;
    const materializeStructuredPresentation = vi.fn(async () => structuredPresentation);
    const portWithLegacyMaterializer = port as SessionClientTranscriptSendPort & {
      materializeCommittedAgentMessageContent?: (params: Readonly<{
        sessionId: string;
        content: unknown;
      }>) => Promise<unknown>;
    };
    portWithLegacyMaterializer.materializeCommittedAgentMessageContent = materializeStructuredPresentation;

    const prepared = await prepareCommittedAgentMessageViaPort(
      port,
      'codex',
      { type: 'message', message: 'preview ready' } as any,
      { localId: 'structured-1' },
    );

    expect(materializeStructuredPresentation).not.toHaveBeenCalled();
    expect(prepared.payload).toEqual({
      t: 'plain',
      v: {
        role: 'agent',
        content: {
          type: 'acp',
          agentId: 'codex',
          data: { type: 'message', message: 'preview ready' },
        },
        meta: {
          sentFrom: 'cli',
          source: 'cli',
        },
      },
    });
  });

  it('hands ordinary ACP content to the E2EE payload boundary despite a legacy materializer property', async () => {
    const structuredPresentation = {
      v: 1,
      profile: 'pluginTranscriptV1',
      owner: {
        pluginId: 'acme.preview',
        contributionLocalId: 'preview-card',
      },
      snapshot: { kind: 'status', label: 'Preview', value: 'Ready' },
    } as const;
    const materializeStructuredPresentation = vi.fn(async () => structuredPresentation);
    const port = {
      ...createTranscriptSendPort(),
      materializeCommittedAgentMessageContent: materializeStructuredPresentation,
      buildOutboundSessionMessagePayload: (content: unknown) => `ciphertext:${JSON.stringify(content)}`,
    } as SessionClientTranscriptSendPort & Readonly<{
      materializeCommittedAgentMessageContent: typeof materializeStructuredPresentation;
    }>;

    const prepared = await prepareCommittedAgentMessageViaPort(
      port,
      'codex',
      { type: 'message', message: 'preview ready' } as any,
      { localId: 'structured-e2ee-1' },
    );

    expect(materializeStructuredPresentation).not.toHaveBeenCalled();
    expect(prepared.payload).toBe(`ciphertext:${JSON.stringify({
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'codex',
        data: { type: 'message', message: 'preview ready' },
      },
      meta: {
        sentFrom: 'cli',
        source: 'cli',
      },
    })}`);
  });

  it('prepares committed user text payloads through the transcript port seam', () => {
    const port = createTranscriptSendPort();

    const prepared = prepareCommittedUserTextMessageViaPort(
      port,
      'ship it',
      { localId: 'user-1', meta: { source: 'ui' } },
    );

    expect(prepared.localId).toBe('user-1');
    expect(prepared.payload).toEqual({
      t: 'plain',
      v: {
        role: 'user',
        content: {
          type: 'text',
          text: 'ship it',
        },
        meta: {
          sentFrom: 'cli',
          source: 'ui',
        },
      },
    });
  });
});
