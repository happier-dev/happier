import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import type { Message } from '@happier-dev/session-core/messages';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

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
const { applyTeamCredentialResourceCatalog, resetTeamsSnapshotsForTests } =
  await import('@/sync/store/teams/teamsSnapshots');
const { registerSessionComposerPresentationTarget } =
  await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { SESSION_MODEL_PICKER_CHIP_KEY } =
  await import('@/components/sessions/presentation/useSessionModelPickerEntry');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');

const HOME = 'home';
const RESOURCE_ID = 'c107-resource';
const CREDENTIAL_NAME = 'Platform Codex gateway';
const RECOVERY = 'transcript-event-runtime-issue-recovery';

const catalogResource = TeamCredentialResourceCatalogEntryV1Schema.parse({
  id: RESOURCE_ID,
  teamId: 'team-a',
  displayName: CREDENTIAL_NAME,
  resourceRevision: 1,
  readiness: { kind: 'available' },
  recoveryAction: null,
  mayBroker: true,
  mayReceiveDirect: false,
  directMaterialState: 'never_delivered',
  sessionUsePolicy: null,
  sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
  providerModels: [],
});

function seedCatalog(accountId: string) {
  const serverId = resolveServerProfileScopeIdForIdentifier(HOME);
  applyTeamCredentialResourceCatalog({
    scope: { serverId, accountId },
    address: { serverId, teamId: 'team-a' },
    resources: [catalogResource],
    observedAt: 1,
  });
}

/** The persisted shape the host failure projector commits, read back through the real reducer. */
function projectFailure(meta: Record<string, unknown>): Message {
  const state = createReducer();
  const normalized = normalizeRawMessage(
    'failure',
    'failure',
    1_000,
    {
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'custom-acp',
        data: {
          type: 'message',
          message: 'Shared Team credential refused the request',
        },
      },
      meta,
    },
    { seq: 1 },
  );
  return reducer(state, [normalized!]).messages[0]!;
}

const teamIssueMeta = {
  source: 'runtime',
  runtimeIssueV1: {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'team_credential',
    source: 'team_credential',
    occurredAt: 1_000,
    sanitizedPreview: 'Shared Team credential refused the request',
    teamCredential: {
      v: 1,
      resourceId: RESOURCE_ID,
      reasonCode: 'resource_forbidden',
    },
  },
};

const viewers = {
  owner: { accountId: 'B', canSendMessages: true, canApprovePermissions: true },
  'shared-editor': {
    accountId: 'A',
    canSendMessages: true,
    canApprovePermissions: false,
  },
  'read-only': {
    accountId: 'R',
    canSendMessages: false,
    canApprovePermissions: false,
  },
} as const;

async function renderRow(message: Message, viewer: keyof typeof viewers) {
  const { MessageView } = await import('./MessageView');
  const { accountId, ...interaction } = viewers[viewer];
  const source = createTestSessionTranscriptSource({
    sessionId: 's1',
    serverId: HOME,
    messages: [message],
    metadata: null,
    authorship: {
      viewerScope: { serverId: HOME, accountId },
      hasOtherNamedCollaborator: true,
    },
    interaction,
  });
  return renderScreen(
    <MessageView
      message={message}
      metadata={null}
      sessionId="s1"
      serverId={HOME}
    />,
    source,
  );
}

/** The mounted composer is a real registry participant; only its picker surface is stood in for. */
function mountComposer(offered: boolean) {
  const openActionChip = vi.fn(() => true);
  const unregister = registerSessionComposerPresentationTarget(
    { serverId: HOME, sessionId: 's1' },
    {
      readRevision: () => 0,
      replace: () => 0,
      openActionChip,
      hasActionChip: (chipKey) =>
        offered && chipKey === SESSION_MODEL_PICKER_CHIP_KEY,
    },
  );
  return { openActionChip, unregister };
}

describe('MessageView Team credential denial row', () => {
  beforeEach(() => resetTeamsSnapshotsForTests());
  afterEach(() => {
    resetTeamsSnapshotsForTests();
    standardCleanup();
  });

  it.each(['owner', 'shared-editor'] as const)(
    'names a catalog-known credential and opens the composer model picker for a %s',
    async (viewer) => {
      seedCatalog(viewers[viewer].accountId);
      const composer = mountComposer(true);
      try {
        const screen = await renderRow(projectFailure(teamIssueMeta), viewer);
        expect(screen.getTextContent()).toContain(CREDENTIAL_NAME);
        expect(screen.getTextContent()).toContain(
          'teams.credentials.recovery.chooseAnother',
        );
        expect(screen.findByTestId(RECOVERY)?.props.disabled).not.toBe(true);
        await act(async () => {
          screen.pressByTestId(RECOVERY);
        });
        expect(composer.openActionChip).toHaveBeenCalledExactlyOnceWith(
          SESSION_MODEL_PICKER_CHIP_KEY,
        );
      } finally {
        await act(async () => composer.unregister());
      }
    },
  );

  it('never prints the resource id as a name, and does not borrow another Account catalog', async () => {
    seedCatalog('someone-else');
    const composer = mountComposer(true);
    try {
      const screen = await renderRow(
        projectFailure(teamIssueMeta),
        'shared-editor',
      );
      expect(screen.getTextContent()).not.toContain(CREDENTIAL_NAME);
      expect(screen.getTextContent()).not.toContain(RESOURCE_ID);
      expect(screen.getTextContent()).toContain(
        'teams.credentials.sessionDeniedTitle',
      );
      expect(screen.findByTestId(RECOVERY)).not.toBeNull();
    } finally {
      await act(async () => composer.unregister());
    }
  });

  it('shows the name once the catalog loads after the row rendered', async () => {
    const composer = mountComposer(true);
    try {
      const screen = await renderRow(projectFailure(teamIssueMeta), 'owner');
      expect(screen.getTextContent()).not.toContain(CREDENTIAL_NAME);
      await act(async () => {
        seedCatalog(viewers.owner.accountId);
      });
      expect(screen.getTextContent()).toContain(CREDENTIAL_NAME);
    } finally {
      await act(async () => composer.unregister());
    }
  });

  it('keeps the action visible but disabled, with its reason, for a viewer who cannot change the model', async () => {
    const screen = await renderRow(projectFailure(teamIssueMeta), 'read-only');
    const action = screen.findByTestId(RECOVERY);
    expect(action?.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain(
      'session.sharing.noEditPermission',
    );
  });

  it('offers no action where the Session has no composer to pick from', async () => {
    const screen = await renderRow(projectFailure(teamIssueMeta), 'owner');
    expect(screen.findByTestId(RECOVERY)).toBeNull();
    expect(screen.getTextContent()).toContain(
      'teams.credentials.sessionDeniedTitle',
    );
  });

  it('leaves a non-Team runtime failure as the plain notice', async () => {
    const composer = mountComposer(true);
    try {
      const screen = await renderRow(
        projectFailure({
          source: 'runtime',
          runtimeIssueCode: 'acp_turn_failed',
          runtimeIssueSource: 'agent_session_error',
        }),
        'owner',
      );
      expect(
        screen.findByTestId('transcript-event-runtime-issue'),
      ).not.toBeNull();
      expect(screen.findByTestId(RECOVERY)).toBeNull();
      expect(composer.openActionChip).not.toHaveBeenCalled();
    } finally {
      await act(async () => composer.unregister());
    }
  });
});
