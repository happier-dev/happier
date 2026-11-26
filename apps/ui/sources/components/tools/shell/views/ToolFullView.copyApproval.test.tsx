import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';

import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';
import { renderWithSessionTranscriptSource as renderScreen } from '@/dev/testkit';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { resolveToolCallOutcome } from '../presentation/resolveToolCallOutcome';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';

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

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// Historical Action operands use the normal app-owned Sync Artifact-title reader.
await import('@/sync/syncEngine');

const { ToolFullView } = await import('./ToolFullView');
const { ToolDetailsPageHeader } = await import('../presentation/ToolDetailsPageHeader');

function headerOutcome(screen: Awaited<ReturnType<typeof renderScreen>>): string | undefined {
  return screen.tree.root.findAll((node) => node.props.testID === 'tool-details-outcome'
    && typeof node.props.accessibilityLabel === 'string')[0]?.props.accessibilityLabel;
}

afterEach(() => {
  standardCleanup();
});

it.each(['success', 'failure'] as const)('reopens the native Copy with its durable %s receipt', async (settlement) => {
  const serverId = await homes.addHome({ name: 'Copy Home', serverUrl: 'https://copy-home.test', accountId: 'owner' });
  const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { storage } = await import('@/sync/domains/state/storage');
  const scope = { serverId, accountId: 'owner' };
  await storage.getState().activateSettingsScope(scope, []);
  storage.getState().activateProfileScope(scope, []);
  const context = await captureActionAccountContext(serverId);
  try {
    const actionId = BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1;
    const sessionId = 'originating-session';
    const childId = '45b4e66c-84b7-4f89-b8cf-4aaab1b4e9b2';
    const source = { kind: 'artifact', serverId, artifactId: '94d255d2-2f63-480a-a7c0-7cfe4296ec29' };
    const actionArgs = { source, expectedVersion: '1.0.0', name: 'Approval companion', creation: {
      executionTarget: { serverId, machineId: 'internal-copy-machine' },
      directory: { kind: 'path', path: '/tmp' }, permissionMode: 'read-only',
    } };
    const approved = ApprovalRequestV2Schema.parse({
      v: 2, status: settlement === 'success' ? 'executed' : 'failed',
      createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent',
      actionId, actionArgs, summary: 'Make my own Bot',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId, actionId, requestId: 'native-copy' },
      origin: { kind: 'transcript_tool_call', sessionId, toolCallId: 'copy-call' },
      preview: { hostReviewedContent: { source, release: { v: 1, version: '1.0.0', releasedAtMs: 1,
        changelog: 'Initial', content: { v: 1, identity: { name: 'Approval companion', description: '' },
          instructions: { markdown: 'Wait for a task.' }, firstTask: 'Review an approval', memoryRules: [], skills: [],
          needs: { software: [], connectedAccounts: [], mcpServers: [] } } } } },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: settlement === 'success'
        ? { executedAtMs: 3, ok: true, result: { type: 'success', disposition: 'created', sessionId: childId,
          executionTarget: { serverId, machineId: 'internal-copy-machine' },
          organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } }
        : { executedAtMs: 3, ok: false, errorCode: 'spawn_failed',
          failureCause: { phase: 'session.launch', errorClass: 'Error',
            errorCode: 'connected_service_qualified_purpose_authority_unavailable', httpStatus: null } },
    });
    const artifactId = await context.createArtifact(buildApprovalRequestArtifactHeaderV1(approved), JSON.stringify(approved));
    // 11-25 Muse replay: the retained tool result is a native value envelope carrying the Approval id.
    const name = 'mcp__happier__action_execute';
    const envelope = {
      _mcp: { serverId: 'happier', toolId: 'action_execute' },
      _happier: { v: 3, protocol: 'native', agent: { pluginId: 'happier.agent.muse', localId: 'muse' },
        rawToolName: name, canonicalToolName: name },
      _acp: {},
    };
    const tool = makeToolCall({ id: 'copy-call', name, state: 'completed',
      input: { ...envelope, actionId, input: JSON.stringify(actionArgs), locations: [] },
      result: { ...envelope, value: JSON.stringify({ kind: 'approval_request_created', artifactId, actionId }) } });
    expect(resolveToolCallOutcome(tool)).toEqual({ kind: 'approval_requested', artifactId });
    const screen = await renderScreen(<ToolFullView tool={tool} sessionId={sessionId} serverId={serverId}
      owningMessageId="copy-message" header={<ToolDetailsPageHeader tool={tool} metadata={null} />} />);
    try {
      await waitForHomeGovernance(() => expect(headerOutcome(screen)).toBe(
        formatApprovalStatusLabel(settlement === 'success' ? 'executed' : 'failed')));
      expect(screen.getTextContent()).toContain('Review an approval');
      expect(screen.getTextContent()).not.toContain('internal-copy-machine');
      expect(screen.findByTestId('tool-details-approval-request')).not.toBeNull();
      if (settlement === 'success') {
        await screen.pressByTestIdAsync('tool-details-copy-bot');
        expect(approvalNavigation.push).toHaveBeenLastCalledWith(buildScopedSessionRouteHref({ serverId, sessionId: childId }));
      } else {
        expect(screen.findByTestId('tool-details-copy-bot')).toBeNull();
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain('connected_service_qualified_purpose_authority_unavailable');
      }
    } finally {
      await screen.unmount();
    }
  } finally {
    context.dispose();
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
  }
});
