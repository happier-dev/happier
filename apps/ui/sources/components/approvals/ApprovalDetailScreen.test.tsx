import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvalArtifactBodyMatchesHeaderV1,
  TargetActionApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  buildApprovalRequestArtifactHeaderV1,
  buildTargetActionApprovalArtifactHeaderV1,
  computeWorkspaceSyncPolicyDigest,
  type ApprovalRequestV1,
  type ApprovalRequestV2,
  type HandoffTargetApprovalConsequenceV1,
  WorkspaceSyncConflictResolutionResultV1Schema,
} from '@happier-dev/protocol';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

const loadActivitySpinner = async () =>
  (await import('@/components/ui/feedback/ActivitySpinner')).ActivitySpinner;

/**
 * Everything the approval page shows as text. Row components are pass-through test hosts, so their
 * title, subtitle and detail props are the text the real `Item`/`ItemGroup` would render.
 */
function readRenderedText(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): string {
  const rowText = [
    ...screen.findAllByType('ItemGroup' as never),
    ...screen.findAllByType('Item' as never),
  ]
    .flatMap((node) => [
      node.props.title,
      node.props.subtitle,
      node.props.detail,
      node.props.description,
    ])
    .filter((value): value is string => typeof value === 'string');
  return [screen.getTextContent(), ...rowText].join(' ');
}

describe('approval field semantics shared by card and page', () => {
  it.each(['card', 'page'] as const)('preserves principal kinds, ids and arbitrary JSON in the %s', async (anatomy) => {
    const { describeApprovalActionFields } = await import('./approvalFieldValues');
    const { ActionApprovalFieldsCard } = await import('./ActionApprovalFieldsCard');
    for (const kind of ['account', 'team', 'group']) {
      const principal = { kind, ...(kind === 'group' ? { teamId: 'team-1' } : {}), [`${kind}Id`]: 'session-1' };
      const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} serverId="ui-A"
        presentation={describeApprovalActionFields({ actionId: 'machines.access.grant.set', actionArgs: {
          serverId: 'ui-A', machineId: 'machine', principal, level: 'view',
        } })} />);
      expect(readRenderedText(screen)).toContain(JSON.stringify(principal));
    }
    const value = { kind: 'session', sessionId: 'session-1', empty: '', absent: null };
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} serverId="ui-A"
      presentation={describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor: 'example', value } })} />);
    expect(readRenderedText(screen)).toContain(JSON.stringify(value));
  });
  it.each(['card', 'page'] as const)('names only the typed Voice target on its own Home in the %s', async (anatomy) => {
    const { describeApprovalActionFields } = await import('./approvalFieldValues');
    const { ActionApprovalFieldsCard } = await import('./ActionApprovalFieldsCard');
    const previous = sessionFixturesByServerId;
    sessionFixturesByServerId = { ...previous, 'other-home': { 'voice-session': createSessionFixture({
      id: 'voice-session', encryptionMode: 'plain', encryptedContentAvailability: 'ready',
      metadata: { name: 'Voice target elsewhere', path: '/repo', host: 'example.test' },
    }) } };
    try {
      const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} serverId="ui-A"
        presentation={describeApprovalActionFields({ actionId: 'ui.voice_global.start', actionArgs: {
          target: { kind: 'session', sessionAddress: { serverId: 'other-home', sessionId: 'voice-session' } }, expectedAttempt: null,
        } })} />);
      expect(readRenderedText(screen)).toContain('Voice target elsewhere');
      expect(readRenderedText(screen)).not.toContain('voice-session');
    } finally { sessionFixturesByServerId = previous; }
  });
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();
const executeSpy = vi.fn(async () => ({ ok: true as const, result: {} }));
const createDefaultActionExecutorSpy = vi.fn();
const replayApprovalRequestAtExactDaemonSpy = vi.fn(
  async (_args: unknown): Promise<unknown> => ({ ok: true, result: {} }),
);
const fetchArtifactWithBodySpy = vi.fn(async (): Promise<unknown> => null);
const updateArtifactWithHeaderSpy = vi.fn(
  async (_artifactId: string, _header: unknown, _body: string) => {},
);
const resolvePreferredServerIdForSessionIdSpy = vi.fn(
  (_: string): string | undefined => 'server-cache',
);
let portableProfileResolution: any = {
  kind: 'resolved',
  serverIdentityId: 'stable-home-a',
  profile: { id: 'ui-A', serverIdentityId: 'stable-home-a', name: '' },
};
const approvalScopeResolutionByServerId = new Map<
  string,
  Readonly<{
    kind: 'bound';
    scope: Readonly<{ serverId: string; accountId: string }>;
  }>
>();
const unknownApprovalScopeResolution = { kind: 'unknown_home' as const };
function getApprovalScopeResolution(serverId: string) {
  const existing = approvalScopeResolutionByServerId.get(serverId);
  if (existing) return existing;
  const resolution = {
    kind: 'bound' as const,
    scope: { serverId, accountId: 'account-1' },
  };
  approvalScopeResolutionByServerId.set(serverId, resolution);
  return resolution;
}
let modalConfirmResult = true;
const defaultApprovalArtifactBody = {
  v: 1 as const,
  status: 'open' as const,
  createdAtMs: 1,
  updatedAtMs: 1,
  createdBy: {
    surface: 'agent' as const,
    agentId: 'codex',
    sessionId: 'session-1',
  },
  actionId: 'session.user_action.answer',
  actionArgs: {
    sessionId: 'session-1',
    requestId: 'ask-1',
    answers: [{ question: 'Continue?', values: ['Yes'] }],
  },
  summary: 'Approve answering the user',
  preview: {
    kind: 'user_action',
    summary: 'Agent wants to answer the pending question',
  },
};

function createApprovalArtifact(serverId?: string) {
  return {
    id: 'artifact-1',
    header: {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Approve answering the user',
      approvalStatus: 'open',
      actionId: 'session.user_action.answer',
      sessionId: 'session-1',
      sessions: ['session-1'],
    },
    body: JSON.stringify({
      ...defaultApprovalArtifactBody,
      ...(serverId ? { serverId } : {}),
    }),
  };
}

function createBuiltInApprovalArtifact(
  input: Readonly<{
    actionId: ApprovalRequestV2['actionId'];
    actionArgs: ApprovalRequestV2['actionArgs'];
    summary: string;
    preview?: unknown;
    serverId?: string;
    executedResult?: unknown;
  }>,
) {
  const request: ApprovalRequestV2 = {
    v: 2,
    status: input.executedResult === undefined ? 'open' : 'executed',
    createdAtMs: 1,
    updatedAtMs: input.executedResult === undefined ? 1 : 3,
    createdBy: { surface: 'system', sessionId: 'session-1' },
    requestedSurface: 'ui',
    executionOriginV1: {
      v: 1,
      authority: 'present_user',
      surface: 'ui',
      caller: { kind: 'host' },
      serverId: input.serverId ?? 'server-cache',
      serverIdentityId: 'stable-home-a',
      sessionId: 'session-1',
      target: { kind: 'session', sessionId: 'session-1' },
      actionId: input.actionId,
      requestId: 'request-built-in-1',
    },
    actionId: input.actionId,
    actionArgs: input.actionArgs,
    summary: input.summary,
    ...(input.preview === undefined ? {} : { preview: input.preview }),
    ...(input.executedResult === undefined
      ? {}
      : {
          decision: { kind: 'approve' as const, decidedAtMs: 2 },
          execution: {
            executedAtMs: 3,
            ok: true as const,
            result: input.executedResult,
          },
        }),
  };
  return {
    id: 'artifact-1',
    header: buildApprovalRequestArtifactHeaderV1(request),
    body: JSON.stringify(request),
  };
}

