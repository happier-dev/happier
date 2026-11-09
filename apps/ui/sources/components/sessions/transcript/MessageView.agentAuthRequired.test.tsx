import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import type { Message } from '@happier-dev/session-core/messages';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createTestSessionTranscriptSource,
  renderWithSessionTranscriptSource as renderScreen,
} from '@/dev/testkit/sessionTranscriptSource';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn() } }).module;
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
  },
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
await import('./MessageView');
const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');

const RECOVERY = 'transcript-event-agent-auth-recovery';
const MACHINE_ID = 'machine-1';
const PROVIDER_TEXT = 'codex turn failed: The Provider endpoint requires a credential. Add a Saved Secret to the Provider connection.';

/** The persisted shape the host failure projector commits, read back through the real reducer. */
function projectFailure(source: SessionRuntimeIssueV1['source'], overrides: Partial<SessionRuntimeIssueV1> = {}): Message {
  const normalized = normalizeRawMessage('failure', 'failure', 1_000, {
    role: 'agent',
    content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: PROVIDER_TEXT } },
    meta: { source: 'runtime', runtimeIssueV1: {
      v: 1, scope: 'primary_session', status: 'failed', code: 'provider_endpoint_auth_required', source,
      occurredAt: 1_000, agentId: 'codex', sanitizedPreview: PROVIDER_TEXT,
      ...overrides,
    } },
  }, { seq: 1 });
  return reducer(createReducer(), [normalized!]).messages[0]!;
}

async function renderRow(message: Message, options: Readonly<{ machineKnown: boolean; navigate: ((href: string) => void) | null }>) {
  const { MessageView } = await import('./MessageView');
  const home = await upsertServerProfileOnly({ serverUrl: 'https://home.agent-auth.test', name: 'Home' });
  const identified = await setServerProfileIdentityForUrl(home.serverUrl, 'srv_agent_auth');
  const serverId = identified?.id ?? home.id;
  const source = createTestSessionTranscriptSource({
    sessionId: 's1',
    serverId,
    messages: [message],
    metadata: options.machineKnown ? { machineId: MACHINE_ID } as never : null,
    interaction: { canSendMessages: true, canApprovePermissions: true },
    navigate: options.navigate,
  });
  return renderScreen(<MessageView message={message} metadata={null} sessionId="s1" serverId={serverId} />, source);
}

describe('MessageView native Agent sign-in requirement row', () => {
  afterEach(() => standardCleanup());

  it('shows the sign-in guidance, never the Provider secret copy, and opens the Agent on its machine', async () => {
    const navigate = vi.fn();
    const screen = await renderRow(projectFailure('auth_error'), { machineKnown: true, navigate });
    const text = screen.getTextContent();
    expect(text).toContain('session.agentAuthRequired.message');
    expect(text).not.toContain('Saved Secret');
    await act(async () => { screen.pressByTestId(RECOVERY); });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      `/(app)/settings/agents/codex?machineId=${MACHINE_ID}&serverIdentityId=srv_agent_auth`,
    );
  });

  it('keeps a Provider endpoint credential row on its own text with no sign-in action', async () => {
    const screen = await renderRow(projectFailure('agent_session_error'), { machineKnown: true, navigate: vi.fn() });
    expect(screen.getTextContent()).toContain('Saved Secret');
    expect(screen.findByTestId(RECOVERY)).toBeNull();
  });

  it.each(['provider_account_identity_unavailable', 'workspace_incompatible', 'credential_family_mismatch', 'live_hot_auth_failed'] as const)(
    'opens existing Agent sign-in recovery for startup refusal %s', async reason => {
      const navigate = vi.fn();
      const screen = await renderRow(projectFailure('auth_error', {
        code: 'codex_refresh_free_auth_unsupported',
        failureCause: { phase: 'authentication', failureReason: 'authentication_required', reason },
      }), { machineKnown: true, navigate });
      expect(screen.getTextContent()).toContain('session.agentAuthRequired.message');
      expect(screen.getTextContent()).not.toContain('Saved Secret');
      await act(async () => { screen.pressByTestId(RECOVERY); });
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        `/(app)/settings/agents/codex?machineId=${MACHINE_ID}&serverIdentityId=srv_agent_auth`,
      );
    },
  );

  it.each([
    ['refresh_bridge_unavailable', 'codex_refresh_bridge_unavailable'],
    ['experimental_api_unavailable', 'codex_experimental_api_unavailable'],
  ] as const)('shows the dependency recovery for %s without Agent sign-in', async (reason, key) => {
    const screen = await renderRow(projectFailure('dependency_failure', {
      code: 'codex_refresh_free_auth_unsupported',
      failureCause: { phase: 'authentication', failureReason: 'unclassified_provider_error', reason },
    }), { machineKnown: true, navigate: vi.fn() });
    expect(screen.getTextContent()).toContain(`session.startFailure.cause.${key}`);
    expect(screen.findByTestId(RECOVERY)).toBeNull();
  });

  it('offers no action where the transcript cannot navigate or does not know the machine', async () => {
    expect((await renderRow(projectFailure('auth_error'), { machineKnown: true, navigate: null })).findByTestId(RECOVERY)).toBeNull();
    expect((await renderRow(projectFailure('auth_error'), { machineKnown: false, navigate: vi.fn() })).findByTestId(RECOVERY)).toBeNull();
  });
});
