import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTestSessionTranscriptSource,
  renderWithSessionTranscriptSource as renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import { readDecodedToolResult, resolveToolCallOutcome } from '../presentation/resolveToolCallOutcome';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import {
  collectHostText,
  findPressableByText,
  installToolShellCommonModuleMocks,
  makeToolCall,
} from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
  sync: { ensureSidechainMessagesLoaded: vi.fn() },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const approvalNavigation = vi.hoisted(() => ({ push: vi.fn() }));

installToolShellCommonModuleMocks({
  expoRouter: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: approvalNavigation.push } }).module;
  },
  storage: async (importOriginal) => {
    const { createStorageModuleMock } =
      await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
      importOriginal,
      overrides: {
        useSetting: createUseSettingMock({
          fallback: (key) =>
            key === 'toolViewShowDebugByDefault' ? false : null,
        }),
      },
    });
  },
});

const { ToolFullView } = await import('./ToolFullView');
const { ToolDetailsPageHeader } = await import('../presentation/ToolDetailsPageHeader');

function headerOutcome(screen: Awaited<ReturnType<typeof renderScreen>>): string | undefined {
  return screen.tree.root.findAll((node) => node.props.testID === 'tool-details-outcome'
    && typeof node.props.accessibilityLabel === 'string')[0]?.props.accessibilityLabel;
}

// The recorded shape of a Codex `action_execute` call (QA Bot, session.archive): operands at the top
// level, the transport envelope beside them, and an MCP text result holding the Action's JSON.
const archiveCall = makeToolCall({
  name: 'mcp__happier__action_execute',
  state: 'completed',
  input: {
    actionId: 'session.archive',
    input: { sessionId: 'session-archived-1' },
    _mcp: {
      serverId: 'happier',
      toolId: 'action_execute',
      display: { title: 'MCP: happier action execute' },
    },
    _happier: {
      v: 2,
      protocol: 'acp',
      provider: 'codex',
      rawToolName: 'mcp__happier__action_execute',
      canonicalToolName: 'mcp__happier__action_execute',
    },
    _raw: {
      actionId: 'session.archive',
      input: { sessionId: 'session-archived-1' },
    },
    _acp: {},
    locations: [],
  },
  result: {
    content: [
      {
        type: 'text',
        text: '{"success":true,"sessionId":"session-archived-1","archivedAt":1792557232467}',
      },
    ],
    structuredContent: null,
    _mcp: { serverId: 'happier', toolId: 'action_execute' },
    _happier: {
      v: 2,
      protocol: 'acp',
      provider: 'codex',
      rawToolName: 'mcp__happier__action_execute',
    },
  },
});

// The same call when the Action asked for approval first: the result is the request, not the effect.
const archiveAskedCall = makeToolCall({
  ...archiveCall,
  result: {
    content: [
      {
        type: 'text',
        text: '{"kind":"approval_request_created","artifactId":"approval-1","actionId":"session.archive"}',
      },
    ],
  },
});

// A Create session call the daemon accepted but had not settled when it returned (`type: 'pending'`).
const createSessionPendingCall = makeToolCall({
  name: 'mcp__happier__action_execute',
  state: 'completed',
  input: {
    actionId: 'session.spawn_new',
    input: {
      creationKey: 'fix-r45-auth-helper-20261021-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/home/happier' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' }, updatedAt: 0 },
      title: 'Authorization check helper',
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 }, options: {} },
    },
  },
  result: {
    content: [
      {
        type: 'text',
        text: JSON.stringify(SessionSpawnNewResultV1Schema.parse({ type: 'pending', retryWithSameCreationKey: true,
          outcome: 'accepted', operation: { serverId: 'server-1', machineId: 'machine-1', operationId: 'operation-1' } })),
      },
    ],
  },
});