function createCurrentApprovalArtifact(serverId = 'server-approval') {
  return createBuiltInApprovalArtifact({
    actionId: 'session.user_action.answer',
    actionArgs: defaultApprovalArtifactBody.actionArgs,
    summary: defaultApprovalArtifactBody.summary,
    preview: defaultApprovalArtifactBody.preview,
    serverId,
  });
}

function createDaemonRoutedApprovalArtifact() {
  const request = {
    v: 2,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'system', sessionId: 'session-1' },
    requestedSurface: 'api',
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'api',
      caller: { kind: 'host' },
      serverId: 'local-A',
      serverIdentityId: 'stable-home-a',
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      sessionId: 'session-1',
      machineId: 'machine-exact',
      target: { kind: 'session', sessionId: 'session-1' },
      actionId: 'session.title.set',
      requestId: 'request-1',
    },
    actionId: 'session.title.set',
    actionArgs: { sessionId: 'session-1', title: 'Current title' },
    summary: 'Set session title',
  } satisfies ApprovalRequestV2;
  return {
    id: 'daemon-approval-1',
    header: buildApprovalRequestArtifactHeaderV1(request),
    body: JSON.stringify(request),
  };
}

function createTargetActionApprovalArtifact() {
  return {
    id: 'target-artifact-1',
    header: {
      v: 1,
      kind: 'target_action_approval.v1',
      title: 'Publish the release notes',
      approvalStatus: 'open',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
      subjectFingerprint: 'b'.repeat(64),
      sessionId: 'session-1',
      sessions: ['session-1'],
    },
    body: JSON.stringify({
      v: 1,
      kind: 'plugin_target_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', agentId: 'codex', sessionId: 'session-1' },
      requestedSurface: 'agent',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
      input: { secretToken: 'must-not-render', body: 'private draft' },
      accountId: 'account-secret',
      resourceId: 'resource-secret',
      sourceCustody: {
        kind: 'bundled_first_party',
        packagedRuntime: {
          kind: 'cli_version_root',
          versionRootId: 'cli-root-7',
        },
      },
      policyFingerprint: 'a'.repeat(64),
      subjectFingerprint: 'b'.repeat(64),
      summary: 'Publish the release notes',
      detail:
        'This publishes the approved release notes to the configured remote.',
    }),
  };
}

function createApiTargetActionApprovalArtifact() {
  const targetApproval = createTargetActionApprovalArtifact();
  return {
    ...targetApproval,
    id: 'target-api-artifact-1',
    body: JSON.stringify({
      ...JSON.parse(targetApproval.body),
      createdBy: { surface: 'system' },
      requestedSurface: 'api',
      replayPlacement: {
        serverId: 'server-exact',
        machineId: 'machine-exact',
        defaultSessionId: 'session-1',
      },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        serverId: 'server-exact',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        sessionId: 'session-1',
        machineId: 'machine-exact',
        target: { kind: 'session', sessionId: 'session-1' },
        actionId: 'action.invoke',
        requestId: 'request-1',
      },
    }),
    header: {
      ...targetApproval.header,
      serverId: 'server-exact',
      machineId: 'machine-exact',
    },
  };
}

function createExecutionRunHostActionApprovalArtifact() {
  return {
    id: 'host-action-artifact-1',
    header: {
      v: 1,
      kind: 'execution_run_host_action_approval.v1',
      title: 'Create 1 proposed review comment',
      approvalStatus: 'open',
      actionId: 'reviews.comments.create',
      sessionId: 'session-1',
      sessions: ['session-1'],
      runId: 'run-1',
      profileId: 'acme.review/review',
      subjectFingerprint: 'c'.repeat(64),
      serverId: 'server-1',
    },
    body: JSON.stringify({
      v: 1,
      kind: 'execution_run_host_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' },
      requestedSurface: 'agent',
      actionId: 'reviews.comments.create',
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      profileId: 'acme.review/review',
      pluginId: 'acme.review',
      agentId: 'claude',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      serverId: 'server-1',
      proposalCount: 1,
      proposalPreview: [
        {
          pathLabel: 'src/a.ts',
          pathSha256: 'a'.repeat(64),
          startLine: 7,
          endLine: 7,
          bodySha256: 'b'.repeat(64),
          bodyPreview: 'Use the canonical owner.',
        },
      ],
      subjectFingerprint: 'c'.repeat(64),
      summary: 'Create 1 proposed review comment',
    }),
  };
}

function createSessionTitleApprovalArtifact(serverId?: string) {
  return {
    id: 'artifact-1',
    header: {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Set session title',
      approvalStatus: 'open',
      actionId: 'session.title.set',
      sessionId: 'session-1',
      sessions: ['session-1'],
    },
    body: JSON.stringify({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: {
        surface: 'mcp',
        sessionId: 'session-1',
      },
      requestedSurface: 'mcp',
      actionId: 'session.title.set',
      actionArgs: {
        sessionId: 'session-1',
        title: 'New title from MCP',
      },
      summary: 'Set session title',
      preview: {
        kind: 'session_title_set',
        summary: 'Set a new title for the session',
      },
      ...(serverId ? { serverId } : {}),
    }),
  };
}

function createHandoffApprovalArtifact(
  input: Readonly<{
    mode: 'keep_synced' | 'mirror_exactly' | 'copy_once';
    consequences: readonly HandoffTargetApprovalConsequenceV1[];
  }>,
) {
  const contentPolicyFields = {
    v: 1 as const,
    selection: 'all_files' as const,
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
  };
  const contentPolicy = {
    ...contentPolicyFields,
    policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyFields),
  };
  const request = {
    ...defaultApprovalArtifactBody,
    actionId: 'session.handoff',
    actionArgs: {
      sessionId: 'session-1',
      targetMachineId: 'machine-2',
      targetPath: '/workspace/target',
      workspaceAction:
        input.mode === 'copy_once'
          ? { kind: 'copy_once', contentPolicy }
          : {
              kind: 'create_relationship',
              mode: input.mode,
              contentPolicy,
              flushBeforeCommit: true,
            },
    },
    summary: 'Move session and mirror workspace',
    handoffTargetReplacementApproval: {
      v: 1,
      consequences: [...input.consequences],
      serverId: 'server-cache',
      machineId: 'machine-2',
      canonicalRoot: '/workspace/target',
      rootFingerprint: 'a'.repeat(64),
      operationId: 'handoff-action-1',
    },
  } satisfies ApprovalRequestV1;
  return {
    id: 'artifact-1',
    header: buildApprovalRequestArtifactHeaderV1(request),
    body: JSON.stringify(request),
  };
}

function createSessionFixtures() {
  return {
    'session-1': createSessionFixture({
      id: 'session-1',
      metadata: {
        name: 'Repo session',
        host: 'tester.local',
        path: '/Users/leeroy/repo',
        homeDir: '/Users/leeroy',
        machineId: 'machine-target',
      },
    }),
  } satisfies Record<string, Session>;
}

function createMachineFixtures() {
  return {
    'machine-target': createMachineFixture({
      id: 'machine-target',
      metadata: {
        displayName: 'Rebound workstation',
        host: 'workstation.local',
        platform: 'darwin',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/Users/tester/.happy-dev',
        homeDir: '/Users/tester',
      },
    }),
    'machine-2': createMachineFixture({
      id: 'machine-2',
      metadata: {
        displayName: 'Studio laptop',
        host: 'studio.local',
        platform: 'darwin',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/Users/tester/.happy-dev',
        homeDir: '/Users/tester',
      },
    }),
  } satisfies Record<string, Machine>;
}

