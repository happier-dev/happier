import { describe, expect, it, vi } from 'vitest';

import type { SessionClientTranscriptSendPort } from './sendMessages';
import { resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
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
  it('binds an acknowledged surface identity to its completed encrypted tool result before sealing', async () => {
    const port = { ...createTranscriptSendPort(), serverId: 'home-a',
      buildOutboundSessionMessagePayload: () => 'sealed-message' };
    const itemRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const call = {
      type: 'tool-call', callId: 'visual-call', id: 'call', name: 'session_board_item_upsert',
      input: { itemId: 'visual', expectedItemRevision: null, destination: 'transcript',
        item: { v: 1, title: 'Result', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
          source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Result' } } } } },
    } as const;
    await prepareCommittedAgentMessageViaPort(port, 'codex', call, { localId: 'call' });
    const body = { type: 'tool-result' as const, callId: 'visual-call', id: 'result', output: {
      v: 1, serverId: 'home-a', sessionId: 'session-1', itemDestination: 'transcript', destination: null,
      result: { operation: 'upsert_item', itemId: 'visual', itemRevision, outcome: 'created' },
    } };
    const acknowledgedInput = port.toolCallInputByProviderAndId.get('codex:visual-call');
    const prepared = await prepareCommittedAgentMessageViaPort(port, 'codex', body, { localId: 'result' });
    expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: 'session_board_item_upsert', state: 'completed',
      input: acknowledgedInput, result: prepared.normalizedBody.type === 'tool-result' ? prepared.normalizedBody.output : null,
      address: { serverId: 'home-a', sessionId: 'session-1' } }))
      .toMatchObject({ itemId: 'visual' });
    expect(prepared.payload).toBe('sealed-message');
    expect(prepared).toHaveProperty('surfaceItemReference', { v: 1, itemId: 'visual', itemRevision,
      sourceAddress: { serverId: 'home-a', sessionId: 'session-1' } });
    await prepareCommittedAgentMessageViaPort(port, 'codex', call, { localId: 'foreign-call' });
    const foreign = await prepareCommittedAgentMessageViaPort(port, 'codex', {
      ...body, output: { ...body.output, serverId: 'other-home' },
    }, { localId: 'foreign' });
    expect(foreign).not.toHaveProperty('surfaceItemReference');
  });

  it('recognizes only the typed first-party shell bridge acknowledgement through the real normalizer', async () => {
    const itemRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const args = { itemId: 'visual', expectedItemRevision: null, destination: 'transcript',
      item: { v: 1, title: 'Result', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Result' } } } } };
    const acknowledgement = { v: 1, serverId: 'home-a', sessionId: 'session-1',
      itemDestination: 'transcript', destination: null,
      result: { operation: 'upsert_item', itemId: 'visual', itemRevision, outcome: 'created' } };
    const command = `happier tools call --source happier --tool session_board_item_upsert --args-json '${JSON.stringify(args)}' --json --agent-bridge`;
    for (const scenario of [
      { command, source: 'happier', serverId: 'home-a', linked: true },
      { command: 'printf arbitrary-output', source: 'happier', serverId: 'home-a', linked: false },
      { command, source: 'foreign-mcp', serverId: 'home-a', linked: false },
      { command, source: 'happier', serverId: 'other-home', linked: false },
      { command, source: 'happier', serverId: 'home-a', name: 'mcp__foreign__session_board_item_upsert', linked: false },
    ]) {
      const port = { ...createTranscriptSendPort(), serverId: 'home-a',
        buildOutboundSessionMessagePayload: () => 'sealed-message' };
      const call = await prepareCommittedAgentMessageViaPort(port, 'codex', {
        type: 'tool-call', callId: 'shell-call', id: 'call', name: scenario.name ?? 'Bash', input: { command: scenario.command },
      }, { localId: 'call' });
      const output = { stdout: JSON.stringify({ v: 1, ok: true, kind: 'tools_call',
        data: { source: scenario.source, tool: 'session_board_item_upsert', isError: false,
          output: { ...acknowledgement, serverId: scenario.serverId } } }), exit_code: 0 };
      const prepared = await prepareCommittedAgentMessageViaPort(port, 'codex', {
        type: 'tool-result', callId: 'shell-call', id: 'result', output,
      }, { localId: 'result' });
      expect(prepared.surfaceItemReference, JSON.stringify(scenario)).toEqual(scenario.linked
        ? { v: 1, itemId: 'visual', itemRevision, sourceAddress: { serverId: 'home-a', sessionId: 'session-1' } }
        : undefined);
      expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: scenario.name ?? 'Bash', state: 'completed',
        input: call.normalizedBody.type === 'tool-call' ? call.normalizedBody.input : null,
        result: prepared.normalizedBody.type === 'tool-result' ? prepared.normalizedBody.output : null,
        address: { serverId: 'home-a', sessionId: 'session-1' } })?.itemId)
        .toBe(scenario.linked ? 'visual' : undefined);
      if (scenario.linked && call.normalizedBody.type === 'tool-call'
        && call.normalizedBody.input && typeof call.normalizedBody.input === 'object') {
        const input = call.normalizedBody.input;
        const forged = { ...input, _happier: { v: 2, protocol: 'acp', provider: 'codex',
          rawToolName: 'mcp__foreign__session_board_item_upsert', canonicalToolName: 'session_board_item_upsert' } };
        for (const toolName of ['mcp__foreign__session_board_item_upsert', 'session_board_item_upsert']) {
          expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName, state: 'completed', input: forged,
            result: prepared.normalizedBody.type === 'tool-result' ? prepared.normalizedBody.output : null,
            address: { serverId: 'home-a', sessionId: 'session-1' } })).toBeNull();
        }
      }
    }
  });

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