describe('ToolFullView as the tool-details page', () => {
  it('reopens the exact Shell result on reconnect and drops expired output behind the cursor', async () => {
    let connection: 'live' | 'offline' = 'live';
    let expired = false;
    const loadToolOutput = vi.fn(async ({ messageId }: { messageId: string }) => {
      expect(messageId).toBe('shell-result-row');
      return expired ? { status: 'expired', days: 7 } as const
        : { status: 'available', result: { exitCode: 0, stdout: 'detached fixture stdout' } } as const;
    });
    const source = {
      ...createTestSessionTranscriptSource({ sessionId: 's1',
        authorship: { viewerScope: { serverId: 'home-1', accountId: 'viewer' }, hasOtherNamedCollaborator: false } }),
      loadToolOutput,
      useConnectionState: () => connection,
    };
    const tool = makeToolCall({ id: 'shell-use', name: 'Bash', state: 'completed', input: { command: 'echo fixture' },
      result: { exitCode: 0 }, toolOutputMessageId: 'shell-result-row', toolOutputAvailability: { status: 'available' } });
    const screen = await renderScreen(<ToolFullView tool={tool} owningMessageId="shell-call-row" />, source);
    await act(async () => {});
    expect(loadToolOutput).toHaveBeenCalledTimes(1);
    expect(screen.getTextContent()).toContain('detached fixture stdout');
    connection = 'offline';
    await screen.update(<ToolFullView tool={tool} owningMessageId="shell-call-row" />);
    expect(screen.getTextContent()).not.toContain('detached fixture stdout');
    expect(loadToolOutput).toHaveBeenCalledTimes(1);
    expired = true;
    connection = 'live';
    await screen.update(<ToolFullView tool={tool} owningMessageId="shell-call-row" />);
    await act(async () => {});
    expect(screen.getTextContent()).not.toContain('detached fixture stdout');
    expect(screen.findByTestId('tool-details-result-expired')).toBeTruthy();
    expect(loadToolOutput).toHaveBeenCalledTimes(2);
    await screen.update(<ToolFullView tool={{ ...tool, toolOutputAvailability: { status: 'expired', days: 7 } }}
      owningMessageId="shell-call-row" />);
    expect(loadToolOutput).toHaveBeenCalledTimes(2);
  });

  it('replaces expired Shell output in the details page and in Debug', async () => {
    const tool = makeToolCall({
      name: 'Bash', state: 'completed', input: { command: 'echo retained-command' },
      result: { stdout: 'stale-output-sentinel', exitCode: 0 },
      toolOutputAvailability: { status: 'expired', days: 30 },
    });
    const screen = await renderScreen(<ToolFullView tool={tool} owningMessageId="shell-expired" />);
    expect(screen.findByTestId('tool-details-result-expired')).toBeTruthy();
    expect(screen.getTextContent()).toContain('retained-command');
    await screen.pressByTestIdAsync('tool-details-debug-toggle');
    expect(screen.getTextContent()).not.toContain('stale-output-sentinel');
  });

  it.each(['denied', 'canceled'] as const)('keeps the Shell %s decision quiet in details and its header', async (status) => {
    const tool = makeToolCall({ name: 'Bash', state: 'error', result: { error: 'Terminal permission outcome' },
      permission: { id: 'shell-permission', status, decision: status === 'denied' ? 'denied' : 'abort',
        ...(status === 'denied' ? { decisionActor: { kind: 'accountUser', accountId: 'owner', relationship: 'owner' } as const } : {}) },
    });
    const screen = await renderScreen(<ToolFullView tool={tool} owningMessageId="shell-decision" sessionId="s1"
      header={<ToolDetailsPageHeader tool={tool} metadata={null} />} />);
    const label = formatApprovalStatusLabel(status === 'denied' ? 'rejected' : 'canceled');
    expect(headerOutcome(screen)).toBe(label);
    expect(collectHostText(screen.tree).join('\n')).toContain(label);
    expect(screen.findByTestId('tool-error-body')).toBeNull();
  });

  it('presents contextual Session operands without inventing a value for malformed input', async () => {
    for (const [input, sessionId, expectedSession] of [
      [{}, 'originating-session', 'originating-session'],
      [{ sessionId: 'explicit-other-session' }, 'originating-session', 'explicit-other-session'],
      [{ sessionId: null }, 'originating-session', null],
      [{}, undefined, null],
    ] as const) {
      const tool = makeToolCall({
        name: 'mcp__happier__action_execute', state: 'completed', result: null,
        input: { actionId: 'session.capabilities.set', input: { kind: 'native_skill', id: 'pdf', state: 'on', ...input } },
      });
      const screen = await renderScreen(<ToolFullView tool={tool} owningMessageId="contextual-call" sessionId={sessionId} />);
      const warnings = screen.tree.root.findAllByProps({ testID: 'approvals.unrepresentable-details' });
      if (expectedSession) {
        expect(warnings).toHaveLength(0);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(collectHostText(screen.tree).join('\n')).toContain(expectedSession);
      } else {
        // A completed call is history: no approval advice, and no Session value invented for it.
        expect(warnings).toHaveLength(0);
        expect(collectHostText(screen.tree).join('\n')).not.toContain('originating-session');
      }
      await screen.unmount();
    }
  });

  it('updates the approval link from pending to the matched rejected or canceled outcome', async () => {
    const page = (declinedApproval: 'rejected' | 'canceled' | null) => (
      <ToolFullView tool={archiveAskedCall} owningMessageId="tool-message-2" sessionId="s1" serverId="home-1"
        declinedApproval={declinedApproval}
        header={<ToolDetailsPageHeader tool={archiveAskedCall} metadata={null} declinedApproval={declinedApproval} />} />
    );
    const screen = await renderScreen(page(null));
    expect(collectHostText(screen.tree).join('\n')).toContain('toolView.approvalRequested.title');
    for (const disposition of ['rejected', 'canceled'] as const) {
      await screen.update(page(disposition));
      expect(headerOutcome(screen)).toBe(formatApprovalStatusLabel(disposition));
      const visible = collectHostText(screen.tree).join('\n');
      expect(visible).toContain(formatApprovalStatusLabel(disposition));
      // A person's rejection or a cancel is not Happier refusing the call: the row says only the request's outcome.
      expect(visible).not.toContain('toolView.actionOutcome.refusedReason');
      expect(visible).not.toContain('toolView.approvalRequested.title');
      expect(visible).not.toContain('toolView.approvalRequested.description');
      const link = screen.tree.root.findAll((node) => node.props.testID === 'tool-details-approval-request'
        && typeof node.props.onPress === 'function')[0];
      expect(link).toBeDefined();
      await act(async () => { link!.props.onPress(); });
      expect(approvalNavigation.push).toHaveBeenLastCalledWith(buildApprovalHref('approval-1', 'home-1'));
    }
  });

  it('uses structured approval output alongside explanatory MCP text in both header and Result', async () => {
    const approval = { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.archive' };
    const tool = makeToolCall({ ...archiveAskedCall, result: {
      structuredContent: approval,
      content: [{ type: 'text', text: 'Approval requested.' }],
    } });
    expect(readDecodedToolResult(tool)).toEqual(approval);
    const screen = await renderScreen(<ToolFullView tool={tool} owningMessageId="tool-message-2" sessionId="s1"
      metadata={null} messages={[]} header={<ToolDetailsPageHeader tool={tool} metadata={null} />} />);
    expect(headerOutcome(screen)).toBe('toolView.approvalRequested.title');
    expect(screen.tree.root.findAllByProps({ testID: 'tool-details-approval-request' }).length).toBeGreaterThan(0);
  });

  it.each([
    { name: 'mcp__external__lookup', input: {}, result: { type: 'pending', task: 'domain-specific data' } },
    { name: 'mcp__external__lookup', input: {}, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } },
    { ...createSessionPendingCall, result: { type: 'pending', outcome: 'accepted' } },
    { ...createSessionPendingCall, result: { type: 'pending', retryWithSameCreationKey: true } },
    { ...createSessionPendingCall, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted', task: 'extra' } },
    { ...createSessionPendingCall, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted', operation: { machineId: 'machine-1', operationId: 'operation-1' } } },
    { ...archiveAskedCall, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } },
    { name: 'mcp__external__lookup', input: {}, result: archiveAskedCall.result },
  ])('keeps completed non-settlement data as an ordinary result: %#', async (input) => {
    const tool = makeToolCall({ ...input, state: 'completed' });
    expect(resolveToolCallOutcome(tool)).toEqual({ kind: 'status', indicator: 'completed' });
    const screen = await renderScreen(<ToolFullView tool={tool} owningMessageId="tool-message-data" sessionId="s1"
      metadata={null} messages={[]} header={<ToolDetailsPageHeader tool={tool} metadata={null} />} />);
    expect(headerOutcome(screen)).toBe('toolView.outcome.completed');
    expect(screen.tree.root.findAllByProps({ testID: 'tool-details-pending' })).toHaveLength(0);
    expect(screen.tree.root.findAllByProps({ testID: 'tool-details-approval-request' })).toHaveLength(0);
  });

  it.each(['accepted', 'unknown'] as const)('reads schema-valid structured Create session settlement (%s)', (outcome) => {
    const operation = { serverId: 'server-1', machineId: 'machine-1', operationId: 'operation-1' };
    const tool = makeToolCall({ ...createSessionPendingCall, result: {
      structuredContent: SessionSpawnNewResultV1Schema.parse({ type: 'pending', retryWithSameCreationKey: true, outcome, operation }),
      content: [{ type: 'text', text: 'Session creation has not settled.' }],
    } });
    expect(resolveToolCallOutcome(tool)).toEqual({ kind: 'pending', confirmed: outcome === 'accepted', details: { operation } });
  });

  it.each([
    { result: { content: [{ type: 'text', text: '{"value":1}' }] }, expected: { value: 1 } },
    { result: { structuredContent: { value: 2 }, content: [] }, expected: { value: 2 } },
    { result: { structuredContent: null, content: [{ type: 'text', text: '{"value":3}' }] }, expected: { value: 3 } },
    { result: { structuredContent: { value: 4 }, content: [{ type: 'image', data: 'image', mimeType: 'image/png' }, { type: 'text', text: 'Image attached.' }] }, expected: { value: 4 } },
    { result: { content: [{ type: 'image', data: 'image', mimeType: 'image/png' }, { type: 'text', text: 'Image attached.' }] }, expected: { content: [{ type: 'image', data: 'image', mimeType: 'image/png' }, { type: 'text', text: 'Image attached.' }] } },
  ])('preserves neighboring MCP decoded results: %#', ({ result, expected }) => {
    expect(readDecodedToolResult(makeToolCall({ ...archiveCall, result }))).toEqual(expected);
  });

  it('retains first-party JSON shell-bridge decoding and Action identity', () => {
    const approval = { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.archive' };
    const tool = makeToolCall({ name: 'Bash', state: 'completed', input: {
      actionId: 'session.archive', input: { sessionId: 'session-archived-1' },
      _happier: { v: 2, protocol: 'claude', provider: 'claude', rawToolName: 'Bash', canonicalToolName: 'action_execute' },
      happierToolsShellBridge: { kind: 'call', source: 'happier', rawCommand: 'happier tools call action_execute --json',
        tool: 'action_execute', json: true, sessionId: null, directory: null, argsJson: null, args: {} },
    }, result: { stdout: JSON.stringify({ v: 1, ok: true, kind: 'tools_call', data: {
      source: 'happier', tool: 'action_execute', isError: false, output: approval,
    } }) } });
    expect(readDecodedToolResult(tool)).toEqual(approval);
    expect(resolveToolCallOutcome(tool)).toEqual({ kind: 'approval_requested', artifactId: 'approval-1' });
  });

  it('retains typed Action failures even when structured output accompanies explanatory text', () => {
    const tool = makeToolCall({ ...archiveCall, result: {
      structuredContent: { errorCode: 'target_unavailable', error: 'target_unavailable' },
      content: [{ type: 'text', text: 'The target is unavailable.' }],
    } });
    expect(resolveToolCallOutcome(tool)).toMatchObject({ kind: 'failure', failure: { code: 'target_unavailable' } });
  });

  it('says a call that asked for approval was sent for approval, in its header too', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: archiveAskedCall,
        owningMessageId: 'tool-message-2',
        sessionId: 's1',
        metadata: null,
        messages: [],
        header: React.createElement(ToolDetailsPageHeader, { tool: archiveAskedCall, metadata: null }),
      }),
    );
    expect(headerOutcome(screen)).toBe('toolView.approvalRequested.title');
  });

  it('retains a completed call’s declined or canceled approval decision in its header', async () => {
    const call = makeToolCall({ name: 'writeTextFile', state: 'completed', input: { path: './notes.txt', content: 'x' }, result: null });
    const header = async (declinedApproval: 'rejected' | 'canceled' | null) =>
      headerOutcome(await renderScreen(React.createElement(ToolDetailsPageHeader, { tool: call, metadata: null, declinedApproval })));

    expect(await header(null)).toBe('toolView.outcome.completed');
    expect(await header('rejected')).toBe(formatApprovalStatusLabel('rejected'));
    expect(await header('canceled')).toBe(formatApprovalStatusLabel('canceled'));
  });

  it('names the Agent that asked a question in the page header, and nothing when no asker is given', async () => {
    const question = makeToolCall({
      name: 'AskUserQuestion',
      state: 'running',
      input: { questions: [{ question: 'Record manager attribution?', header: 'Attribution', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] },
    });
    const header = async (askedBy: string | null) =>
      collectHostText((await renderScreen(React.createElement(ToolDetailsPageHeader, { tool: question, metadata: null, askedBy }))).tree).join('\n');

    expect(await header('Worker that asks')).toContain('requester=Worker that asks');
    expect(await header(null)).not.toContain('askedBy');
  });

  it('reads an accepted, unsettled Create session as in progress, by meaning, never as Completed', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: createSessionPendingCall,
        owningMessageId: 'tool-message-3',
        sessionId: 's1',
        metadata: null,
        messages: [],
        header: React.createElement(ToolDetailsPageHeader, { tool: createSessionPendingCall, metadata: null }),
      }),
    );
    expect(headerOutcome(screen)).toBe('toolView.outcome.pending');
    expect(screen.tree.root.findAll((node) => node.props.testID === 'tool-details-pending').length).toBeGreaterThan(0);
    const visible = collectHostText(screen.tree).join('\n');
    expect(visible).toContain('/home/happier');
    for (const mechanism of ['Creation key', 'fix-r45-auth-helper', 'Plugin id', 'Retry with same creation key', 'Updated at', 'null', 'toolView.outcome.completed']) {
      expect(visible).not.toContain(mechanism);
    }
  });

  it('reads an Action that asked for approval as that request, never its envelope', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: archiveAskedCall,
        owningMessageId: 'tool-message-2',
        sessionId: 's1',
        metadata: null,
        messages: [],
      }),
    );
    expect(
      screen.tree.root.findAll((node) => node.props.testID === 'tool-details-approval-request').length,
    ).toBeGreaterThan(0);
    const visible = collectHostText(screen.tree).join('\n');
    expect(visible).not.toContain('approval_request_created');
    expect(visible).not.toContain('approval-1');
  });

  afterEach(() => {
    standardCleanup();
  });

  it('leads an Action call with its header, arguments and result, and keeps the transport envelope behind Debug', async () => {
    const screen = await renderScreen(
      React.createElement(ToolFullView, {
        tool: archiveCall,
        owningMessageId: 'tool-message-1',
        sessionId: 's1',
        metadata: null,
        messages: [],
        header: React.createElement('PageHeaderProbe', {
          testID: 'page-header-probe',
        }),
      }),
    );

    expect(
      screen.tree.root.findAllByProps({ testID: 'page-header-probe' }).length,
    ).toBeGreaterThan(0);
    const visible = collectHostText(screen.tree).join('\n');
    // The result reads by meaning: the moment as a time under its readable name, without the success
    // flag the header's Completed already says or the Session id Details already names.
    expect(visible).toContain('Archived at');
    expect(visible).not.toContain('archivedAt');
    expect(visible).not.toContain('1792557232467');
    expect(visible).not.toMatch(/\bsuccess\b/);
    expect(visible).not.toContain('rawToolName');
    expect(visible).not.toContain('_mcp');

    const debugToggle = screen.tree.root.findAll((node) => node.props.testID === 'tool-details-debug-toggle' && typeof node.props.onPress === 'function')[0];
    await act(async () => {
      debugToggle?.props.onPress();
    });
    expect(collectHostText(screen.tree).join('\n')).toContain('rawToolName');
  });
});