function createStorageState() {
  return {
    sessions: {
      'session-1': createSessionFixture({
        id: 'session-1',
        active: false,
        metadata: {
          host: 'tester.local',
          machineId: 'machine-target',
          path: '/Users/leeroy/repo',
          homeDir: '/Users/leeroy',
        } as Session['metadata'],
      }),
    },
    machines: {
      'machine-target': createMachineFixture({
        id: 'machine-target',
        active: true,
        activeAt: 10,
        metadata: {
          displayName: 'Rebound workstation',
          host: 'workstation.local',
          platform: 'darwin',
          happyCliVersion: '0.0.0-test',
          happyHomeDir: '/Users/tester/.happy-dev',
          homeDir: '/Users/tester',
        },
      }),
    },
    getProjectForSession: (sessionId: string) =>
      sessionId === 'session-1'
        ? {
            key: {
              machineId: 'machine-target',
              path: '/Users/leeroy/repo',
            },
          }
        : null,
    updateArtifact: vi.fn(),
  };
}

let currentArtifact: any = createApprovalArtifact();
let sessionFixtures: Record<string, Session> = createSessionFixtures();
let machineFixtures: Record<string, Machine> = createMachineFixtures();
let sessionFixturesByServerId: Record<string, Record<string, Session>> = {
  'server-cache': sessionFixtures,
};
let machineFixturesByServerId: Record<string, Record<string, Machine>> = {
  'server-cache': machineFixtures,
};
let storageState = createStorageState();
installApprovalCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      ScrollView: 'ScrollView',
      ActivityIndicator: 'ActivityIndicator',
      Pressable: ({ children, ...props }: any) =>
        React.createElement('Pressable', props, children),
    });
  },
  unistyles: async () => {
    const { createUnistylesMock } =
      await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: {
        colors: {
          groupped: { background: '#111' },
          text: '#fff',
          textSecondary: '#999',
          divider: '#333',
          surface: '#171717',
          surfaceHigh: '#1d1d1d',
          surfaceHighest: '#222',
          button: { primary: { background: '#444', tint: '#fff' } },
          deleteAction: '#b00',
          status: { error: '#f00' },
        },
      },
    });
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: { back: backSpy, push: pushSpy },
    }).module;
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        confirm: vi.fn(async () => modalConfirmResult),
        alert: vi.fn(),
      },
    }).module;
  },
  storage: async () => {
    const { createStorageModuleStub, createUseSettingMock } =
      await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      useSetting: createUseSettingMock(),
      useWorkspaceRefs: () => [],
      useWorkspaceSyncRelationships: () => [],
      useMachineDisplayNamesById: () => ({}),
      useArtifact: () => currentArtifact,
      useSession: (sessionId: string) => sessionFixtures[sessionId] ?? null,
      useMachine: (machineId: string) => machineFixtures[machineId] ?? null,
      useSessionListRenderableWithServerScope: (
        serverId: string | null | undefined,
        sessionId: string,
      ) =>
        serverId
          ? (sessionFixturesByServerId[serverId]?.[sessionId] ?? null)
          : (sessionFixtures[sessionId] ?? null),
      useServerScopedMachine: (
        serverId: string | null | undefined,
        machineId: string,
      ) =>
        serverId
          ? (machineFixturesByServerId[serverId]?.[machineId] ?? null)
          : null,
      storage: {
        getState: () => storageState,
      },
    });
  },
});

vi.mock('@/components/ui/text/Text', async () => {
  const { createPassThroughModule } =
    await import('@/dev/testkit/mocks/components');
  return createPassThroughModule(['Text']);
});

vi.mock('@/components/ui/lists/ItemGroup', async () => {
  const { createPassThroughModule } =
    await import('@/dev/testkit/mocks/components');
  return createPassThroughModule(['ItemGroup']);
});

vi.mock('@/components/ui/lists/Item', async () => {
  const { createPassThroughModule } =
    await import('@/dev/testkit/mocks/components');
  return createPassThroughModule(['Item']);
});

vi.mock('@/components/ui/buttons/RoundButton', async (importOriginal) => {
  const { createPassThroughModule } =
    await import('@/dev/testkit/mocks/components');
  return {
    ...(await importOriginal<
      typeof import('@/components/ui/buttons/RoundButton')
    >()),
    ...createPassThroughModule(['RoundButton']),
  };
});

vi.mock('@/sync/sync', () => ({
  sync: {
    getCredentials: () => ({ token: 'test' }),
    fetchArtifactWithBody: fetchArtifactWithBodySpy,
    updateArtifactWithHeader: updateArtifactWithHeaderSpy,
  },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: (opts?: unknown) => {
    createDefaultActionExecutorSpy(opts);
    return { execute: executeSpy };
  },
  replayApprovalRequestAtExactDaemon: (args: unknown) =>
    replayApprovalRequestAtExactDaemonSpy(args),
  requiresExactDaemonApprovalReplay: (
    approval: ApprovalRequestV2 | ApprovalRequestV1,
  ) => approval.v === 2 && approval.executionOriginV1.surface !== 'ui',
  resolveApprovalReplayRoute: (
    approval: ApprovalRequestV2 | ApprovalRequestV1 | null,
  ) =>
    approval?.v === 2 &&
    portableProfileResolution.kind === 'resolved' &&
    portableProfileResolution.profile.serverIdentityId ===
      approval.executionOriginV1.serverIdentityId
      ? {
          serverId: portableProfileResolution.profile.id,
          serverIdentityId: approval.executionOriginV1.serverIdentityId,
          originServerId: approval.executionOriginV1.serverId,
        }
      : null,
}));

vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId',
  () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) =>
      resolvePreferredServerIdForSessionIdSpy(sessionId),
  }),
);

vi.mock(
  '@/sync/domains/scope/useServerCredentialAccountScopes',
  async (importOriginal) => ({
    // The migrated picker authority uses the actual credential binding. Keep only
    // this legacy artifact-reader fixture; never fabricate a Computer lifetime.
    ...(await importOriginal<
      typeof import('@/sync/domains/scope/useServerCredentialAccountScopes')
    >()),
    useServerCredentialAccountScopeResolution: (
      serverId: string | null | undefined,
    ) =>
      serverId
        ? getApprovalScopeResolution(serverId)
        : unknownApprovalScopeResolution,
    useServerCredentialAccountScopeBindings: () => new Map(),
  }),
);

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/store/hooks')>()),
  useActiveServerAccountScope: () => ({
    serverId: 'ui-A',
    accountId: 'account-1',
  }),
  useSessionListHomeObservations: () => ({}),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/sync/domains/server/serverProfiles')
  >()),
  loadHomeViewState: () => null,
  subscribeActiveServer: () => () => {},
  getActiveServerSnapshot: () => ({
    serverId: 'server-approval',
    source: 'device',
  }),
  resolveServerProfileForPortableIdentity: () => portableProfileResolution,
  listServerProfiles: () => [portableProfileResolution.profile].filter(Boolean),
  getServerProfileById: (serverId: string) =>
    portableProfileResolution.profile?.id === serverId
      ? portableProfileResolution.profile
      : null,
  getServerProfilesGeneration: () => 0,
  subscribeServerProfiles: () => () => {},
}));

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 960 },
  useLayoutMaxWidth: () => 960,
  useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
}));

