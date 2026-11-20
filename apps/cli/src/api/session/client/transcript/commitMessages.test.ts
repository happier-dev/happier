import { describe, expect, it, vi } from 'vitest';

import type { SessionClientTranscriptSendPort } from './sendMessages';
import { resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
import { API_TOKEN_FULL_GRANT_V1, AccountApiTokensCreateActionOutputV1Schema } from '@happier-dev/protocol';
import type { TranscriptRawAgentEventV1 } from '@happier-dev/protocol';
import { commitRuntimeSessionEvent } from '@/agent/runtime/session/transcripts/publishRuntimeSessionEvent';
import { prepareSessionEventMessageViaPort } from './sendMessages';
import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY, type SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import type { RuntimeTranscriptProjectionSession } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import {
  prepareCommittedAgentMessageViaPort,
  prepareCommittedUserTextMessageViaPort,
} from './commitMessages';
import { buildDurableOutboundSessionMessagePayload, buildOutboundSessionMessagePayload } from '../transport/outboundSessionMessagePayload';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';

const TOOL_SOURCE = { protocol: 'acp', agent: { pluginId: 'example.agent', localId: 'fixture' } } as const;

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
  it.each([
    { provider: 'claude', callId: 'toolu_shell', output: { stdout: 'fixture-claude-stdout', stderr: '', interrupted: false }, isError: false },
    { provider: 'codex', callId: 'exec-shell', output: { aggregatedOutput: 'fixture-codex-stdout', stdout: 'fixture-codex-stdout', exitCode: 1 }, isError: true },
    { provider: 'custom-acp/fixture', callId: 'acp-shell', output: { content: [{ type: 'text', text: 'fixture-acp-stdout' }] }, isError: false },
  ])('keeps $provider output bytes out of the durable message shell', async ({ provider, callId, output, isError }) => {
    const port = {
      ...createTranscriptSendPort(),
      buildDurableOutboundSessionMessagePayload: (input: Parameters<typeof buildDurableOutboundSessionMessagePayload>[1]) =>
        buildDurableOutboundSessionMessagePayload({ mode: 'plain', ctx: null }, input),
    };
    await prepareCommittedAgentMessageViaPort(port, provider, {
      type: 'tool-call', id: 'shell-call', callId, name: 'Bash', input: { command: 'printf fixture' },
    }, { localId: 'shell-call', toolNormalizationSource: TOOL_SOURCE });
    const prepared = await prepareCommittedAgentMessageViaPort(port, provider, {
      type: 'tool-result', id: 'shell-result', callId, output, isError, sidechainId: 'sidechain-fixture',
    }, { localId: 'shell-result', toolNormalizationSource: TOOL_SOURCE });
    expect(prepared.payload).toMatchObject({
      t: 'plain', v: { content: { data: { type: 'tool-result', callId, isError } } },
    });
    expect(prepared.toolOutputPart).toMatchObject({ t: 'plain' });
    expect(prepared.sidechainId).toBe('sidechain-fixture');
    expect(JSON.stringify(prepared.payload)).not.toMatch(/fixture-\w+-stdout/);
    expect(JSON.stringify(prepared.toolOutputPart)).toMatch(/fixture-\w+-stdout/);
  });

  it('seals the detached tool body separately and retains an empty successful result inline', async () => {
    const crypto = { mode: 'e2ee', ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' } } as const;
    const makeResult = async (stdout: string) => {
      const port = { ...createTranscriptSendPort(), buildDurableOutboundSessionMessagePayload:
        (input: Parameters<typeof buildDurableOutboundSessionMessagePayload>[1]) => buildDurableOutboundSessionMessagePayload(crypto, input) };
      await prepareCommittedAgentMessageViaPort(port, 'claude', {
        type: 'tool-call', id: 'call', callId: 'shell', name: 'Bash', input: { command: 'printf fixture' },
      }, { localId: 'call', toolNormalizationSource: TOOL_SOURCE });
      return prepareCommittedAgentMessageViaPort(port, 'claude', {
        type: 'tool-result', id: 'result', callId: 'shell', output: { stdout, exitCode: 0 }, isError: false,
      }, { localId: 'result', toolNormalizationSource: TOOL_SOURCE });
    };
    const empty = await makeResult('');
    expect(empty.toolOutputPart).toBeUndefined();
    const prepared = await makeResult('synthetic output');
    if (typeof prepared.payload !== 'string') throw new Error('Expected encrypted transcript shell');
    expect(prepared.toolOutputPart?.t).toBe('encrypted');
    const shell = openSessionStoredContent({ ...crypto, content: { t: 'encrypted', c: prepared.payload } });
    expect(shell).toMatchObject({
      content: { data: { callId: 'shell', isError: false, output: { exitCode: 0 } } },
      meta: { happierToolOutputV1: { v: 1, digest: expect.any(String) } },
    });
    expect(JSON.stringify(shell)).not.toContain('synthetic output');
    expect(openSessionStoredContent({ ...crypto, content: prepared.toolOutputPart })).toMatchObject({
      v: 1, fields: { stdout: 'synthetic output' },
    });
  });

  it('preserves historical tool provenance without looking up a current Agent', async () => {
    const body = { type: 'tool-call', callId: 'historical-call', id: 'historical-row', name: 'Bash', input: {
      command: 'pwd', _happier: { v: 2, protocol: 'acp', provider: 'retired.external',
        rawToolName: 'shell', canonicalToolName: 'Bash' },
    } } as const;
    const prepared = await prepareCommittedAgentMessageViaPort(createTranscriptSendPort(), 'retired.external', body,
      { localId: 'historical-row' });
    expect(prepared.normalizedBody).toEqual(body);
    expect(prepared.source).toBeUndefined();
    expect(prepared.payload).toMatchObject({ t: 'plain', v: { content: { data: body } } });
  });

  it('carries selected native provenance to the normalizer before sealing', async () => {
    const source = { protocol: 'native', agent: { pluginId: 'example.agent', localId: 'native' } } as const;
    const prepared = await prepareCommittedAgentMessageViaPort(createTranscriptSendPort(), 'example.agent/native', {
      type: 'tool-call', callId: 'native-tool', id: 'native-call', name: 'Bash', input: { command: 'pwd' },
    }, { localId: 'native-call', toolNormalizationSource: source });
    expect(prepared.payload).toMatchObject({ t: 'plain', v: { content: { data: {
      input: { _happier: { v: 3, ...source } },
    } } } });
  });

  it('retains a per-record empty timing proof before encrypting ordinary user content', () => {
    const port = { ...createTranscriptSendPort(), buildOutboundSessionMessagePayload: (content: unknown) =>
      buildOutboundSessionMessagePayload({ mode: 'e2ee', ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' } }, content) };
    const prepared = prepareCommittedUserTextMessageViaPort(port, 'Private user content', { localId: 'timed-input' });
    expect(typeof prepared.payload).toBe('string');
    expect(Reflect.get(prepared, 'usageTimingV1')).toEqual({ v: 1, minMs: null, maxMs: null });
    expect(JSON.stringify(Reflect.get(prepared, 'usageTimingV1'))).not.toContain('Private');
  });

  it('reuses a capability notice identity across runner retries while keeping distinct failures', () => {
    const items: SessionCapabilityNoticeV1['items'] = [
      { kind: 'mcp_server', itemId: 'mcp-1', name: 'Tracker', code: 'mcp_unavailable', detail: 'catalog_unavailable' },
      { kind: 'skill', itemId: 'skill-1', name: 'Review', code: 'skills_unavailable', detail: 'content_unreadable' },
    ];
    const prepare = (noticeItems: SessionCapabilityNoticeV1['items']) => prepareSessionEventMessageViaPort(
      createTranscriptSendPort(), { type: 'message', message: 'Capability preparation failed',
        [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: { v: 1, items: noticeItems } });
    const first = prepare(items);
    const retried = prepare([...items].reverse());
    expect(retried.localId).toBe(first.localId);
    expect(prepare([{ ...items[0], detail: 'permission_denied' }, items[1]]).localId).not.toBe(first.localId);
    const transition = prepareSessionEventMessageViaPort(createTranscriptSendPort(), {
      type: 'message', message: 'Capability preparation failed',
      [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: { v: 1, items },
    }, 'capability-transition-after-recovery');
    expect(transition.localId).toBe('capability-transition-after-recovery');
    expect(prepareSessionEventMessageViaPort(createTranscriptSendPort(), { type: 'message', message: 'Ordinary event' }).localId)
      .not.toBe(prepareSessionEventMessageViaPort(createTranscriptSendPort(), { type: 'message', message: 'Ordinary event' }).localId);
  });
  it.each(['claude', 'codex'] as const)('projects correlated Action results before %s transcript normalization and sealing', async provider => {
    for (const tool of ['account_api_tokens_create', 'action_execute']) {
      const port = createTranscriptSendPort();
      const tokenId = '2c67deea-4706-40fe-8f36-dd0935ca35ca';
      const bearer = `hap_v1_${tokenId}_${'A'.repeat(43)}`;
      const raw = AccountApiTokensCreateActionOutputV1Schema.parse({ token: bearer, apiToken: {
        tokenId, label: 'Requester only', displayPrefix: 'hap_v1_2c67deea', createdAt: '2026-10-16T12:00:00.000Z',
        lastUsedAt: null, expiresAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
        grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 0, embedConfig: null,
      } });
      const nativeOutput = provider === 'claude'
        ? { content: [{ type: 'text', text: JSON.stringify(raw) }], tool_use_result: raw }
        : { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw, isError: false };
      await prepareCommittedAgentMessageViaPort(port, provider, {
        type: 'tool-call', callId: 'token-call', id: 'call', name: `mcp__happier__${tool}`,
        input: tool === 'action_execute' ? { actionId: 'account.apiTokens.create', input: {} } : {},
      }, { toolNormalizationSource: TOOL_SOURCE, localId: 'call' });
      for (const localId of ['result', 'repeated-result']) {
        const prepared = await prepareCommittedAgentMessageViaPort(port, provider, {
          type: 'tool-result', callId: 'token-call', id: localId, output: nativeOutput,
        }, { toolNormalizationSource: TOOL_SOURCE, localId });
        expect(JSON.stringify(prepared.payload)).not.toContain(bearer);
        if (prepared.normalizedBody.type !== 'tool-result') throw new Error('Expected tool result');
        expect(prepared.normalizedBody.output).toMatchObject({ apiToken: raw.apiToken });
        expect(JSON.stringify(prepared.normalizedBody.output)).not.toContain(bearer);
      }
      expect(JSON.stringify(nativeOutput)).toContain(bearer);
      const foreignPort = createTranscriptSendPort();
      await prepareCommittedAgentMessageViaPort(foreignPort, provider, {
        type: 'tool-call', callId: 'foreign-call', id: 'foreign-call', name: `mcp__foreign__${tool}`,
        input: { actionId: 'account.apiTokens.create', input: {} },
      }, { toolNormalizationSource: TOOL_SOURCE, localId: 'foreign-call' });
      const foreign = await prepareCommittedAgentMessageViaPort(foreignPort, provider, {
        type: 'tool-result', callId: 'foreign-call', id: 'foreign-result', output: { text: 'External tool receipt' },
      }, { toolNormalizationSource: TOOL_SOURCE, localId: 'foreign-result' });
      expect(foreign.normalizedBody).toMatchObject({ output: { text: 'External tool receipt' } });
    }
  });

  it.each(['goal-changed', 'worker-report'] as const)('keeps the original %s category readable to Home policy without opening its encrypted body', type => {
    const prepared = prepareSessionEventMessageViaPort({ sessionId: 'session-1', buildOutboundSessionMessagePayload: () => 'sealed-original' },
      type === 'goal-changed' ? { type } : { type, summary: 'Private published result' }, 'original-id');
    expect(prepared.localId).toMatch(new RegExp(`^${type}:`));
    expect(prepared.payload).toBe('sealed-original');
    expect(prepared.messageRole).toBe('event');
  });

  it.each([
    { type: 'worker-update', update: { v: 1, workerKind: 'session', workerId: 'worker',
      ownerState: 'settled', wake: 'finished', headline: 'Worker finished', result: 'Done', canInspect: true } },
    { type: 'message', message: 'Followed context changed, so Happier woke this Agent with the update.' },
  ] satisfies TranscriptRawAgentEventV1[])('publishes the host $type with event-role metadata for durable Follow acknowledgement', async (event) => {
    const port = createTranscriptSendPort();
    const localId = 'session-follow-wake:accepted-worker';
    let stored: Readonly<{ messageRole: string; sidechainId: string | null; transcriptObservationProvenance: unknown }> | null = null;
    // Durable storage is the system boundary; host publication and transport classification stay real.
    const session = {
      sessionId: port.sessionId,
      enqueueAgentMessageCommitted: async (provider, body, options) => {
        const prepared = await prepareCommittedAgentMessageViaPort(port, provider, body, options);
        stored = { messageRole: prepared.messageRole, sidechainId: prepared.sidechainId,
          transcriptObservationProvenance: options.provenance };
        return { persisted: true, delivered: true };
      },
    } satisfies RuntimeTranscriptProjectionSession;
    await commitRuntimeSessionEvent({ session, agentId: 'claude', localId, event });
    // Event-role metadata is the storage contract required by the server Follow
    // acceptance owner; its database/authorization checks stay in server suites.
    expect(stored).toEqual({ messageRole: 'event', sidechainId: null,
      transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } });
  });

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
    await prepareCommittedAgentMessageViaPort(port, 'codex', call, { toolNormalizationSource: TOOL_SOURCE, localId: 'call' });
    const body = { type: 'tool-result' as const, callId: 'visual-call', id: 'result', output: {
      v: 1, serverId: 'home-a', sessionId: 'session-1', itemDestination: 'transcript', destination: null,
      result: { operation: 'upsert_item', itemId: 'visual', itemRevision, outcome: 'created' },
    } };
    const acknowledgedInput = port.toolCallInputByProviderAndId.get('codex:visual-call');
    const prepared = await prepareCommittedAgentMessageViaPort(port, 'codex', body, { toolNormalizationSource: TOOL_SOURCE, localId: 'result' });
    expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: 'session_board_item_upsert', state: 'completed',
      input: acknowledgedInput, result: prepared.normalizedBody.type === 'tool-result' ? prepared.normalizedBody.output : null,
      address: { serverId: 'home-a', sessionId: 'session-1' } }))
      .toMatchObject({ itemId: 'visual' });
    expect(prepared.payload).toBe('sealed-message');
    expect(prepared).toHaveProperty('surfaceItemReference', { v: 1, references: [{ v: 1, itemId: 'visual', itemRevision,
      sourceAddress: { serverId: 'home-a', sessionId: 'session-1' }, sourceItemId: 'visual', sourceItemRevision: itemRevision }] });
    await prepareCommittedAgentMessageViaPort(port, 'codex', call, { toolNormalizationSource: TOOL_SOURCE, localId: 'foreign-call' });
    const foreign = await prepareCommittedAgentMessageViaPort(port, 'codex', {
      ...body, output: { ...body.output, serverId: 'other-home' },
    }, { toolNormalizationSource: TOOL_SOURCE, localId: 'foreign' });
    expect(foreign).not.toHaveProperty('surfaceItemReference');
  });

  it('binds a visual approval receipt to its exact native result row without publishing pending content', async () => {
    for (const scenario of [
      { actionId: 'session.board.item.upsert', isError: false, linked: true },
      { actionId: 'session.board.item.upsert', isError: true, linked: false },
      { actionId: 'session.rename', isError: false, linked: false },
    ]) {
      const port = { ...createTranscriptSendPort(), serverId: 'home-a',
        buildOutboundSessionMessagePayload: () => 'sealed-receipt' };
      await prepareCommittedAgentMessageViaPort(port, 'codex', {
        type: 'tool-call', callId: 'asked-visual-call', id: 'call', name: 'session_board_item_upsert',
        input: { itemId: 'visual', expectedItemRevision: null, destination: 'transcript',
          item: { v: 1, title: 'Result', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Result' } } } } },
      }, { toolNormalizationSource: TOOL_SOURCE, localId: 'native-call' });
      const receipt = { kind: 'approval_request_created', artifactId: 'visual-approval', actionId: scenario.actionId };
      const prepared = await prepareCommittedAgentMessageViaPort(port, 'codex', {
        type: 'tool-result', callId: 'asked-visual-call', id: 'result', output: receipt, isError: scenario.isError,
      }, { toolNormalizationSource: TOOL_SOURCE, localId: 'native-result' });
      expect(prepared.localId).toBe('native-result');
      expect(prepared.payload).toBe('sealed-receipt');
      expect(prepared.normalizedBody).toMatchObject({ type: 'tool-result', output: receipt });
      expect(prepared).not.toHaveProperty('surfaceItemReference');
      expect(Reflect.get(prepared, 'approvalRequestArtifactId'), JSON.stringify(scenario))
        .toBe(scenario.linked ? 'visual-approval' : undefined);
    }
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
      }, { toolNormalizationSource: TOOL_SOURCE, localId: 'call' });
      const output = { stdout: JSON.stringify({ v: 1, ok: true, kind: 'tools_call',
        data: { source: scenario.source, tool: 'session_board_item_upsert', isError: false,
          output: { ...acknowledgement, serverId: scenario.serverId } } }), exit_code: 0 };
      const prepared = await prepareCommittedAgentMessageViaPort(port, 'codex', {
        type: 'tool-result', callId: 'shell-call', id: 'result', output,
      }, { toolNormalizationSource: TOOL_SOURCE, localId: 'result' });
      expect(prepared.surfaceItemReference, JSON.stringify(scenario)).toEqual(scenario.linked
        ? { v: 1, references: [{ v: 1, itemId: 'visual', itemRevision, sourceAddress: { serverId: 'home-a', sessionId: 'session-1' },
          sourceItemId: 'visual', sourceItemRevision: itemRevision }] }
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
