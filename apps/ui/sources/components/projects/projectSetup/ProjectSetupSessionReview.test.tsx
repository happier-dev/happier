import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import {
  createTestSessionTranscriptSource,
  renderWithSessionTranscriptSource,
  standardCleanup,
} from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddressKey } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHomeGovernanceHarness, createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// Genuine platform/text boundaries; credential scope, operation store, selectors and the Trust client stay real.
installSessionSubagentCommonModuleMocks({
  storage: () =>
    vi.importActual<typeof import('@/sync/domains/state/storage')>(
      '@/sync/domains/state/storage',
    ),
});
installDisconnectedServerSocketBoundary();
// Current review and continuation are daemon RPC boundaries; the operation reader and Trust owner
// remain real, including the producer digest check and observation publication.
const machineTransport = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (...args: unknown[]) => machineTransport.read(...args),
}));
const { storage } = await import('@/sync/domains/state/storage');
const { Text } = await import('react-native');
const { Modal } = await import('@/modal');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { ProjectSetupSessionReviews } =
  await import('./ProjectSetupSessionReview');

afterEach(() => {
  standardCleanup();
  actionOperationStore.reset();
  machineTransport.read.mockReset();
});

const DIGEST = 'effect-digest-1';

function AccountProbe({ serverId }: { serverId: string }) {
  const binding = useServerCredentialAccountScopeBindings([serverId]).get(serverId);
  return <Text testID="review-account">{binding?.isCurrent() ? binding.accountId : 'resolving'}</Text>;
}

function heldScript(
  serverId: string,
  sessionId: string,
  workspace: {
    serverId: string;
    machineId: string;
    workspaceId: string;
    rootPath: string;
  },
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId: 'held-test',
    revision: 1,
    actionId: 'projects.script.run',
    state: 'accepted',
    scope: { accountId: 'account', machineId: 'devbox', sessionId },
    title: 'test',
    createdAt: 100,
    cancellation: 'supported',
    domainRef: {
      kind: 'projectCommand',
      purpose: 'script',
      serverId,
      machineId: 'devbox',
      workspaceRefId: workspace.workspaceId,
      cwd: workspace.rootPath,
      sourceWorkspace: workspace,
      script: {
        name: 'test',
        source: { kind: 'command', command: 'yarn test' },
      },
    },
    setupReview: {
      kind: 'pendingApproval',
      code: 'project_setup_consent_required',
      reviewedEffectDigest: DIGEST,
      reviewedEffect: {
        v: 1,
        purpose: 'setup',
        commands: [
          {
            source: { kind: 'command', command: 'mise install' },
            executable: 'mise',
            args: ['install'],
          },
          {
            source: { kind: 'command', command: 'yarn install' },
            executable: 'yarn',
            args: ['install', '--immutable'],
          },
        ],
      },
    },
  } as ActionOperationSnapshotV1;
}