describe('ApprovalDetailScreen', () => {
  beforeEach(() => {
    backSpy.mockReset();
    pushSpy.mockReset();
    executeSpy.mockClear();
    createDefaultActionExecutorSpy.mockReset();
    replayApprovalRequestAtExactDaemonSpy.mockClear();
    fetchArtifactWithBodySpy.mockClear();
    updateArtifactWithHeaderSpy.mockClear();
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server-cache');
    portableProfileResolution = {
      kind: 'resolved',
      serverIdentityId: 'stable-home-a',
      profile: { id: 'ui-A', serverIdentityId: 'stable-home-a', name: '' },
    };
    modalConfirmResult = true;
    sessionFixtures = createSessionFixtures();
    machineFixtures = createMachineFixtures();
    sessionFixturesByServerId = { 'server-cache': sessionFixtures };
    machineFixturesByServerId = { 'server-cache': machineFixtures };
    storageState = createStorageState();
    currentArtifact = createApprovalArtifact();
  });

  it('renders an executing approval truthfully without decision controls', async () => {
    const artifact = createDaemonRoutedApprovalArtifact();
    const request = ApprovalRequestV2Schema.parse({
      ...JSON.parse(artifact.body),
      status: 'executing',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    currentArtifact = {
      ...artifact,
      header: buildApprovalRequestArtifactHeaderV1(request),
      body: JSON.stringify(request),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId={currentArtifact.id} />,
    );

    expect(readRenderedText(screen)).toContain('approvals.status.executing');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
  });

  it('renders an executing target Action approval without decision controls', async () => {
    const artifact = createTargetActionApprovalArtifact();
    const request = TargetActionApprovalRequestV1Schema.parse({
      ...JSON.parse(artifact.body),
      status: 'executing',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    currentArtifact = {
      ...artifact,
      header: buildTargetActionApprovalArtifactHeaderV1(request),
      body: JSON.stringify(request),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId={currentArtifact.id} />,
    );

    expect(readRenderedText(screen)).toContain('approvals.status.executing');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
  });

  it('renders a redacted plugin target action and updates only that artifact', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('Publish the release notes');
    expect(text).toContain(
      'This publishes the approved release notes to the configured remote.',
    );
    expect(text).toContain('acme.publisher');
    expect(text).toContain('releases/publish');
    expect(text).toContain('bundled_first_party');
    expect(text).not.toContain('must-not-render');
    expect(text).not.toContain('account-secret');
    expect(text).not.toContain('resource-secret');
    expect(text).not.toContain('a'.repeat(64));

    await screen.pressByTestIdAsync('approvals.approve');
    expect(executeSpy).not.toHaveBeenCalled();
    expect(updateArtifactWithHeaderSpy).toHaveBeenCalledTimes(1);
    const [artifactId, header, body] =
      updateArtifactWithHeaderSpy.mock.calls[0]!;
    expect(artifactId).toBe('target-artifact-1');
    expect(header).toMatchObject({
      kind: 'target_action_approval.v1',
      approvalStatus: 'approved',
    });
    expect(JSON.parse(body)).toMatchObject({
      kind: 'plugin_target_action',
      status: 'approved',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
      subjectFingerprint: 'b'.repeat(64),
      decision: { kind: 'approve' },
    });
  });

  it('routes an API target-action approval to its stamped daemon instead of mutating the Artifact locally', async () => {
    currentArtifact = createApiTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-api-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(
      replayApprovalRequestAtExactDaemonSpy,
    ).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'target-api-artifact-1',
      decision: 'approve',
      executionTarget: {
        serverId: 'server-exact',
        machineId: 'machine-exact',
        defaultSessionId: 'session-1',
      },
    });
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('routes an API target-action rejection to its stamped daemon without executing client-side', async () => {
    currentArtifact = createApiTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-api-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.reject');

    expect(
      replayApprovalRequestAtExactDaemonSpy,
    ).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'target-api-artifact-1',
      decision: 'reject',
      executionTarget: {
        serverId: 'server-exact',
        machineId: 'machine-exact',
        defaultSessionId: 'session-1',
      },
    });
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('refreshes the target approval after exact-daemon replay so the decision UI reflects the durable result', async () => {
    currentArtifact = createApiTargetActionApprovalArtifact();
    const refreshedRequest = TargetActionApprovalRequestV1Schema.parse({
      ...JSON.parse(currentArtifact.body),
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    fetchArtifactWithBodySpy.mockResolvedValueOnce({
      ...currentArtifact,
      header: buildTargetActionApprovalArtifactHeaderV1(refreshedRequest),
      body: JSON.stringify(refreshedRequest),
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-api-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(
      replayApprovalRequestAtExactDaemonSpy,
    ).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'target-api-artifact-1',
      decision: 'approve',
      executionTarget: {
        serverId: 'server-exact',
        machineId: 'machine-exact',
        defaultSessionId: 'session-1',
      },
    });
    expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith(
      'target-api-artifact-1',
    );
    expect(readRenderedText(screen)).toContain('approvals.status.approved');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
  });

  it('routes a current durable Action approval through this device profile while preserving its immutable origin', async () => {
    currentArtifact = createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(executeSpy).toHaveBeenCalledExactlyOnceWith(
      'approval.request.decide',
      { artifactId: 'daemon-approval-1', decision: 'approve' },
      { surface: 'ui', serverId: 'ui-A' },
    );
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
  });

  it('shows the original execution surface and exact Home without exposing principal credentials', async () => {
    currentArtifact = createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    expect(readRenderedText(screen)).toContain('api');
    expect(readRenderedText(screen)).toContain(
      'actionConfirmations.homeTarget',
    );
    expect(readRenderedText(screen)).not.toContain('principal-1');
    expect(readRenderedText(screen)).not.toContain('credential-1');
  });

  it('names the asking Home and the Action as a person knows them, not by raw ids', async () => {
    portableProfileResolution = {
      kind: 'resolved',
      serverIdentityId: 'stable-home-a',
      profile: {
        id: 'ui-A',
        serverIdentityId: 'stable-home-a',
        name: 'Studio Mac',
      },
    };
    currentArtifact = createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    const requestedBy = screen.findAll(
      (node: any) => node.props?.homeName !== undefined,
    )[0];
    expect(requestedBy?.props.homeName).toBe('Studio Mac');
    // The built-in Action reads by its title; its raw id is not copy.
    expect(
      String(screen.findByTestId('approvals.action')?.props.subtitle ?? ''),
    ).not.toContain('session.title.set');
  });

  it('titles an older request without its raw session id and names the sessions its details point at', async () => {
    sessionFixturesByServerId = {
      ...sessionFixturesByServerId,
      'ui-A': {
        'session-1': createSessionFixture({
          id: 'session-1',
          metadata: {
            name: 'Child A',
            path: '/Users/leeroy/repo',
            host: 'tester.local',
          },
        }),
        'session-lead': createSessionFixture({
          id: 'session-lead',
          metadata: {
            name: 'Lead session',
            path: '/Users/leeroy/repo',
            host: 'tester.local',
          },
        }),
      },
    };
    currentArtifact = createBuiltInApprovalArtifact({
      actionId: 'session.reports_to.set',
      actionArgs: {
        sessionId: 'session-1',
        leadSessionId: 'session-lead',
        expectedLeadSessionId: null,
      },
      summary: 'Set Session lead — session-1',
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    // One title rule with the Inbox row: no raw id, and the Action row does not repeat it.
    const details = readRenderedText(screen);
    expect(details).toContain('Set Session lead');
    expect(details).not.toContain('— session-1');
    expect(screen.findByTestId('approvals.action')).toBeNull();
    expect(details).not.toContain('session-lead');
    expect(details).toContain('Lead session');
    expect(details).toContain('Child A');
    expect(details).not.toContain('null to detach');
  });

  it('says who asked in words: a session this device does not have reads by where it lives, the origin is never a raw enum, and the Home is never its address', async () => {
    portableProfileResolution = {
      kind: 'resolved',
      serverIdentityId: 'stable-home-a',
      profile: {
        id: 'ui-A',
        serverIdentityId: 'stable-home-a',
        name: 'happier-agent-qa-orc.localhost:3021',
        serverUrl: 'http://happier-agent-qa-orc.localhost:3021',
      },
    };
    // No session fixture for ui-A: the asking session is not on this device.
    sessionFixturesByServerId = { ...sessionFixturesByServerId, 'ui-A': {} };
    currentArtifact = createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    const text = readRenderedText(screen);
    // The Home has no name of its own, so the session is "not on this device" rather than "on <address>".
    expect(text).toContain('detailPages.approval.sessionElsewhere');
    expect(text).not.toContain('localhost:3021');
    expect(text).toContain('detailPages.approval.origin.api');
    expect(
      String(screen.findByTestId('approvals.requester-origin')?.props.children),
    ).not.toBe('api');
    // The Details row names the unknown session the same way, never by its id.
    expect(text).not.toContain('session-1');
  });

  it('fails closed when the current route profile does not match the persisted stable Home identity', async () => {
    currentArtifact = createDaemonRoutedApprovalArtifact();
    portableProfileResolution = {
      kind: 'resolved',
      serverIdentityId: 'stable-home-a',
      profile: { id: 'ui-wrong', serverIdentityId: 'stable-home-b', name: '' },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    expect(replayApprovalRequestAtExactDaemonSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.home-unavailable')).not.toBeNull();
  });

  it('explains how to recover when the deep-linked Home is unavailable before the Artifact can load', async () => {
    currentArtifact = createDaemonRoutedApprovalArtifact();
    portableProfileResolution = {
      kind: 'missing',
      serverIdentityId: 'stable-home-a',
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen
        artifactId="daemon-approval-1"
        serverId="stable-home-a"
      />,
    );

    expect(readRenderedText(screen)).toContain(
      'actionConfirmations.homeUnavailable',
    );
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(screen.findByTestId('approvals.reject')).toBeNull();
  });

  it('refreshes the durable result without local fallback when exact-daemon replay records approval_stale', async () => {
    currentArtifact = createDaemonRoutedApprovalArtifact();
    executeSpy.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_stale' },
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
    expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('daemon-approval-1');
  });

  it('does not fall back to the UI executor when the exact approval daemon is unavailable', async () => {
    currentArtifact = createDaemonRoutedApprovalArtifact();
    executeSpy.mockRejectedValueOnce(
      Object.assign(new Error('Machine RPC target unavailable'), {
        code: 'MACHINE_RPC_TARGET_UNAVAILABLE',
      }),
    );
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
  });

  it('renders and updates only the execution-run host-action approval artifact', async () => {
    currentArtifact = createExecutionRunHostActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="host-action-artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('Create 1 proposed review comment');
    expect(text).toContain('acme.review');
    expect(text).toContain('reviews.comments.create');
    expect(text).toContain('approvals.proposedComments');
    expect(text).toContain('Use the canonical owner.');
    expect(text).not.toContain('project-1');
    expect(text).not.toContain('c'.repeat(64));

    await screen.pressByTestIdAsync('approvals.approve');
    expect(executeSpy).not.toHaveBeenCalled();
    expect(updateArtifactWithHeaderSpy).toHaveBeenCalledTimes(1);
    const [artifactId, header, body] =
      updateArtifactWithHeaderSpy.mock.calls[0]!;
    expect(artifactId).toBe('host-action-artifact-1');
    expect(header).toMatchObject({
      kind: 'execution_run_host_action_approval.v1',
      approvalStatus: 'approved',
      actionId: 'reviews.comments.create',
      runId: 'run-1',
    });
    expect(JSON.parse(body)).toMatchObject({
      kind: 'execution_run_host_action',
      status: 'approved',
      decision: { kind: 'approve' },
      subjectFingerprint: 'c'.repeat(64),
    });
  });

  it('shows the authoritative execution failure reason for a terminal target action approval', async () => {
    const targetApproval = createTargetActionApprovalArtifact();
    currentArtifact = {
      ...targetApproval,
      header: {
        ...targetApproval.header,
        approvalStatus: 'failed',
      },
      body: JSON.stringify({
        ...JSON.parse(targetApproval.body),
        status: 'failed',
        updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: {
          executedAtMs: 3,
          ok: false,
          errorCode: 'machine_offline',
          error: 'The selected machine is offline.',
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    expect(readRenderedText(screen)).toContain(
      'The selected machine is offline.',
    );
    expect(screen.findByTestId('approvals.execution-failure')).not.toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(screen.findByTestId('approvals.reject')).toBeNull();
  });

  it('fails closed when a target header is paired with a built-in body', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      id: 'target-artifact-1',
      header: createTargetActionApprovalArtifact().header,
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    expect(readRenderedText(screen)).toContain('approvals.loadError');
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(executeSpy).not.toHaveBeenCalled();
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
  });

  it('reloads the authoritative artifact after a decision version conflict', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const authoritative = {
      ...createTargetActionApprovalArtifact(),
      header: {
        ...createTargetActionApprovalArtifact().header,
        approvalStatus: 'approved',
      },
      body: JSON.stringify({
        ...JSON.parse(createTargetActionApprovalArtifact().body),
        status: 'approved',
        updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    };
    updateArtifactWithHeaderSpy.mockRejectedValueOnce(
      new Error(
        'Artifact was modified by another client. Please refresh and try again.',
      ),
    );
    fetchArtifactWithBodySpy.mockResolvedValueOnce(authoritative);
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('target-artifact-1');
    expect(storageState.updateArtifact).toHaveBeenCalledWith(authoritative);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('writes exact reject and cancel transitions without executing client-side', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const rejectScreen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );
    await rejectScreen.pressByTestIdAsync('approvals.reject');
    expect(
      JSON.parse(updateArtifactWithHeaderSpy.mock.calls[0]![2]),
    ).toMatchObject({
      status: 'rejected',
      decision: { kind: 'reject' },
    });

    updateArtifactWithHeaderSpy.mockClear();
    const cancelScreen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );
    await cancelScreen.pressByTestIdAsync('approvals.cancel');
    const canceled = JSON.parse(updateArtifactWithHeaderSpy.mock.calls[0]![2]);
    expect(canceled).toMatchObject({ status: 'canceled' });
    expect(canceled).not.toHaveProperty('decision');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('guards same-frame duplicate decisions and removes controls for terminal artifacts', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    let release!: () => void;
    updateArtifactWithHeaderSpy.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );
    const approve = screen.findByTestId('approvals.approve');
    expect(approve).not.toBeNull();
    await act(async () => {
      approve!.props.onPress();
      approve!.props.onPress();
      await Promise.resolve();
    });
    expect(updateArtifactWithHeaderSpy).toHaveBeenCalledTimes(1);
    await act(async () => release());

    currentArtifact = {
      ...createTargetActionApprovalArtifact(),
      header: {
        ...createTargetActionApprovalArtifact().header,
        approvalStatus: 'approved',
      },
      body: JSON.stringify({
        ...JSON.parse(createTargetActionApprovalArtifact().body),
        status: 'approved',
        updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    };
    const terminal = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );
    expect(terminal.findByTestId('approvals.approve')).toBeNull();
    expect(terminal.findByTestId('approvals.reject')).toBeNull();
    expect(terminal.findByTestId('approvals.cancel')).toBeNull();
  });

  it('provides explicit accessible labels for all target decision controls', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    expect(
      screen.findByTestId('approvals.approve')?.props.accessibilityLabel,
    ).toBe('approvals.approve');
    expect(
      screen.findByTestId('approvals.reject')?.props.accessibilityLabel,
    ).toBe('approvals.reject');
    expect(
      screen.findByTestId('approvals.cancel')?.props.accessibilityLabel,
    ).toBe('approvals.dismiss');
  });

  it('shows both target replacement and exact-mirror deletion in one handoff approval that names both endpoints', async () => {
    currentArtifact = createHandoffApprovalArtifact({
      mode: 'mirror_exactly',
      consequences: [
        'replace_nonempty_workspace_target',
        'delete_target_only_files_during_exact_mirror',
      ],
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    expect(
      screen.findByTestId('approvals.handoff-target-consequences'),
    ).not.toBeNull();
    const text = readRenderedText(screen);
    expect(text).toContain('sessionHandoff.targetApproval.replaceTarget');
    expect(text).toContain('sessionHandoff.targetApproval.exactMirror');
    // The confirmation must name where the workspace comes from and where it lands.
    expect(text).toContain('sessionHandoff.targetApproval.sourceLabel');
    expect(text).toContain('sessionHandoff.targetApproval.destinationLabel');
    expect(text).toContain('Rebound workstation');
    expect(text).toContain('~/repo');
    expect(text).toContain('Studio laptop');
    expect(text).toContain('/workspace/target');
    // The chosen sync mode is read from the persisted action arguments.
    expect(text).toContain('sessionHandoff.targetApproval.modeLabel');
    expect(text).toContain('workspaceSync.mode.mirrorExactly');
    // The exact-mirror consequence replaces the generic decision label.
    const approve = screen.findByTestId('approvals.approve');
    expect(approve?.props.title).toBe(
      'sessionHandoff.targetApproval.decision.mirrorAndAllowRemovals',
    );
    expect(approve?.props.accessibilityLabel).toBe(
      'sessionHandoff.targetApproval.decision.mirrorAndAllowRemovals',
    );
    expect(
      screen.findAllByTestId('approvals.handoff-target-consequences'),
    ).toHaveLength(1);
  });

  it('says what a computer input sends, and where, from the computer owner’s display facts', async () => {
    currentArtifact = createBuiltInApprovalArtifact({
      actionId: 'computer.input',
      actionArgs: {
        machineId: 'machine-2',
        captureId: 'capture_1',
        operation: { kind: 'type', text: 'ana@lumen.dev' },
      },
      summary: 'Type the QA user email',
      // Host-resolved by the computer owner (W7); the agent's arguments carry no target.
      preview: {
        computerApprovalDisplay: {
          machineDisplayName: 'Workstation one',
          requiresTargetSelection: false,
          target: { kind: 'window', title: 'Sign in to Lumen' },
        },
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    expect(screen.findByTestId('approvals.computer-action')).not.toBeNull();
    const text = readRenderedText(screen);
    expect(text).toContain('computerUse.approval.act.type');
    expect(text).toContain('ana@lumen.dev');
    // This suite's `t` drops params, so read what the page handed the card.
    const card = screen.tree.root.findAll(
      (node) => node.props?.presentation?.machineName === 'Workstation one',
    );
    expect(card.length).toBeGreaterThan(0);
    expect(card[0]!.props.presentation.target).toEqual({
      kind: 'window',
      title: 'Sign in to Lumen',
    });
  });

  it('names both endpoints and uses a consequence-specific decision for an ordinary non-empty replacement', async () => {
    currentArtifact = createHandoffApprovalArtifact({
      mode: 'keep_synced',
      consequences: ['replace_nonempty_workspace_target'],
    });
    delete machineFixtures['machine-target'];
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('sessionHandoff.targetApproval.replaceTarget');
    expect(text).not.toContain('sessionHandoff.targetApproval.exactMirror');
    expect(text).toContain('machine-target');
    expect(text).toContain('~/repo');
    expect(text).toContain('Studio laptop');
    expect(text).toContain('/workspace/target');
    expect(text).toContain('workspaceSync.mode.keepSynced');
    expect(screen.findByTestId('approvals.approve')?.props.title).toBe(
      'sessionHandoff.targetApproval.decision.replaceDestination',
    );
  });

  it('names the copy-once mode from the persisted action arguments without implying mirror deletions', async () => {
    currentArtifact = createHandoffApprovalArtifact({
      mode: 'copy_once',
      consequences: ['replace_nonempty_workspace_target'],
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('sessionHandoff.targetApproval.modeLabel');
    expect(text).toContain('workspaceSync.mode.copyOnce');
    expect(text).not.toContain('workspaceSync.mode.mirrorExactly');
    expect(text).toContain('sessionHandoff.targetApproval.replaceTarget');
    expect(text).not.toContain('sessionHandoff.targetApproval.exactMirror');
    expect(screen.findByTestId('approvals.approve')?.props.title).toBe(
      'sessionHandoff.targetApproval.decision.replaceDestination',
    );
    // A consequence-bearing label is never truncated: it wraps to whatever the
    // narrow width, large text size or translation needs.
    expect(
      screen.findByTestId('approvals.approve')?.props.titleNumberOfLines,
    ).toBe('complete');
    expect(
      screen.findByTestId('approvals.reject')?.props.titleNumberOfLines,
    ).toBe('complete');
  });

  it('renders requester, session context, and structured action details', async () => {
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('Approve answering the user');
    expect(text).toContain('Respond to user-action request');
    expect(text).toContain('Repo session');
    expect(text).toContain('Rebound workstation');
    expect(text).toContain('~/repo');
    expect(text).toContain('codex');
    expect(text).toContain('Agent wants to answer the pending question');
    expect(text).toContain('Continue?');
    expect(text).toContain('Yes');
  });

  it('shows the exact reviewed source and destination in a conflict approval without a second Use Version action', async () => {
    currentArtifact = createBuiltInApprovalArtifact({
      actionId: 'workspace.sync.conflict.resolve',
      summary: 'Resolve src/tool',
      actionArgs: {
        strategy: 'use_source',
        controllerMachineId: 'machine-a',
        hubWorkspaceRefId: 'workspace-a',
        path: 'src/tool',
        source: {
          workspaceRefId: 'workspace-c',
          expected: {
            kind: 'file',
            digest: 'a'.repeat(40),
            executable: true,
            size: 12,
          },
        },
        targets: [
          {
            workspaceRefId: 'workspace-b',
            expected: {
              kind: 'file',
              digest: 'b'.repeat(40),
              executable: false,
              size: 12,
            },
          },
        ],
        relationshipIds: ['a-b', 'a-c'],
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    expect(
      screen.findByTestId('workspace-sync-approved-review'),
    ).not.toBeNull();
    expect(readRenderedText(screen)).toContain('workspace-c');
    expect(readRenderedText(screen)).toContain('workspace-b');
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
    expect(
      screen.findAll(
        (node) => node.props?.title === 'workspaceSync.review.useNamedVersion',
      ),
    ).toHaveLength(0);
  });

  it('shows a completed conflict Action’s per-endpoint and preserved recovery outcomes in the approved comparison', async () => {
    currentArtifact = createBuiltInApprovalArtifact({
      actionId: 'workspace.sync.conflict.resolve',
      summary: 'Resolve src/tool',
      actionArgs: {
        strategy: 'keep_both',
        controllerMachineId: 'machine-a',
        hubWorkspaceRefId: 'workspace-a',
        path: 'src/tool',
        source: {
          workspaceRefId: 'workspace-a',
          expected: {
            kind: 'file',
            digest: 'a'.repeat(40),
            executable: false,
            size: 12,
          },
        },
        targets: [
          {
            workspaceRefId: 'workspace-b',
            expected: {
              kind: 'file',
              digest: 'b'.repeat(40),
              executable: false,
              size: 12,
            },
          },
        ],
        relationshipIds: ['a-b'],
        alternatives: [
          {
            source: {
              workspaceRefId: 'workspace-b',
              expected: {
                kind: 'file',
                digest: 'b'.repeat(40),
                executable: false,
                size: 12,
              },
            },
            destination: {
              workspaceRefId: 'workspace-a',
              path: 'src/tool.happier-conflict.b',
              expected: { kind: 'missing' },
            },
            consequence: { propagatingToWorkspaceRefIds: ['workspace-b'] },
          },
        ],
      },
      executedResult: {
        endpoints: [
          { workspaceRefId: 'workspace-a', status: 'applied_paused' },
          {
            workspaceRefId: 'workspace-b',
            status: 'recovery_needed',
            recoveryPath: '/work/recovery-b',
          },
        ],
        preserved: [
          {
            alternativeIndex: 0,
            sourceWorkspaceRefId: 'workspace-b',
            destinationWorkspaceRefId: 'workspace-a',
            path: 'src/tool.happier-conflict.b',
            propagatingToWorkspaceRefIds: [],
            unverifiedPropagationToWorkspaceRefIds: ['workspace-b'],
            outcome: { status: 'not_started' },
          },
        ],
      },
    });
    expect(
      WorkspaceSyncConflictResolutionResultV1Schema.safeParse(
        JSON.parse(currentArtifact.body).execution.result,
      ).success,
    ).toBe(true);
    const matched = approvalArtifactBodyMatchesHeaderV1(
      currentArtifact.header,
      currentArtifact.body,
    );
    expect(matched?.request.status).toBe('executed');
    expect(
      matched?.family === 'built_in' && matched.request.execution,
    ).toMatchObject({ ok: true, result: { endpoints: expect.any(Array) } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    expect(
      screen.find((node) => node.props?.reportedOutcome !== undefined).props
        .reportedOutcome.endpoints,
    ).toHaveLength(2);
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspace-a' &&
          node.props?.subtitle?.includes('workspaceSync.review.appliedPaused'),
      ),
    ).not.toBeNull();
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspaceSync.review.recoveryNeeded' &&
          node.props?.copy === '/work/recovery-b',
      ),
    ).not.toBeNull();
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspaceSync.review.preserveAt' &&
          node.props?.subtitle?.includes('workspaceSync.review.notStarted') &&
          node.props?.subtitle?.includes(
            'workspaceSync.review.propagationUnverified',
          ) &&
          node.props?.copy === 'src/tool.happier-conflict.b',
      ),
    ).not.toBeNull();
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspaceSync.review.inspectCurrentVersions',
      ),
    ).not.toBeNull();
    await screen.unmount();
  });

  it('shows the exact Team and member targets before approving deferred governance', async () => {
    currentArtifact = createBuiltInApprovalArtifact({
      actionId: 'teams.members.remove',
      actionArgs: {
        v: 1,
        teamId: 'team-acme',
        membershipId: 'membership-alice',
      },
      summary: 'Remove Team member',
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const text = readRenderedText(screen);

    expect(text).toContain('Team ID');
    expect(text).toContain('team-acme');
    expect(text).toContain('Membership ID');
    expect(text).toContain('membership-alice');
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(
      false,
    );
  });

  it('shows canonical invitation context and permits approval without revealing the bearer', async () => {
    const bearer = 'a'.repeat(43);
    currentArtifact = createBuiltInApprovalArtifact({
      actionId: 'teams.invitations.accept',
      actionArgs: { v: 1, token: bearer },
      summary: 'Accept Team invitation',
      preview: {
        actionId: 'teams.invitations.accept',
        actionArgs: {
          homeServerId: 'srv-home-acme',
          continuation: { teamId: 'team-acme' },
          teamName: 'Acme Platform',
          role: 'member',
          historyAccess: 'from_membership',
        },
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).not.toContain(bearer);
    expect(text).toContain('srv-home-acme');
    expect(text).toContain('team-acme');
    expect(text).toContain('Acme Platform');
    expect(text).toContain('member');
    expect(text).toContain('from_membership');
    expect(screen.findByTestId('approvals.unrepresentable-details')).toBeNull();
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(
      false,
    );
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
  });

  it('renders the released scalar structured-answer shape while withholding legacy approval', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-legacy',
          answers: [
            {
              question: '  Use the compatibility path?  ',
              answer: '  Yes, once  ',
            },
          ],
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const text = readRenderedText(screen);

    // The rendered-text testkit normalizes layout whitespace. Exact value
    // preservation is asserted at the structured-answer projection owner.
    expect(text).toContain('Use the compatibility path?');
    expect(text).toContain('Yes, once');
    expect(screen.findByTestId('approvals.unrepresentable-details')).toBeNull();
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
  });

  it('withholds approval and shows a bounded safety error when one structured answer is malformed', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-malformed',
          answers: [
            {
              question: '  Use the compatibility path?  ',
              answer: '  Yes, once  ',
            },
            { question: 'Malformed', values: [{ secret: 'must-not-render' }] },
          ],
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const text = readRenderedText(screen);

    expect(
      screen.findByTestId('approvals.unrepresentable-details'),
    ).not.toBeNull();
    expect(text).toContain('approvals.unsafeDetailsTitle');
    expect(text).not.toContain('must-not-render');
    // Partial content would imply the reader saw the whole question set.
    expect(text).not.toContain('Use the compatibility path?');

    const approve = screen.findByTestId('approvals.approve');
    expect(approve?.props.disabled).toBe(true);
    expect(approve?.props.accessibilityHint).toBe(
      'approvals.approveUnavailableHint',
    );
    // Rejecting an unshowable request stays available.
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);

    await screen.pressByTestIdAsync('approvals.approve');
    expect(executeSpy).not.toHaveBeenCalled();
    expect(updateArtifactWithHeaderSpy).not.toHaveBeenCalled();
  });

  it('withholds approval for a duplicated structured question', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-duplicate',
          answers: [
            { question: 'Deploy to production?', values: ['No'] },
            { question: 'Deploy to production?', values: ['Yes'] },
          ],
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(
      screen.findByTestId('approvals.unrepresentable-details'),
    ).not.toBeNull();
    expect(readRenderedText(screen)).not.toContain('Deploy to production?');
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);

    await screen.pressByTestIdAsync('approvals.approve');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('withholds approval instead of only hiding a structured answer payload above the canonical total-size bound', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-oversized',
          answers: Array.from({ length: 16 }, (_, index) => ({
            question: `Question ${index}`,
            values: [`oversized-answer-${index}-${'x'.repeat(16_360)}`],
          })),
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(readRenderedText(screen)).not.toContain('oversized-answer-0');
    expect(
      screen.findByTestId('approvals.unrepresentable-details'),
    ).not.toBeNull();
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);

    await screen.pressByTestIdAsync('approvals.approve');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('uses the approval Home for duplicate session ids and opens the scoped session route', async () => {
    currentArtifact = createCurrentApprovalArtifact('server-approval');
    portableProfileResolution = {
      kind: 'resolved',
      serverIdentityId: 'stable-home-a',
      profile: { id: 'server-approval', serverIdentityId: 'stable-home-a', name: '' },
    };
    sessionFixtures = {
      'session-1': createSessionFixture({
        id: 'session-1',
        metadata: {
          name: 'Active Home session',
          host: 'tester.local',
          path: '/active',
          machineId: 'machine-active',
        },
      }),
    };
    sessionFixturesByServerId = {
      'server-active': sessionFixtures,
      'server-approval': {
        'session-1': createSessionFixture({
          id: 'session-1',
          metadata: {
            name: 'Approval Home session',
            host: 'tester.local',
            path: '/approval',
            machineId: 'machine-approval',
          },
        }),
      },
    };
    machineFixturesByServerId = {
      'server-approval': {
        'machine-approval': createMachineFixture({
          id: 'machine-approval',
          metadata: {
            displayName: 'Approval Home workstation',
            host: 'approval.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
          },
        }),
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(readRenderedText(screen)).toContain('Approval Home session');
    expect(readRenderedText(screen)).toContain('Approval Home workstation');
    expect(readRenderedText(screen)).toContain('/approval');
    expect(readRenderedText(screen)).not.toContain('Active Home session');

    await act(async () => {
      await screen.pressByTestIdAsync('approvals.open-session');
    });

    expect(pushSpy).toHaveBeenCalledWith(
      '/session/session-1?serverId=server-approval',
    );
  });

  it('keeps approval actions available for an authorized locked Session without exposing cached title or path', async () => {
    currentArtifact = createCurrentApprovalArtifact('server-approval');
    sessionFixturesByServerId = {
      'server-approval': {
        'session-1': createSessionFixture({
          id: 'session-1',
          encryptionMode: 'e2ee',
          encryptedContentAvailability: 'encrypted_access_pending',
          metadata: {
            name: 'Private cached title',
            host: 'tester.local',
            path: '/Users/private/secret-project',
            homeDir: '/Users/private',
            machineId: 'machine-approval',
          },
        }),
      },
    };
    machineFixturesByServerId = {
      'server-approval': {
        'machine-approval': createMachineFixture({ id: 'machine-approval' }),
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(readRenderedText(screen)).not.toContain('Private cached title');
    expect(readRenderedText(screen)).not.toContain('secret-project');
    expect(readRenderedText(screen)).toContain(
      'actionConfirmations.homeTarget',
    );
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(
      false,
    );
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
  });

  it('does not read the active Home session when a bare approval session id is ambiguous', async () => {
    resolvePreferredServerIdForSessionIdSpy.mockReturnValue(undefined);
    sessionFixtures = {
      'session-1': createSessionFixture({
        id: 'session-1',
        metadata: {
          name: 'Wrong active Home session',
          host: 'tester.local',
          path: '/active',
          machineId: 'machine-target',
        },
      }),
    };
    sessionFixturesByServerId = {
      'server-active': sessionFixtures,
      'server-other': {
        'session-1': createSessionFixture({
          id: 'session-1',
          metadata: {
            name: 'Other Home session',
            host: 'tester.local',
            path: '/other',
            machineId: 'machine-target',
          },
        }),
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(readRenderedText(screen)).not.toContain('Wrong active Home session');
    expect(readRenderedText(screen)).not.toContain('Other Home session');
    expect(screen.findByTestId('approvals.open-session')).toBeNull();
  });

  it('places the primary approve action before the reject action', async () => {
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const testIdOrder = collectRenderedTestIds(screen.tree.toJSON());

    expect(testIdOrder.indexOf('approvals.approve')).toBeGreaterThanOrEqual(0);
    expect(testIdOrder.indexOf('approvals.reject')).toBeGreaterThanOrEqual(0);
    expect(testIdOrder.indexOf('approvals.approve')).toBeLessThan(
      testIdOrder.indexOf('approvals.reject'),
    );
  });

  it('fetches the artifact body when the route opens without a cached artifact', async () => {
    currentArtifact = null;
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
    expect(screen).toBeTruthy();
  });

  it('fetches the artifact body when only a header-only artifact with a null body is cached', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: null,
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
    expect(screen).toBeTruthy();
  });

  it('shows an error state when loading a missing approval artifact fails', async () => {
    currentArtifact = null;
    fetchArtifactWithBodySpy.mockResolvedValueOnce(null);
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
    expect(text).toContain('approvals.loadError');
    expect(screen.findAllByType(await loadActivitySpinner())).toHaveLength(0);
    expect(screen.findByTestId('approvals.retry')).not.toBeNull();

    fetchArtifactWithBodySpy.mockClear();
    await screen.pressByTestIdAsync('approvals.retry');
    expect(fetchArtifactWithBodySpy).toHaveBeenCalledWith('artifact-1');
  });

  it('shows retained encrypted approvals as locked without refetching them as missing bodies', async () => {
    currentArtifact = {
      id: 'artifact-1',
      title: null,
      header: null,
      body: undefined,
      headerVersion: 3,
      bodyVersion: 4,
      seq: 5,
      createdAt: 1,
      updatedAt: 2,
      isDecrypted: false,
      storageMode: 'e2ee',
      availability: {
        kind: 'locked',
        reason: 'encryption_material_unavailable',
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(fetchArtifactWithBodySpy).not.toHaveBeenCalled();
    expect(readRenderedText(screen)).toContain(
      'settingsAccount.secretKeyMissing',
    );
    expect(screen.findAllByType(await loadActivitySpinner())).toHaveLength(0);
  });

  it('creates the action executor with the session-to-server resolver and routes approval decisions with a server hint', async () => {
    currentArtifact = createCurrentApprovalArtifact('server-approval');
    portableProfileResolution = {
      kind: 'resolved',
      serverIdentityId: 'stable-home-a',
      profile: { id: 'server-approval', serverIdentityId: 'stable-home-a', name: '' },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(createDefaultActionExecutorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resolveServerIdForSessionId: expect.any(Function),
      }),
    );

    await act(async () => {
      await screen.pressByTestIdAsync('approvals.approve');
    });

    expect(executeSpy).toHaveBeenCalledWith(
      'approval.request.decide',
      { artifactId: 'artifact-1', decision: 'approve' },
      expect.objectContaining({
        surface: 'ui',
        serverId: 'server-approval',
      }),
    );
    expect(resolvePreferredServerIdForSessionIdSpy).not.toHaveBeenCalled();
  });

  it('executes approval decisions even when the web confirm modal resolves false (ModalProvider unavailable)', async () => {
    modalConfirmResult = false;
    currentArtifact = createCurrentApprovalArtifact('server-approval');
    portableProfileResolution = {
      kind: 'resolved',
      serverIdentityId: 'stable-home-a',
      profile: { id: 'server-approval', serverIdentityId: 'stable-home-a', name: '' },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    await act(async () => {
      await screen.pressByTestIdAsync('approvals.approve');
    });

    expect(executeSpy).toHaveBeenCalledWith(
      'approval.request.decide',
      { artifactId: 'artifact-1', decision: 'approve' },
      expect.objectContaining({
        surface: 'ui',
        serverId: 'server-approval',
      }),
    );
  });

  it('renders legacy external session.title.set requests without offering an unsafe approval replay', async () => {
    currentArtifact = createSessionTitleApprovalArtifact('server-approval');
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('Set session title');
    expect(text).toContain('New title from MCP');
    expect(text).toContain('Session id');
    expect(text).toContain('Title');

    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('approvals.approve');
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