describe('Project setup review inside a Session', () => {
  it.each(['thisTime', 'skip', 'changed', 'retired', 'checkoutMismatch', 'sourceMismatch', 'effectFailed'] as const)('consumes the mounted Session %s choice through the real Action front door without Trust', async choice => {
    const home = createHomeGovernanceHarness();
    const homeId = await home.addHome({ name: 'Setup Home', serverUrl: 'https://session-once.test', serverIdentityId: 'srv_session_once', accountId: 'account' });
    const machine = createPlainMachineRowFixture({ id: 'devbox', accountId: 'account' });
    home.answer(homeId, '/v1/machines/devbox', { body: { machine } });
    let held: ActionOperationSnapshotV1;
    const decisions: unknown[] = [];
    const receipts: ActionOperationSnapshotV1[] = [];
    const paths: string[] = [];
    const decisionOwner = await import('./projectSetupConsentDecision');
    const decisionObservation = vi.spyOn(decisionOwner, 'decideProjectSetupConsent');
    const alert = vi.spyOn(Modal, 'alert');
    let finishDecision: (() => void) | undefined;
    const decisionGate = choice === 'retired' ? new Promise<void>(resolve => { finishDecision = resolve; }) : Promise.resolve();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://session-once.test',
      serverIdentityId: 'srv_session_once', accountId: 'account',
      credentials: { token: createAccountTokenForTests('account', { currentAccount: true }) }, request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === '/v1/machines') return Response.json([machine]);
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
          actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'projects.prepare': ['ui'] } },
        } } });
        if (path === '/v1/actions/projects.prepare/execution-authorization') {
          const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
          const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
          return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'test-home-authorization', binding: {
            accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_session_once',
            machineId: 'devbox', installationId: machine.installationId, custodianAccountId: 'account', accountEncryptionMode: 'plain',
            actionId: 'projects.prepare', requestId: envelope.requestId, target: envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          } }));
        }
        if (path === '/v1/actions/projects.prepare') {
          const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
          const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
          decisions.push(envelope.input);
          expect(envelope.target).toMatchObject({ kind: 'machine', machineId: 'devbox' });
          await decisionGate;
          if (choice === 'effectFailed') return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({
            v: 1, actionId: 'projects.prepare', requestId: envelope.requestId,
            execution: { ok: false, errorCode: 'project_source_declaration_unavailable', error: 'project_source_declaration_unavailable' },
          }));
          // A resumed Run projects its target without the review-only Source attachment (LV16).
          const target = held.domainRef;
          if (target?.kind !== 'projectCommand') throw new Error('Expected retained Project target');
          const operation = ActionOperationSnapshotV1Schema.parse({ ...held, revision: 2, domainRef: { ...target,
            workspaceRefId: choice === 'checkoutMismatch' ? 'different-checkout' : target.workspaceRefId,
            sourceWorkspace: choice === 'changed' ? target.sourceWorkspace : choice === 'sourceMismatch'
              ? { ...target.sourceWorkspace!, rootPath: '/another-source' } : undefined,
          }, setupReview: choice === 'changed' ? {
            ...held.setupReview!, code: 'project_setup_effect_changed' as const, reviewedEffectDigest: 'current-effect',
          } : undefined });
          receipts.push(operation);
          return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.prepare',
            requestId: envelope.requestId, execution: { ok: true, result: { operation } } }));
        }
        if (path.includes('project-trust')) throw new Error('One-time and Skip cannot read or write Trust');
        return home.request(url, init);
      } });
    const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
    const workspace = { serverId, machineId: 'source', workspaceId: 'source-ref', rootPath: '/source' };
    held = heldScript(serverId, 'session-1', workspace);
    held = ActionOperationSnapshotV1Schema.parse({ ...held, actionId: 'execution.run.start', state: 'running', startedAt: 100,
      domainRef: { kind: 'projectCommand', purpose: 'setup',
        serverId, machineId: 'devbox', workspaceRefId: 'worker-ref', cwd: '/worker', sourceWorkspace: workspace } });
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [held] });
    const screen = await renderWithSessionTranscriptSource(<ProjectSetupSessionReviews sessionId="session-1" serverId={serverId} />,
      createTestSessionTranscriptSource({ sessionId: 'session-1', serverId, interaction: { canApprovePermissions: true } as never }));
    try {
      const id = 'project-setup-session-review:held-test';
      await vi.waitFor(() => expect(screen.findByTestId(`${id}.scope:thisTime`)).not.toBeNull());
      if (choice === 'skip') await act(async () => { await screen.pressByTestIdAsync(`${id}.scope:skip`); });
      await act(async () => { screen.pressByTestId(`${id}-approve`); });
      await vi.waitFor(async () => expect(decisions, JSON.stringify({ paths,
        decision: choice === 'retired' ? 'pending' : await decisionObservation.mock.results[0]?.value })).toHaveLength(1));
      expect(decisions[0]).toEqual({ workspace: { serverId, machineId: 'devbox', workspaceId: 'worker-ref', rootPath: '/worker' },
        phase: 'setup', expectedEffectDigest: DIGEST, heldOperationId: 'held-test',
        ...(choice === 'skip' ? { skipForInvocation: true } : { consentScope: 'thisTime' }) });
      if (choice !== 'retired' && choice !== 'effectFailed') expect(receipts).toHaveLength(1);
      if (choice === 'retired') {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const bob = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature` };
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(bob);
        try {
          await act(async () => { await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId }, bob); });
          finishDecision!();
          await vi.waitFor(() => expect(screen.findByTestId(id)).toBeNull());
          expect(await decisionObservation.mock.results[0]?.value).toMatchObject({ kind: 'unavailable' });
        } finally { credentialRead.mockRestore(); }
      } else if (choice === 'effectFailed') {
        expect(await decisionObservation.mock.results[0]?.value).toEqual({ kind: 'unavailable', code: 'project_source_declaration_unavailable' });
        // Readable words first; the typed code waits behind the alert's Technical details.
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.any(String),
          expect.not.stringContaining('project_source_declaration_unavailable'), expect.any(Array)));
        const buttons = alert.mock.calls.at(-1)?.[2] as Array<{ onPress?: () => void }>;
        buttons[0]?.onPress?.();
        expect(alert).toHaveBeenLastCalledWith(expect.any(String), 'project_source_declaration_unavailable');
        expect(screen.findByTestId(`${id}.settled`)).toBeNull();
      } else if (choice === 'changed') {
        expect(await decisionObservation.mock.results[0]?.value).toEqual({ kind: 'changed' });
        await vi.waitFor(() => expect(actionOperationStore.getSnapshot().operationsByKey.get(actionOperationAddressKey({ serverId,
          operationId: 'held-test' }))?.snapshot.setupReview?.reviewedEffectDigest).toBe('current-effect'));
        expect(screen.findByTestId(`${id}.settled`)).toBeNull();
      } else if (choice === 'checkoutMismatch' || choice === 'sourceMismatch') {
        await vi.waitFor(() => expect(alert).toHaveBeenCalled());
        expect(await decisionObservation.mock.results[0]?.value).toMatchObject({ kind: 'unavailable' });
        expect(screen.findByTestId(`${id}.settled`)).toBeNull();
        expect(actionOperationStore.getSnapshot().operationsByKey.get(actionOperationAddressKey({ serverId,
          operationId: 'held-test' }))?.snapshot).toEqual(held);
      } else {
        expect(await decisionObservation.mock.results[0]?.value).toEqual({ kind: 'continued' });
        await vi.waitFor(() => expect(screen.findByTestId(`${id}.settled`)).not.toBeNull());
        expect(alert).not.toHaveBeenCalled();
        const resumed = actionOperationStore.getSnapshot().operationsByKey.get(actionOperationAddressKey({ serverId,
          operationId: 'held-test' }))?.snapshot;
        expect(resumed).toMatchObject({ operationId: held.operationId, actionId: 'execution.run.start' });
        expect(resumed?.setupReview).toBeUndefined();
      }
    } finally { finishDecision?.(); await screen.unmount(); decisionObservation.mockRestore(); alert.mockRestore(); await connection.dispose(); }
  });

  it.each([false, true])('remembers the exact held effect through projects.prepare admission (disabled: %s)', async disabled => {
    const mutations: unknown[] = [];
    const connection = await restoreServerAccountForTest({
      serverUrl: 'https://setup-session-review.test',
      serverIdentityId: 'srv_setup_session_review',
      accountId: 'account',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption')
          return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness')
          return Response.json(
            createPlainAccountEncryptionCurrentnessFixture(),
          );
        if (path === '/v2/account/settings')
          return Response.json({ content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
            actions: disabled ? { 'projects.prepare': { disabledSurfaces: ['ui'] } } : {},
            approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'], 'projects.prepare': ['ui'] } } } }, version: 1 });
        if (path === '/v1/account/project-rows/list')
          return Response.json(createPlainProjectAccountRowListFixture({
            workspaceRefs: [{ id: 'checkout', serverId: 'srv_setup_session_review', machineId: 'devbox',
              rootPath: '/src/happier', createdAtMs: 1, projectKey: 'project-happier' }],
          }));
        if (path === '/v1/account/project-trust/read')
          return Response.json({ status: 'absent' });
        if (path === '/v1/account/project-trust/mutate') {
          mutations.push(JSON.parse(String(init?.body)));
          return Response.json({ status: 'updated', revision: 1, cursor: 1 });
        }
        return Response.json({}, { status: 404 });
      },
    });
    try {
      const serverId = resolveServerProfileScopeIdForIdentifier(
        connection.home.id,
      );
      const workspace = {
        serverId,
        machineId: 'devbox',
        workspaceId: 'checkout',
        rootPath: '/src/happier',
      };
      const scope = { serverId, accountId: 'account' };
      const machine = createMachineFixture({ id: 'devbox', isShared: true });
      storage.setState({
        machineListByServerId: { [serverId]: [{ ...machine, metadata: { ...machine.metadata!, username: 'shared-user' } }] },
        profileScope: scope,
        projectAccountRows: {
          scope,
          status: 'ready',
          coverage: 'complete',
          relationships: [],
          organizations: [],
          revisionsByPhysicalKey: {},
          workspaceRefs: [
            {
              id: 'checkout',
              serverId,
              machineId: 'devbox',
              rootPath: '/src/happier',
              createdAtMs: 1,
              projectKey: 'project-happier',
            },
          ],
        },
      } as never);
      const held = ActionOperationSnapshotV1Schema.parse({ ...heldScript(serverId, 'session-1', workspace),
        actionId: 'execution.run.start', state: 'running', startedAt: 100,
        domainRef: { kind: 'projectCommand', purpose: 'setup', serverId, machineId: workspace.machineId,
          workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace } });
      const target = held.domainRef;
      if (target?.kind !== 'projectCommand') throw new Error('Expected retained Project target');
      let refreshes = 0;
      machineTransport.read.mockImplementation(async ({ payload }) => {
        if (payload.refreshSetupReview) refreshes += 1;
        return { kind: 'found', operation: refreshes < 2 ? held : { ...held, revision: 2, setupReview: undefined,
          domainRef: { ...target, sourceWorkspace: undefined } } };
      });
      const decisionOwner = await import('./projectSetupConsentDecision');
      const decisionObservation = vi.spyOn(decisionOwner, 'decideProjectSetupConsent');
      actionOperationStore.mergeSnapshots({
        serverId,
        snapshots: [
          held,
          // Another Session's held run is not asked here.
          {
            ...heldScript(serverId, 'session-2', workspace),
            operationId: 'other-session',
          },
        ],
      });
      const source = createTestSessionTranscriptSource({
        sessionId: 'session-1',
        serverId,
        interaction: { canApprovePermissions: true } as never,
      });
      const screen = await renderWithSessionTranscriptSource(
        <>
          <ProjectSetupSessionReviews sessionId="session-1" serverId={serverId} />
          <AccountProbe serverId={serverId} />
        </>,
        source,
      );
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('project-setup-session-review:held-test'),
        ).not.toBeNull(),
      );
      expect(
        screen.findByTestId('project-setup-session-review:other-session'),
      ).toBeNull();
      expect(screen.getTextContent()).toContain('mise install');
      expect(screen.getTextContent()).toContain('yarn install --immutable');

      await act(async () => {
        await screen.pressByTestIdAsync('project-setup-session-review:held-test.scope:untilChanged');
      });
      await act(async () => {
        screen.pressByTestId('project-setup-session-review:held-test-approve');
      });
      if (disabled) {
        await vi.waitFor(async () => expect(await decisionObservation.mock.results.at(-1)?.value)
          .toEqual({ kind: 'unavailable', code: 'action_disabled' }));
        expect(mutations).toEqual([]);
        expect(machineTransport.read).not.toHaveBeenCalled();
        await screen.unmount();
        return;
      }
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('project-setup-session-review:held-test.settled'),
        ).not.toBeNull(),
      );
      expect(mutations).toEqual([
        {
          project: { serverId, projectId: 'project-happier' },
          expectedRevision: 'absent',
          content: {
            t: 'plain',
            v: {
              project: { serverId, projectId: 'project-happier' },
              reviewedEffectDigest: DIGEST,
              approvedAtMs: expect.any(Number),
            },
          },
        },
      ]);
      // Later filesystem changes can rehold the very same reservation after Remember returned.
      const later = { ...held, revision: 3, setupReview: {
        ...held.setupReview!, code: 'project_setup_effect_changed' as const,
        reviewedEffectDigest: 'effect-B', reviewedEffect: { commands: [{ executable: 'make', args: ['bootstrap'] }],
          presentation: { bindings: [{ name: 'TOKEN', ref: 'saved-secret:deploy', revision: 7,
            source: 'shared_resource', displayName: 'Deployment', value: 'NEVER-DISCLOSE' }],
            provenance: { file: '.happier/project.json', kind: 'repository', headCommit: 'abcdef123456',
              branch: 'feature', fileState: 'modified', bytes: 'NEVER-DISCLOSE' } } },
      } };
      await act(async () => { actionOperationStore.mergeSnapshots({ serverId, snapshots: [later] }); });
      expect(screen.findByTestId('project-setup-session-review:held-test.settled')).toBeNull();
      expect(screen.getTextContent()).toContain('make bootstrap');
      expect(screen.findByTestId('project-setup-session-review:held-test-reject')).not.toBeNull();
      machineTransport.read.mockResolvedValue({ kind: 'requested' });
      await act(async () => { screen.pressByTestId('project-setup-session-review:held-test-reject'); });
      await vi.waitFor(() => expect(machineTransport.read).toHaveBeenCalledWith(expect.objectContaining({
        serverId, machineId: 'devbox', method: 'actionOperation.cancel.v1', payload: { operationId: 'held-test' },
      })));
      expect(screen.getTextContent()).toContain('saved-secret:deploy');
      expect(screen.getTextContent()).toContain('r7');
      expect(screen.getTextContent()).toContain('secretsSettings.keepShared');
      expect(screen.getTextContent()).toContain('projects.scripts.setup.provenanceModified');
      expect(screen.getTextContent()).toContain('machines.sharing.fallback.lead');
      expect(screen.getTextContent()).not.toContain('NEVER-DISCLOSE');

      // Retire the Account binding, then return to the same Account: old settled lines stay gone.
      await act(async () => { actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...held, revision: 4, setupReview: undefined }] }); });
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
      const bob = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature` };
      credentialRead.mockResolvedValue(bob);
      await act(async () => { await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId }, bob); });
      await vi.waitFor(() => expect(screen.findByTestId('review-account')?.children).toEqual(['bob']));
      await vi.waitFor(() => expect(screen.findByTestId('project-setup-session-review:held-test')).toBeNull());
      credentialRead.mockResolvedValue(connection.credentials);
      await act(async () => { await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId }, connection.credentials); });
      await vi.waitFor(() => expect(screen.findByTestId('review-account')?.children).toEqual(['account']));
      expect(screen.findByTestId('project-setup-session-review:held-test.settled')).toBeNull();
      await screen.unmount();
    } finally {
      await connection.dispose();
    }
  });

  it('draws nothing for a Session whose live operations carry no setup review', async () => {
    const connection = await restoreServerAccountForTest({
      serverUrl: 'https://setup-session-none.test',
      serverIdentityId: 'srv_setup_session_none',
      accountId: 'account',
      request: async () => Response.json({}, { status: 404 }),
    });
    try {
      const serverId = resolveServerProfileScopeIdForIdentifier(
        connection.home.id,
      );
      const workspace = {
        serverId,
        machineId: 'devbox',
        workspaceId: 'checkout',
        rootPath: '/src/happier',
      };
      const { setupReview: _omit, ...running } = heldScript(
        serverId,
        'session-1',
        workspace,
      );
      actionOperationStore.mergeSnapshots({
        serverId,
        snapshots: [running as ActionOperationSnapshotV1],
      });
      const screen = await renderWithSessionTranscriptSource(
        <ProjectSetupSessionReviews
          sessionId="session-1"
          serverId={serverId}
        />,
        createTestSessionTranscriptSource({ sessionId: 'session-1', serverId }),
      );
      expect(
        screen.findByTestId('project-setup-session-review:held-test'),
      ).toBeNull();
      await screen.unmount();
    } finally {
      await connection.dispose();
    }
  });
});
