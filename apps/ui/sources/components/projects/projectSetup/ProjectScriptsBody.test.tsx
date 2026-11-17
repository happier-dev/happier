import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';

import {
  createSessionFixture,
  createDeferred,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowMutationRequestV1Schema,
  ProjectAccountOrganizationV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ProjectOrganizationRow } from '@/sync/domains/workspaces/projectAccountRows';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { countReadBorrowers } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { deriveWorkspaceSyncRelationshipId, projectWorkspaceSyncAdmissionInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2,
  ActionOperationGetV2RequestSchema, ActionOperationCancelV1RequestSchema } from '@happier-dev/protocol/actions/operations/v1';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
installDisconnectedServerSocketBoundary();

/**
 * Home HTTP and Machine RPC are the boundaries. The Action front door, policy, Project client,
 * editor model, operation store and shared setup-authoring owner stay real.
 * The code editor is a WebView/Monaco platform surface, so it is replaced by a plain element.
 */
const shared = vi.hoisted(() => ({
  calls: [] as Array<{ actionId: string; input: any }>,
  inspection: null as unknown,
  inspectionPending: null as Promise<unknown> | null,
  /** Encoded result bytes the Home returned for each projects.inspect. */
  inspectionBytes: [] as number[],
  responses: {} as Record<string, unknown>,
  /** A typed Action refusal the daemon returned instead of a result. */
  failures: {} as Record<string, unknown>,
  organizations: [] as ProjectOrganizationRow[],
  organizationWrites: [] as unknown[],
  trustMutations: [] as unknown[],
  /** The device class the platform adapter reports; unset keeps the real one. */
  device: null as 'phone' | null,
  operationRead: vi.fn(),
  actionSettings: {} as Record<string, { approvalRequiredSurfaces: Array<'ui'> }>,
  navigate: vi.fn(),
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: shared.navigate } }).module;
});

// The person accepts the platform confirmation; Action policy and approval custody stay real.
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});

// Network observation of the retained operation; the shared reader and store stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: async (request: Readonly<{ method: string; payload: unknown }>) => {
      const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
      const update = getActionSpec('projects.manifest.update');
      if (request.method === update.bindings?.rpcMethod) {
        if (!update.outputSchema) throw new Error('Project manifest update requires an output schema');
        const input = update.inputSchema.parse(request.payload);
        shared.calls.push({ actionId: update.id, input });
        return update.outputSchema.parse(await (shared.responses[update.id] ?? { status: 'refused', code: 'write_failed' }));
      }
      return shared.operationRead(request);
    },
  }),
);

// The device class is a platform adapter boundary; phone cases set it, every other case keeps the real one.
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => { const real = actual.useDeviceType(); return shared.device ?? real; } };
});

vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
  const React = await import('react');
  return {
    CodeEditor: React.forwardRef((props: any, _ref: any) =>
      React.createElement('CodeEditor', props),
    ),
  };
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  const parameterized = createTextModuleMock();
  return createTextModuleMock({ translate: (key, params) =>
    // Memory summaries disclose the stored amount through the translation parameter.
    key === 'projects.scripts.editor.needsAbout' || key === 'projects.scripts.setup.lead' || key === 'projects.authoring.lastSession'
      ? parameterized.t(key, params) : key,
  });
});

const { ProjectScriptsBody, ProjectScriptsContent } = await import('./ProjectScriptsBody');
const { DetectedRow } = await import('./ProjectDetectedScriptRow');
// The host renderer exposes the memo's render function as its instance type.
const detectedRowElementType: unknown = DetectedRow;
const detectedRowRenderType = detectedRowElementType && typeof detectedRowElementType === 'object' && 'type' in detectedRowElementType
  ? detectedRowElementType.type : detectedRowElementType;
const { ProjectPageBackProvider } = await import('@/components/projects/detail/projectPageBack');
const { AppPaneScopeLayoutProvider } = await import('@/components/appShell/panes/hooks/useAppPaneScopeLayout');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { readSessionTerminalWorkspaceForScope } = await import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime');
const { paneUiState } = await import('@/sync/domains/state/filePaneUiState');
const { storage } = await import('@/sync/domains/state/storageStore');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const sessionParts = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority');
const previous = storage.getState();
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-1', encryptionMode: 'plain' });
const terminalScopes = new Set<string>();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null =
  null;
let disposeExecutor: (() => void) | null = null;

afterEach(async () => {
  standardCleanup();
  for (const scope of terminalScopes) paneUiState.remove(scope);
  terminalScopes.clear();
  shared.trustMutations = [];
  shared.operationRead.mockReset();
  await connection?.dispose();
  connection = null;
  disposeExecutor?.();
  disposeExecutor = null;
  storage.setState(previous);
  actionOperationStore.reset();
  shared.calls = [];
  shared.inspection = null;
  shared.inspectionPending = null;
  shared.inspectionBytes = [];
  shared.responses = {};
  shared.failures = {};
  shared.organizations = [];
  shared.organizationWrites = [];
  shared.device = null;
  shared.actionSettings = {};
  shared.navigate.mockReset();
  artifacts.clear();
});

const workspace = {
  serverId: 'srv_scripts_body',
  workspaceId: 'w1',
  machineId: 'm1',
  rootPath: '/repo',
};
let workspaceSequence = 0;
let workspaceServerUrl = 'https://scripts-body.test';
beforeEach(() => {
  workspace.serverId = 'srv_scripts_body';
  workspaceServerUrl = 'https://scripts-body.test';
  shared.operationRead.mockImplementation(async (request: Readonly<{ method: string; machineId: string; payload: unknown }>) => {
    if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) {
      const input = ActionOperationGetV2RequestSchema.parse(request.payload);
      shared.calls.push({ actionId: 'action.operations.get', input });
      const found = [...actionOperationStore.getSnapshot().operationsByKey.values()]
        .find(value => value.snapshot.operationId === input.operationId && value.snapshot.scope.machineId === request.machineId);
      return found ? { kind: 'found', operation: found.snapshot } : { kind: 'not_found' };
    }
    if (request.method === ACTION_OPERATION_RPC_METHODS_V1.cancel) {
      const input = ActionOperationCancelV1RequestSchema.parse(request.payload);
      shared.calls.push({ actionId: 'action.operations.cancel', input });
      return { kind: 'requested' };
    }
    throw new Error(`Unexpected Scripts Machine request: ${request.method}`);
  });
});
function isolateManifestDrafts() {
  workspace.serverId = `srv_scripts_body_${++workspaceSequence}`;
  workspaceServerUrl = `https://scripts-body-${workspaceSequence}.test`;
}
const nativeRef = (target: string) => ({
  kind: 'native',
  tool: 'package_script',
  file: 'package.json',
  target,
} as const);
const detection = {
  entries: [
    { source: nativeRef('test'), usage: 'script' },
    { source: nativeRef('lint'), usage: 'script' },
  ],
  toolchains: [],
  devcontainers: [],
  coverage: 'complete',
  diagnostics: [],
};
const hash = 'a'.repeat(64);

function presentDefinition(
  manifest: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const original = { ...manifest, ...extra };
  const bytes = `${JSON.stringify(original, null, 2)}\n`;
  return {
    basis: { kind: 'present', hash },
    document: readProjectManifestDocument(bytes),
  };
}

const declared = {
  version: 1,
  scripts: { test: { source: nativeRef('test') } },
};

describe('Project task Saved Secret bindings (owner decision 2026-11-05)', () => {
  it('offers Project-scoped Secret selection after a refused Run without replaying it', async () => {
    shared.failures['projects.script.run'] = { ok: false,
      errorCode: 'project_environment_binding_unavailable', error: 'project_environment_binding_unavailable' };
    shared.inspection = { definition: presentDefinition({ ...declared,
      environmentVariables: [{ name: 'DEPLOY_TOKEN', kind: 'secret', required: true }],
    }), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.script:test.run');
    await screen.pressByTestIdAsync('scripts.script:test.run');
    await vi.waitFor(() => expect(screen.findByTestId('scripts.script:test.environment.DEPLOY_TOKEN.choose')).toBeTruthy());
    await screen.pressByTestIdAsync('scripts.script:test.environment.DEPLOY_TOKEN.choose');
    const { Modal } = await import('@/modal');
    expect(Modal.show).toHaveBeenCalled();
    const picker = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    expect(picker?.props).toMatchObject({ scope: { serverId: workspace.serverId, accountId: 'account-1' },
      referenceSelection: { selected: null } });
    expect(shared.calls.filter(call => call.actionId === 'projects.script.run')).toHaveLength(1);
    expect(screen.findByTestId('scripts.environment.DEPLOY_TOKEN.choose')).toBeTruthy();
    const props = picker?.props as Readonly<{ referenceSelection: { onSelect: (value: unknown) => void } }>;
    await act(async () => props.referenceSelection.onSelect({
      ref: 'happier:shared-secret:v1:deployment-token', resourceRevision: 2,
    }));
    await vi.waitFor(() => expect(shared.organizations[0]?.value.environmentBindings?.bindings.DEPLOY_TOKEN)
      .toEqual({ ref: 'happier:shared-secret:v1:deployment-token', revision: 2 }));
    expect(shared.calls.filter(call => call.actionId === 'projects.script.run')).toHaveLength(1);
    delete shared.failures['projects.script.run'];
    await screen.pressByTestIdAsync('scripts.script:test.run');
    const runs = shared.calls.filter(call => call.actionId === 'projects.script.run');
    expect(runs).toHaveLength(2);
    expect(runs[1]?.input.selection).toEqual({ kind: 'named', name: 'test' });
    expect(runs[1]?.input).not.toHaveProperty('environmentBindings');
  });

  it('offers the same Project binding recovery when an accepted operation settles with a missing Secret', async () => {
    shared.inspection = { definition: presentDefinition({ ...declared,
      environmentVariables: [{ name: 'DEPLOY_TOKEN', kind: 'secret', required: true }],
    }), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.script:test.run');
    await screen.pressByTestIdAsync('scripts.script:test.run');
    expect(screen.findByTestId('scripts.script:test.environment.DEPLOY_TOKEN.choose')).toBeNull();
    const failed: ActionOperationSnapshotV1 = { ...operation('failed', 2), error: {
      errorCode: 'project_environment_binding_unavailable', error: 'project_environment_binding_unavailable',
    } };
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [failed] }));
    await vi.waitFor(() => expect(screen.findByTestId('scripts.script:test.environment.DEPLOY_TOKEN.choose')).toBeTruthy());
    await screen.pressByTestIdAsync('scripts.script:test.environment.DEPLOY_TOKEN.choose');
    const { Modal } = await import('@/modal');
    expect(vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props).toMatchObject({
      scope: { serverId: workspace.serverId, accountId: 'account-1' }, referenceSelection: { selected: null },
    });
    expect(shared.calls.filter(call => call.actionId === 'projects.script.run')).toHaveLength(1);
  });

  it('saves, changes and removes a Project reference through the real Action and row CAS without replaying Run', async () => {
    shared.organizations = [{ key: { kind: 'project-organization', serverId: workspace.serverId, projectKey: 'w1' },
      revision: 4, value: { label: 'Repository', pinned: true, environmentBindings: { v: 1, bindings: {
        EXISTING_TOKEN: { ref: 'existing-secret' },
      } } } }];
    shared.inspection = { definition: presentDefinition({ ...declared,
      environmentVariables: [{ name: 'DEPLOY_TOKEN', kind: 'secret', required: true }],
    }), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.environment.DEPLOY_TOKEN.choose');
    const { Modal } = await import('@/modal');
    const select = async (resourceId: string, resourceRevision: number) => {
      await screen.pressByTestIdAsync('scripts.environment.DEPLOY_TOKEN.choose');
      const picker = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
      const props = picker?.props as Readonly<{ referenceSelection: { onSelect: (value: unknown) => void } }>;
      await act(async () => props.referenceSelection.onSelect({ ref: `happier:shared-secret:v1:${resourceId}`, resourceRevision }));
    };
    await select('deployment-token', 2);
    await vi.waitFor(() => expect(shared.organizations[0]?.value.environmentBindings?.bindings.DEPLOY_TOKEN)
      .toEqual({ ref: 'happier:shared-secret:v1:deployment-token', revision: 2 }));
    await select('alternate-token', 3);
    await vi.waitFor(() => expect(shared.organizations[0]?.value.environmentBindings?.bindings.DEPLOY_TOKEN)
      .toEqual({ ref: 'happier:shared-secret:v1:alternate-token', revision: 3 }));
    await screen.pressByTestIdAsync('scripts.environment.DEPLOY_TOKEN.remove');
    await vi.waitFor(() => expect(shared.organizations[0]?.value.environmentBindings?.bindings.DEPLOY_TOKEN).toBeUndefined());
    expect(shared.organizations[0]?.value).toEqual({ label: 'Repository', pinned: true,
      environmentBindings: { v: 1, bindings: { EXISTING_TOKEN: { ref: 'existing-secret' } } } });
    expect(shared.organizationWrites).toHaveLength(3);
    expect(shared.calls.filter(call => call.actionId === 'projects.script.run')).toHaveLength(0);
  });
});

function operation(
  state: 'accepted' | 'failed' | 'succeeded',
  revision: number,
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId: 'op-1',
    revision,
    actionId: 'projects.script.run',
    state,
    scope: { accountId: 'account-1', machineId: 'm1' },
    title: 'projects.script.run',
    createdAt: 1_000,
    ...(state !== 'accepted'
      ? {
          startedAt: 1_100,
          settledAt: 2_000,
          ...(state === 'failed'
            ? {
                error: {
                  errorCode: 'process_settled',
                  error: 'process_settled',
                },
              }
            : {}),
        }
      : {}),
    domainRef: {
      kind: 'projectCommand',
      purpose: 'script',
      serverId: workspace.serverId,
      machineId: 'm1',
      workspaceRefId: 'w1',
      cwd: '/repo',
      sourceWorkspace: workspace,
      script: { name: 'test', source: nativeRef('test') },
    },
    cancellation: 'supported',
  };
}

async function render(
  presentation: 'page' | 'rail' | 'widget',
  ready: string,
  host: Readonly<{
    outputScopeId?: string;
    terminalHost?: boolean;
    bottomPresentation?: 'docked' | 'overlay';
    /** The Project's phone bar: receives the way back a pushed page registers. */
    registerPageBack?: (back: (() => void) | null) => void;
    authoredSession?: Readonly<{ id: string; response: Promise<Response>; reads: string[]; writes?: string[] }>;
    onOpenScripts?: () => void;
    onOpenServices?: () => void;
  }> = {},
) {
  const authoredMetadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
  // This Home serves embedded terminals; each case chooses whether its host mounts one.
  const fixtureSettings = { actionsSettingsV1: { v: 1 as const, actions: shared.actionSettings },
    featureToggles: { 'terminal.embeddedPty': true } };
  let authoredSeeded = false;
  connection ??= await restoreServerAccountForTest({
    serverUrl: workspaceServerUrl,
    serverIdentityId: workspace.serverId,
    accountId: 'account-1',
    credentials: { token: createAccountTokenForTests('account-1', { currentAccount: true }) },
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/features' || path === '/v1/features/authenticated')
        return Response.json(createRootLayoutFeaturesResponse({ features: {
          terminal: { embeddedPty: { enabled: true } },
        } }));
      const machineRead = createPlainMachineReadHttpResponseFixture(path, init, 'account-1');
      if (machineRead) return machineRead;
      if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'm1', accountId: 'account-1' })]);
      if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) return Response.json({ status: 'absent' });
      const authorization = /^\/v1\/actions\/([^/]+)\/execution-authorization$/.exec(path);
      if (authorization) {
        const actionId = ActionIdSchema.parse(decodeURIComponent(authorization[1]!));
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
        const machine = createPlainMachineRowFixture({ id: request.machineId, accountId: 'account-1' });
        const syncAdmission = request.envelope.v === 1 ? projectWorkspaceSyncAdmissionInputV1(actionId, request.envelope.input) : undefined;
        const requestId = request.envelope.requestId;
        if (!requestId) throw new Error('Project Action fixture requires a request ID');
        return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'scripts-body-root', binding: {
          accountId: 'account-1', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: workspace.serverId,
          machineId: machine.id, installationId: machine.installationId, custodianAccountId: 'account-1', accountEncryptionMode: 'plain',
          actionId, requestId: request.envelope.requestId, target: request.envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          ...(syncAdmission ? { workspaceSyncAdmission: {
            relationshipId: syncAdmission.relationshipId ?? deriveWorkspaceSyncRelationshipId(requestId),
            sourceWorkspaceRefId: syncAdmission.sourceWorkspaceRefId,
            source: { actorAccountId: 'account-1', custodianAccountId: 'account-1', machineId: syncAdmission.sourceMachineId,
              installationId: machine.installationId, role: 'manage', encryptionMode: 'plain' },
          } } : {}),
        } }));
      }
      const action = /^\/v1\/actions\/([^/]+)$/.exec(path);
      if (action) {
        const actionId = ActionIdSchema.parse(decodeURIComponent(action[1]!));
        const body: unknown = JSON.parse(String(init?.body));
        const root = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(root.success ? root.data.envelope : body);
        const spec = getActionSpec(actionId);
        if (!spec.outputSchema) throw new Error('Project Action fixture requires an output schema');
        const input = spec.inputSchema.parse(envelope.input);
        shared.calls.push({ actionId, input });
        const failure = shared.failures[actionId];
        const inspected = actionId === 'projects.inspect' ? await (shared.inspectionPending ?? shared.inspection) : undefined;
        // The daemon's revalidation contract: a held equal revision is answered without a body.
        const ifRevision = typeof input === 'object' && input !== null && 'ifRevision' in input ? input.ifRevision : undefined;
        const unchanged = actionId === 'projects.inspect' && typeof ifRevision === 'string'
          && (inspected as { revision?: unknown } | null)?.revision === ifRevision;
        const answer = actionId === 'projects.inspect'
          ? unchanged ? { unchanged: true, revision: ifRevision } : inspected
          : await (shared.responses[actionId] ?? { status: 'refused', code: 'write_failed' });
        if (actionId === 'projects.inspect') shared.inspectionBytes.push(JSON.stringify(answer).length);
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(answer);
        const execution = failure ? ActionExecuteFailureSchema.parse(failure)
          : { ok: true, result: approval.success ? approval.data : spec.outputSchema.parse(answer) };
        return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId, execution }));
      }
      if (host.authoredSession && path === `/v2/sessions/${host.authoredSession.id}`) {
        if ((init?.method ?? 'GET') === 'GET') host.authoredSession.reads.push(host.authoredSession.id);
        const response = await host.authoredSession.response;
        if (!response.ok) return response.clone();
        if (!authoredSeeded) {
          const body = V2SessionByIdResponseSchema.parse(await response.clone().json());
          authoredMetadata.replaceSession(host.authoredSession.id, SessionCurrentProjectionRecordV1Schema.parse(body.session));
          authoredSeeded = true;
        }
        // A full owner read can backfill its display through PATCH. Serve that
        // real CAS boundary separately from the exact Session read cost.
        const result = authoredMetadata.handle(url, init);
        if (init?.method === 'PATCH' && result?.ok) host.authoredSession.writes?.push(host.authoredSession.id);
        return result;
      }
      if (path === '/v1/account/encryption')
        return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness')
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v2/account/settings')
        return Response.json({ content: { t: 'plain', v: fixtureSettings }, version: 1 });
      if (path === '/v1/account/project-rows/list')
        return Response.json(createPlainProjectAccountRowListFixture({
          organizations: shared.organizations,
          workspaceRefs: [{ id: 'w1', serverId: workspace.serverId, machineId: 'm1',
            rootPath: '/repo', createdAtMs: 1, projectKey: 'w1' }],
        }));
      if (path === '/v1/account/project-rows/mutate') {
        const request = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
        const mutation = request.mutations[0]!;
        const current = shared.organizations.find(row => JSON.stringify(row.key) === JSON.stringify(mutation.key));
        expect(mutation.expectedRevision).toBe(current?.revision ?? 'absent');
        if (mutation.key.kind !== 'project-organization' || mutation.content?.t !== 'plain'
          || !('value' in mutation.content.v)) throw new Error('Expected plain organization mutation');
        const value = ProjectAccountOrganizationV1Schema.parse(mutation.content.v.value);
        const revision = (current?.revision ?? -1) + 1;
        shared.organizations = [{ key: mutation.key, value, revision }];
        shared.organizationWrites.push(request);
        return Response.json({ status: 'updated', rows: [{ key: mutation.key, content: mutation.content, revision }], cursor: revision });
      }
      // The approving Account's Project Trust row (D18 "Until it changes") is an HTTP boundary.
      if (path === '/v1/account/project-trust/read')
        return Response.json({ status: 'absent' });
      if (path === '/v1/account/project-trust/mutate') {
        shared.trustMutations.push(JSON.parse(String(init?.body)));
        return Response.json({ status: 'updated', revision: 1, cursor: 1 });
      }
      return await artifacts.handle(path, init);
    },
  });
  disposeExecutor ??= await installRealActionExecutorModuleLoader();
  storage.getState().applySettingsForScope({ serverId: workspace.serverId, accountId: 'account-1' },
    settingsParse(fixtureSettings), 1);
  storage.setState({
    profileScope: { serverId: workspace.serverId, accountId: 'account-1' },
    projectAccountRows: {
      scope: { serverId: workspace.serverId, accountId: 'account-1' },
      status: 'ready',
      coverage: 'complete',
      workspaceRefs: [
        {
          id: 'w1',
          serverId: workspace.serverId,
          machineId: 'm1',
          rootPath: '/repo',
          createdAtMs: 1,
          projectKey: 'w1',
        },
      ],
      relationships: [],
      organizations: shared.organizations,
      revisionsByPhysicalKey: {},
      ...(host.authoredSession ? { authoringSessionsByPhysicalKey: {
        [buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: workspace.serverId, id: 'w1' })]:
          { serverId: workspace.serverId, sessionId: host.authoredSession.id },
      } } : {}),
    },
  });
  const scripts = (
    <ProjectScriptsBody
      workspace={workspace}
      presentation={presentation}
      testID="scripts"
      outputScopeId={host.outputScopeId}
      onOpenScripts={host.onOpenScripts}
      onOpenServices={host.onOpenServices}
    />
  );
  const pageBody = host.registerPageBack
    ? <ProjectPageBackProvider value={host.registerPageBack}>{scripts}</ProjectPageBackProvider>
    : scripts;
  if (host.outputScopeId) terminalScopes.add(host.outputScopeId);
  const body = host.outputScopeId && host.terminalHost !== false
    ? <AppPaneProvider>{pageBody}</AppPaneProvider> : pageBody;
  const screen = await renderScreen(
    host.bottomPresentation ? (
      <AppPaneScopeLayoutProvider
        value={{
          arrangement: 'session', mainHidden: false, mainDrawerOpen: false, effectiveDetailsOpen: false, detailsAvailable: true,
          containerWidthPx: 1440,
          containerHeightPx: 600,
          mainRegionWidthPx: 1440,
          mainRegionHeightPx: 600,
          multiPaneEnabled: true,
          deviceType: 'tablet',
          layout: { main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' },
          bottomPresentation: host.bottomPresentation,
        }}
      >
        {body}
      </AppPaneScopeLayoutProvider>
    ) : body,
  );
  await vi.waitFor(
    () => {
      if (screen.findByTestId(ready)) return;
      const ids = screen
        .findAll((node) => typeof node.props?.testID === 'string')
        .map((node) => node.props.testID)
        .slice(0, 30)
        .join(', ');
      throw new Error(
        `${ready} not rendered; calls: ${shared.calls.map((call) => call.actionId).join(',')}; text: ${screen.getTextContent().slice(0, 200)}; ids: ${ids}`,
      );
    },
    { timeout: 5_000 },
  );
  return screen;
}

function textOf(
  screen: Awaited<ReturnType<typeof render>>,
  testID: string,
): string {
  const node = screen.findByTestId(testID);
  const collect = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : Array.isArray(value)
        ? value.map(collect).join('')
        : value && typeof value === 'object' && 'props' in value
          ? collect((value as { props: { children?: unknown } }).props.children)
          : '';
  return collect(node?.props.children);
}

describe('ProjectScriptsBody setup affordance', () => {
  it('reads only the selected native invocation when its row opens', async () => {
    isolateManifestDrafts();
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.script:test');
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect').map(call => call.input.read.kind)).toEqual(['scripts']);
    await screen.pressByTestIdAsync('scripts.script:test');
    await vi.waitFor(() => expect(shared.calls.filter(call => call.actionId === 'projects.inspect').map(call => call.input.read))
      .toContainEqual({ kind: 'detail', sources: [{ source: nativeRef('test'), usage: 'script' }] }));
  });

  it('revisits the Scripts list from its last-good read, resends no body while unchanged, keeps it across a bearer refresh, and forgets it when the Account leaves', async () => {
    isolateManifestDrafts();
    shared.inspection = { revision: 'r1', definition: presentDefinition(declared), detection, importCandidates: [] };
    const inspects = () => shared.calls.filter(call => call.actionId === 'projects.inspect' && call.input.read.kind === 'scripts');
    const first = await render('page', 'scripts.script:test');
    await first.unmount();
    // The revisit paints the retained list before any reply arrives.
    const reply = createDeferred<unknown>();
    shared.inspectionPending = reply.promise;
    const second = await render('page', 'scripts.script:test');
    reply.resolve(shared.inspection);
    await vi.waitFor(() => expect(shared.inspectionBytes).toHaveLength(2));
    expect(inspects().map(call => call.input.ifRevision)).toEqual([undefined, 'r1']);
    expect(shared.inspectionBytes[1]).toBeLessThan(64);
    expect(second.findByTestId('scripts.script:test')).toBeTruthy();
    await second.unmount();
    shared.inspectionPending = null;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const scope = { serverId: workspace.serverId };
    const credentials = await TokenStorage.getCredentialsForServerUrl(workspaceServerUrl, scope);
    if (!credentials) throw new Error('Expected the fixture Home credential');
    // A same-Account bearer refresh is a credential mutation, not an Account change: the list stays.
    const refreshed = { ...credentials, token: `${credentials.token.split('.').slice(0, 2).join('.')}.refreshed` };
    expect(await TokenStorage.setCredentialsForServerUrl(workspaceServerUrl, scope, refreshed)).toBe(true);
    const held = createDeferred<unknown>();
    shared.inspectionPending = held.promise;
    const third = await render('page', 'scripts.script:test');
    expect(third.findByTestId('scripts.script:test')).toBeTruthy();
    held.resolve(shared.inspection);
    await vi.waitFor(() => expect(inspects()).toHaveLength(3));
    expect(inspects()[2]!.input.ifRevision).toBe('r1');
    await third.unmount();
    shared.inspectionPending = null;
    // The Account leaving this Home (sign-out, then a sign-in) forgets it.
    expect(await TokenStorage.removeCredentialsForServerUrl(workspaceServerUrl, scope)).toBe(true);
    expect(await TokenStorage.setCredentialsForServerUrl(workspaceServerUrl, scope, refreshed)).toBe(true);
    await render('page', 'scripts.script:test');
    await vi.waitFor(() => expect(inspects()).toHaveLength(4));
    expect(inspects()[3]!.input.ifRevision).toBeUndefined();
  });

  it('pays for whole-project preselection only after explicit Create', async () => {
    isolateManifestDrafts();
    shared.inspection = { definition: { basis: { kind: 'absent' }, document: null }, detection,
      importCandidates: [{ source: nativeRef('test'), usage: 'script', availability: 'available', preselected: true }] };
    const screen = await render('page', 'scripts.create');
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect').map(call => call.input.read.kind)).toEqual(['scripts']);
    await screen.pressByTestIdAsync('scripts.create');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.script:test')).toBeTruthy());
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect').map(call => call.input.read.kind)).toEqual(['scripts', 'create']);
  });

  it('opens the author document without native discovery and reads compact imports only on disclosure', async () => {
    isolateManifestDrafts();
    shared.inspection = { definition: presentDefinition(declared), detection,
      importCandidates: [{ source: nativeRef('lint'), usage: 'script', availability: 'available', preselected: true }] };
    const screen = await render('page', 'scripts.edit');
    await screen.pressByTestIdAsync('scripts.edit');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor')).toBeTruthy());
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect').map(call => call.input.read.kind)).toEqual(['scripts', 'editor']);
    expect(screen.findByTestId('project-manifest-editor.found:0')).toBeNull();
    await screen.pressByTestIdAsync('project-manifest-editor.found.open');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found:0')).toBeTruthy());
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect').map(call => call.input.read.kind)).toEqual(['scripts', 'editor', 'imports']);
    await screen.pressByTestIdAsync('project-manifest-editor.found:0.details');
    await vi.waitFor(() => expect(shared.calls.filter(call => call.actionId === 'projects.inspect').map(call => call.input.read))
      .toContainEqual({ kind: 'detail', sources: [{ source: nativeRef('lint'), usage: 'script' }] }));
    await screen.pressByTestIdAsync('project-manifest-editor.found:0.details');
    expect(screen.findByTestId('project-manifest-editor.found:0.nativeDetail')).toBeNull();
    const detailReads = shared.calls.filter(call => call.actionId === 'projects.inspect' && call.input.read.kind === 'detail').length;
    await screen.pressByTestIdAsync('project-manifest-editor.found:0');
    expect(screen.findByTestId('project-manifest-editor.script:lint')).toBeTruthy();
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect' && call.input.read.kind === 'detail')).toHaveLength(detailReads);
  });

  it.each(['available', 'missing'] as const)('reserves cold authoring provenance and reads only its exact Session once per mount, with no idle reads (%s)', async availability => {
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const borrowers = countReadBorrowers(sessionParts.readSessionParts, params => params.sessionIds);
    const observeBorrowers = vi.spyOn(sessionParts, 'readSessionParts').mockImplementation(borrowers.request);
    onTestFinished(() => observeBorrowers.mockRestore());
    const response = createDeferred<Response>();
    const reads: string[] = [];
    const writes: string[] = [];
    const screen = await render('page', 'scripts.script:test', { authoredSession: { id: 'cold-author', response: response.promise, reads, writes } });
    expect(screen.findByTestId('project-setup-authored')).not.toBeNull();
    await vi.waitFor(() => expect(reads).toEqual(['cold-author']));
    await act(async () => {
      response.resolve(availability === 'missing' ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({
        id: 'cold-author', createdAt: 1, updatedAt: 2,
        metadata: { machineId: 'm1', path: '/repo', host: 'h', summary: { text: 'Checkout setup', updatedAt: 2 },
          work: { authoringOriginV1: { kind: 'project', accountId: 'account-1', workspace, page: 'scripts' } } },
      }))));
    });
    if (availability === 'available') {
      await vi.waitFor(() => expect(screen.getTextContent()).toContain('Checkout setup'));
      await vi.waitFor(() => expect(writes).toEqual(['cold-author']));
      expect(screen.findByTestId('project-setup-authored.changes')).not.toBeNull();
    } else {
      expect(writes).toEqual([]);
      expect(screen.getTextContent()).not.toContain('Checkout setup');
      expect(screen.findByTestId('project-setup-authored.changes')).toBeNull();
    }
    await act(async () => {
      storage.getState().applySessions([createSessionFixture({ id: 'unrelated', updatedAt: 100 })]);
    });
    expect(reads).toEqual(['cold-author']);
    vi.useFakeTimers();
    try { await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); }
    finally { vi.useRealTimers(); }
    expect(reads).toEqual(['cold-author']);
    expect(borrowers.read()).toEqual([expect.objectContaining({ calls: 1, idCount: 1,
      provenance: expect.arrayContaining([expect.objectContaining({
        source: 'apps/ui/sources/sync/engine/sessions/sessionByIdHttp.ts', method: 'readSessionByIdHttp',
      })]),
    })]);
    await screen.unmount();
    expect(reads).toEqual(['cold-author']);
  });

  it('offers Set up with an agent beside what was found when the checkout has no project file', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection,
      importCandidates: [],
    };
    const reviews: string[] = [];
    const screen = await render('widget', 'scripts.found', { onOpenScripts: () => reviews.push('scripts') });
    // The Overview widget summarizes what was found (lab p-overview HIDDEN): no runnable rows, no Run.
    expect(screen.getTextContent()).toContain('projects.widgets.scriptsFound');
    expect(screen.findByTestId('scripts.detected:0')).toBeNull();
    expect(screen.findByTestId('scripts.detected:0.run')).toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.review');
    });
    expect(reviews).toEqual(['scripts']);
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.setup');
    });
    expect(shared.navigate).toHaveBeenCalledWith({ pathname: '/new', params: { draftId: expect.any(String) } });
    const draftId = shared.navigate.mock.calls.at(-1)![0].params.draftId;
    expect(readNewSessionDraftFromRepository({ scope: { serverId: workspace.serverId, accountId: 'account-1' }, draftId }))
      .toMatchObject({ selectedMachineId: 'm1', selectedPath: '/repo', targetServerId: workspace.serverId });
  });

  it('says why the draft could not open with that reason\'s own words, beside the button', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.detected:0');
    expect(screen.findByTestId('scripts.setup.failure')).toBeNull();
    shared.failures['projects.inspect'] = { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.setup');
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.failure')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projects.authoring.refused');
  });

  it('shows a deferred authoring approval as pending rather than an invalid result', async () => {
    shared.inspection = { definition: { basis: { kind: 'absent' }, document: null }, detection, importCandidates: [] };
    shared.actionSettings['session.authoring.open'] = { approvalRequiredSurfaces: ['ui'] };
    const screen = await render('page', 'scripts.detected:0');
    await screen.pressByTestIdAsync('scripts.setup');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projects.authoring.pending'));
    expect(artifacts.list()).toHaveLength(1);
  });

  it('leaves a retired opening silent when it was aborted', async () => {
    shared.inspection = { definition: { basis: { kind: 'absent' }, document: null }, detection, importCandidates: [] };
    const screen = await render('page', 'scripts.detected:0');
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return connection?.credentials ?? null;
    });
    try {
      const opening = screen.pressByTestIdAsync('scripts.setup');
      await entered.promise;
      expect(screen.findByTestId('scripts.setup.failure')).toBeNull();
      await screen.unmount();
      release.resolve();
      await opening;
      expect(shared.navigate).not.toHaveBeenCalled();
    } finally { release.resolve(); credentialRead.mockRestore(); }
  });

  it('leads the Scripts page with the no-project-file hero, Create project file and its setup entry', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.detected:0');
    expect(screen.findByTestId('scripts.noProjectFile')).toBeTruthy();
    expect(screen.findByTestId('scripts.create')).toBeTruthy();
    expect(screen.findByTestId('scripts.setup')).toBeTruthy();
  });

  it.each([false, true])('expands 3,000 detected scripts with work proportional to the newly admitted page at 1,200–1,600 rows (project file: %s)', async (hasProjectFile) => {
    shared.inspection = {
      definition: hasProjectFile ? presentDefinition(declared) : { basis: { kind: 'absent' }, document: null },
      detection: { ...detection, entries: Array.from({ length: 3_000 }, (_, index) => ({
        source: nativeRef(`scale-${index}`), usage: 'script',
      })) },
      importCandidates: [],
    };
    const screen = await render('page', hasProjectFile ? 'scripts.found.header' : 'scripts.detected:0');
    if (hasProjectFile) await screen.pressByTestIdAsync('scripts.found.header');
    const showMore = hasProjectFile ? 'scripts.found.showMore' : 'scripts.detected.showMore';
    const rowInstances = () => screen.findAll(node => (!hasProjectFile && (node.type === DetectedRow || node.type === detectedRowRenderType))
      || (typeof node.type === 'function'
        && node.type.name === (hasProjectFile ? 'FoundNativeReferenceRow' : 'DetectedRow')));
    // Observe the normalized real inspection, after the Action boundary has parsed it.
    // Getters count actual row/domain reads without substituting any internal logic.
    const inspection = screen.findByType(ProjectScriptsContent).props.inspection as import('./useProjectDefinitionInspection').ProjectDefinitionInspection;
    let rowReads = 0;
    let sourceReads = 0;
    let inventoryReads = 0;
    for (const entry of inspection.detection.entries) {
      const { usage, source } = entry;
      Object.defineProperties(entry, {
        usage: { configurable: true, get: () => { rowReads += 1; return usage; } },
        source: { configurable: true, get: () => { sourceReads += 1; return source; } },
      });
    }
    const entries = inspection.detection.entries;
    Object.defineProperty(inspection.detection, 'entries', { configurable: true, value: new Proxy(entries, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) inventoryReads += 1;
        return Reflect.get(target, key, receiver);
      },
    }) });
    // Admission setup is not the measured interaction: batch the real button
    // presses so the fixture mounts 1,200 once instead of timing nine warm-up commits.
    await act(async () => {
      for (let rows = 120; rows < 1_200; rows += 120) screen.pressByTestId(showMore);
    });
    expect(rowInstances()).toHaveLength(1_200);
    let publications = 0;
    let storageChanges: string[][] = [];
    const stopStorage = storage.subscribe((state, previous) => {
      publications += 1;
      storageChanges.push(Object.keys(state).filter(key => !Object.is(state[key as keyof typeof state], previous[key as keyof typeof previous])));
    });
    const stopOperations = actionOperationStore.subscribe(() => { publications += 1; });
    onTestFinished(() => { stopStorage(); stopOperations(); });
    const samples: Array<{ before: number; after: number; rowReads: number; sourceReads: number; inventoryReads: number; mounts: number; publications: number; storageChanges: string[][] }> = [];
    for (let before = 1_200; before < 1_600; before += 120) {
      const retained = new Set(rowInstances());
      rowReads = 0; sourceReads = 0; inventoryReads = 0; publications = 0; storageChanges = [];
      await screen.pressByTestIdAsync(showMore);
      const rows = rowInstances();
      expect(rows).toHaveLength(before + 120);
      samples.push({ before, after: before + 120, rowReads, sourceReads, inventoryReads,
        mounts: rows.filter(row => !retained.has(row)).length, publications, storageChanges });
      expect(screen.findByTestId(`scripts.detected:${before + 119}`)).toBeTruthy();
    }
    console.info('SCRIPTSSCALE counts', JSON.stringify({ hasProjectFile, samples }));
    for (const sample of samples) {
      // One page plus the preceding last row whose divider must now continue.
      expect(sample.rowReads).toBeLessThanOrEqual(121);
      expect(sample.mounts).toBeLessThanOrEqual(120);
      expect(sample.inventoryReads).toBe(0);
    }
    expect(screen.getTextContent()).toContain('scale-1679');
  });

  it('builds the found file groups near the page viewport, not the whole admitted page (QA-BREADTH B6)', async () => {
    // 600 scripts in 120 package files (the 57k-file bed: 320 packages, 3-8 scripts each).
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection: { ...detection, entries: Array.from({ length: 600 }, (_, index) => ({
        source: { ...nativeRef(`script-${index}`), file: `packages/p${Math.floor(index / 5)}/package.json` }, usage: 'script',
      })) },
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.detected:0');
    const rowInstances = () => screen.findAll(node => node.type === DetectedRow || node.type === detectedRowRenderType);
    const mounted = rowInstances().length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(120);
    expect(screen.findAllByTestId('scripts.detected:119')).toHaveLength(0);
    // Nothing is dropped: all 24 file groups of the admitted page are in the list, far ones holding their place.
    expect(new Set(screen.findAll(node => /^scripts\.detected\.group:\d+$/.test(String(node.props?.testID))).map(node => node.props.testID)).size).toBe(24);
  });

  it('replaces Services navigation without rerendering 1,679 retained script rows', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection: { ...detection, entries: Array.from({ length: 3_000 }, (_, index) => ({
        source: nativeRef(`resize-${index}`), usage: index === 0 ? 'service' : 'script',
      })) },
      importCandidates: [],
    };
    let opened = '';
    const screen = await render('page', 'scripts.detected:0', { onOpenServices: () => { opened = 'first'; } });
    await screen.pressByTestIdAsync('scripts.detected:0');
    expect(opened).toBe('first');
    const rowInstances = () => screen.findAll(node => node.type === DetectedRow || node.type === detectedRowRenderType);
    const inspection = screen.findByType(ProjectScriptsContent).props.inspection as import('./useProjectDefinitionInspection').ProjectDefinitionInspection;
    let rowReads = 0;
    let inventoryReads = 0;
    // Keep the inventory's identity: observing it must not itself invalidate its index.
    inspection.detection.entries.forEach((entry, index, entries) => {
      const usage = entry.usage;
      Object.defineProperty(entry, 'usage', { configurable: true, get: () => { rowReads += 1; return usage; } });
      Object.defineProperty(entries, index, { configurable: true, get: () => { inventoryReads += 1; return entry; } });
    });
    await act(async () => {
      for (let rows = 120; rows < 1_680; rows += 120) screen.pressByTestId('scripts.detected.showMore');
    });
    const retained = new Set(rowInstances());
    expect(retained.size).toBe(1_680);
    rowReads = 0;
    inventoryReads = 0;
    await screen.update(<ProjectScriptsBody workspace={workspace} presentation="page" testID="scripts"
      onOpenServices={() => { opened = 'second'; }} />);
    await screen.pressByTestIdAsync('scripts.detected:0');
    expect(opened).toBe('second');
    const mounts = rowInstances().filter(row => !retained.has(row)).length;
    console.info('SCRIPTSSCALE callback replacement', JSON.stringify({ rowReads, inventoryReads, mounts }));
    expect(mounts).toBe(0);
    expect(inventoryReads).toBe(0);
    // Only the Service consumes its replacement navigation; Scripts keep their facts and identity.
    expect(rowReads).toBe(1);
    expect(screen.getTextContent()).toContain('resize-1679');
  });

  it('shows no authoring line on FirstRun for a checkout without an authoring relationship', async () => {
    shared.inspection = { definition: { basis: { kind: 'absent' }, document: null }, detection, importCandidates: [] };
    const screen = await render('page', 'scripts.noProjectFile');
    expect(screen.findByTestId('project-setup-authored')).toBeNull();
  });

  it('keeps FirstRun and its setup control while naming the Session that authored a checkout with no project file', async () => {
    shared.inspection = { definition: { basis: { kind: 'absent' }, document: null }, detection, importCandidates: [] };
    const reads: string[] = [];
    const writes: string[] = [];
    const response = createDeferred<Response>();
    const screen = await render('page', 'scripts.noProjectFile', { authoredSession: { id: 'first-run-author', response: response.promise, reads, writes } });
    // Unavailable Session: the line reserves its place but never invents a title or time.
    expect(screen.findByTestId('project-setup-authored')).not.toBeNull();
    expect(screen.findByTestId('scripts.setup')).toBeTruthy();
    expect(screen.findByTestId('scripts.create')).toBeTruthy();
    await act(async () => {
      response.resolve(Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({
        id: 'first-run-author', createdAt: 1, updatedAt: 2,
        metadata: { machineId: 'm1', path: '/repo', host: 'h', summary: { text: 'Set up happier', updatedAt: 2 },
          work: { authoringOriginV1: { kind: 'project', accountId: 'account-1', workspace, page: 'scripts' } } },
      }))));
    });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Set up happier'));
    await vi.waitFor(() => expect(writes).toEqual(['first-run-author']));
    expect(screen.getTextContent()).not.toMatch(/ready/i);
    expect(screen.findByTestId('scripts.setup')).toBeTruthy();
    expect(reads).toEqual(['first-run-author']);
  });

  it('says an empty checkout once: the Scripts page hero, not a second empty card under it', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection: { ...detection, entries: [] },
      importCandidates: [],
    };
    const page = await render('page', 'scripts.noProjectFile');
    expect(page.findByTestId('scripts.setup')).toBeTruthy();
    expect(page.getTextContent()).not.toContain('projects.widgets.scriptsEmpty');
    // A widget has no hero above it: the empty card is its one line.
    const widget = await render('widget', 'scripts.empty');
    expect(widget.getTextContent()).toContain('projects.widgets.scriptsEmpty');
  });

  it.each(['widget', 'rail'] as const)('preserves detected totals with a bounded %s inspection', async presentation => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection: { ...detection, entries: detection.entries.slice(0, 1) },
      importCandidates: [],
      detectionSummary: { total: 7, scripts: 7, services: 0, files: [{ file: 'package.json', total: 7, scripts: 7, services: 0 }] },
    };
    const screen = await render(presentation, presentation === 'widget' ? 'scripts.found' : 'scripts.detected:0');
    if (presentation === 'widget') {
      // The widget counts what was found in its summary instead of listing rows.
      expect(screen.getTextContent()).toContain('projects.widgets.scriptsFound');
      expect(screen.findByTestId('scripts.detected:0')).toBeNull();
    } else {
      expect(screen.findByTestId('scripts.detected.more')).toBeTruthy();
      expect(screen.findByTestId('scripts.detected:1')).toBeNull();
    }
    expect(shared.calls.find(call => call.actionId === 'projects.inspect')?.input.read).toEqual({
      kind: presentation === 'widget' ? 'overview' : 'rail', detectedRows: 3,
    });
  });

  it('does not invent an empty checkout when only setup references were detected', async () => {
    shared.inspection = {
      definition: { basis: { kind: 'absent' }, document: null },
      detection: { ...detection, entries: [] }, importCandidates: [],
      detectionSummary: { total: 0, scripts: 0, services: 0, files: [], sourceFiles: ['mise.toml'] },
    };
    const screen = await render('widget', 'scripts');
    await vi.waitFor(() => expect(screen.findByTestId('scripts.inspection')).toBeNull());
    expect(screen.findByTestId('scripts.empty')).toBeNull();
  });

  it('names each script\'s source file on the page and rail, but not in the narrow Overview widget', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    const page = await render('page', 'scripts.script:test');
    expect(page.getTextContent()).toContain('package.json');
    const rail = await render('rail', 'scripts.script:test');
    expect(rail.getTextContent()).toContain('package.json');
    const widget = await render('widget', 'scripts.script:test');
    expect(widget.getTextContent()).not.toContain('package.json');
    expect(widget.getTextContent()).toContain('test');
  });

  it('reads like its sibling widgets in the Overview: each script is a name and how it went, with no Run control', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    // The rail keeps its runnable rows.
    const rail = await render('rail', 'scripts.script:test');
    expect(rail.findByTestId('scripts.script:test.run')).toBeTruthy();
    await rail.unmount();
    const widget = await render('widget', 'scripts.script:test');
    expect(widget.findByTestId('scripts.script:test.run')).toBeNull();
    expect(widget.getTextContent()).toContain('projects.scripts.run.notRun');
    // How it went, said once on the row's one fact line.
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [operation('failed', 2) as never] });
    });
    await vi.waitFor(() => expect(widget.getTextContent()).not.toContain('projects.scripts.run.notRun'));
    expect(widget.findByTestId('scripts.script:test.run')).toBeNull();
  });

  it('keeps setup quiet once a project file declares the scripts', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    const screen = await render('widget', 'scripts.script:test');
    expect(screen.findByTestId('scripts.setup')).toBeNull();
  });

  it('says which Session last authored this checkout, and nothing for another checkout’s authoring', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.script:test');
    expect(screen.findByTestId('project-setup-authored')).toBeNull();
    const origin = (workspaceId: string, page: 'scripts' | 'changes' = 'scripts') => ({
      kind: 'project',
      accountId: 'account-1',
      page,
      workspace: { ...workspace, workspaceId },
    });
    // Sessions publish their authoring inputs through the store's own writer, so the line follows it.
    const authoringSession = (id: string, updatedAt: number, workspaceId: string, page: 'scripts' | 'changes' = 'scripts') =>
      createSessionFixture({
        id,
        updatedAt,
        metadata: {
          machineId: 'm1',
          path: '/repo',
          host: 'h',
          work: { authoringOriginV1: origin(workspaceId, page) },
        } as never,
      });
    await act(async () => {
      storage.getState().applySessions([
        // Explaining this checkout's changes is not authoring its project file.
        authoringSession('explain', 7, 'w1', 'changes'),
        authoringSession('other', 9, 'w2'),
      ]);
    });
    expect(screen.findByTestId('project-setup-authored')).toBeNull();
    await act(async () => {
      storage.getState().applySessions([authoringSession('setup', 5, 'w1')]);
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-setup-authored')).not.toBeNull(),
    );
  });
});

describe('ProjectScriptsBody runs', () => {
  it('keeps the first row pending while a second independent Run is admitted and settles', async () => {
    shared.inspection = { definition: presentDefinition({ version: 1, scripts: {
      test: { source: nativeRef('test') }, lint: { source: nativeRef('lint') },
    } }), detection, importCandidates: [] };
    const gate = createDeferred<{ operation: ActionOperationSnapshotV1 }>();
    shared.responses['projects.script.run'] = gate.promise;
    const screen = await render('page', 'scripts.script:test.run');
    try {
      await screen.pressByTestIdAsync('scripts.script:test.run');
      await vi.waitFor(() => expect(screen.findByTestId('scripts.script:test.run')?.props.disabled).toBe(true));
      shared.responses['projects.script.run'] = { operation: { ...operation('accepted', 1), operationId: 'op-lint' } };
      await screen.pressByTestIdAsync('scripts.script:lint.run');
      await vi.waitFor(() => expect(shared.calls.filter(call => call.actionId === 'projects.script.run')).toHaveLength(2));
      expect(screen.findByTestId('scripts.script:test.run')?.props.disabled).toBe(true);
      expect(screen.findByTestId('scripts.script:lint.run')?.props.disabled).toBe(false);
    } finally {
      await act(async () => { gate.resolve({ operation: operation('accepted', 1) }); });
    }
  });
  it('names a Run that waits on an approval and offers the one way to open it', async () => {
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    shared.responses['projects.script.run'] = {
      kind: 'approval_request_created', artifactId: 'approval-a', actionId: 'projects.script.run',
    };
    const screen = await render('page', 'scripts.script:test.run');
    await screen.pressByTestIdAsync('scripts.script:test.run');
    await vi.waitFor(() => expect(screen.findByTestId('scripts.approval')).toBeTruthy());
    expect(screen.getTextContent()).toContain('approvals.waitingForYou');
    expect(screen.findByTestId('scripts.approval.open')).toBeTruthy();
  });
  it('retains proven readiness during Script refresh and replaces it only with the inspection result', async () => {
    const manifest = { version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] }, scripts: { test: { source: nativeRef('test') } } };
    shared.inspection = { definition: presentDefinition(manifest), detection, importCandidates: [],
      setupReadiness: { kind: 'current', reviewedEffectDigest: 'current-effect', completedAtMs: 123 } };
    const screen = await render('page', 'scripts.setup');
    expect(screen.getTextContent()).toContain('projects.scripts.setup.readySince');
    // A Ready setup offers Run again, not a first Run.
    expect(textOf(screen, 'scripts.setup.run')).toContain('projects.scripts.setup.runAgain');
    const initialReads = shared.calls.filter(call => call.actionId === 'projects.inspect').length;
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...operation('accepted', 1), scope: { accountId: 'other-account', machineId: 'm1' } }] }));
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect')).toHaveLength(initialReads);
    let finish!: (value: unknown) => void;
    shared.inspectionPending = new Promise(resolve => { finish = resolve; });
    const accepted = operation('accepted', 1);
    if (accepted.domainRef?.kind !== 'projectCommand') throw new Error('Expected project command fixture');
    const scriptAttempt = { ...accepted, operationId: 'new-attempt' };
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [scriptAttempt] }));
    await vi.waitFor(() => expect(shared.calls.filter(call => call.actionId === 'projects.inspect').length).toBeGreaterThan(initialReads));
    expect(screen.getTextContent()).toContain('projects.scripts.setup.readySince');
    expect(textOf(screen, 'scripts.setup.run')).toContain('projects.scripts.setup.runAgain');
    expect(screen.findByTestId('scripts.script:test')).not.toBeNull();
    // A completed inspection is new evidence; retained readiness cannot hide a proven change.
    await act(async () => finish({ definition: presentDefinition(manifest), detection, importCandidates: [], setupReadiness: { kind: 'needsReview', code: 'project_setup_effect_changed' } }));
    await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('projects.scripts.setup.readySince'));
    expect(screen.getTextContent()).not.toContain('projects.scripts.run.waitsForSetup');
    shared.inspectionPending = null;
    const beforeProgress = shared.calls.filter(call => call.actionId === 'projects.inspect').length;
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...scriptAttempt, revision: 2, progress: { kind: 'indeterminate', label: 'new output' } }] }));
    expect(shared.calls.filter(call => call.actionId === 'projects.inspect')).toHaveLength(beforeProgress);
    await act(async () => actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...scriptAttempt, revision: 3, state: 'succeeded', settledAt: 2_000 }] }));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projects.scripts.setup.readySince'));
    shared.failures['projects.inspect'] = { ok: false, errorCode: 'project_definition_inspection_failed', error: 'project_definition_inspection_failed' };
    const beforeFailure = shared.calls.filter(call => call.actionId === 'projects.inspect').length;
    await act(async () => actionOperationStore.setMachineObservation({ serverId: workspace.serverId, machineId: workspace.machineId }, 'unavailable'));
    await vi.waitFor(() => expect(shared.calls.filter(call => call.actionId === 'projects.inspect').length).toBeGreaterThan(beforeFailure));
    await vi.waitFor(() => expect(screen.findByTestId('scripts.inspection-action')).not.toBeNull());
    expect(screen.findByTestId('scripts.script:test')).not.toBeNull();
    // A failed refresh keeps the last-good readiness at full strength; Retry is its freshness line.
    expect(screen.getTextContent()).toContain('projects.scripts.setup.readySince');
    expect(screen.findByTestId('scripts.inspection-action')).not.toBeNull();
    delete shared.failures['projects.inspect'];
    await act(async () => screen.pressByTestIdAsync('scripts.inspection-action'));
    await vi.waitFor(() => expect(screen.findByTestId('scripts.inspection-action')).toBeNull());
    expect(screen.findByTestId('scripts.script:test')).not.toBeNull();
  });
  it('uses current target readiness and never promotes historical setup completion to Ready', async () => {
    const manifest = {
      version: 1,
      workspace: { setup: [{ kind: 'command', command: 'echo setup' }] },
      scripts: { test: { source: nativeRef('test') } },
    };
    shared.inspection = {
      definition: presentDefinition(manifest),
      detection,
      importCandidates: [],
      setupReadiness: {
        kind: 'unknown',
        code: 'project_setup_requester_review_unavailable',
      },
    };
    const historical = operation('succeeded', 1);
    if (historical.domainRef?.kind !== 'projectCommand') throw new Error('Expected the Script fixture to retain its Project command');
    actionOperationStore.mergeSnapshots({
      serverId: workspace.serverId,
      snapshots: [
        {
          ...historical,
          actionId: 'projects.prepare',
          domainRef: {
            ...historical.domainRef,
            purpose: 'setup',
            script: undefined,
          },
        },
      ],
    });
    const screen = await render('page', 'scripts.setup');
    expect(screen.getTextContent()).not.toContain(
      'projects.scripts.setup.readySince',
    );
    // Setup says so once, from the producer's readiness; the script rows stay quiet.
    expect(screen.getTextContent()).toContain('projects.scripts.setup.stateUnknown');
    expect(screen.getTextContent()).not.toContain('projects.scripts.run.waitsForSetup');
    await screen.unmount();
    shared.inspection = {
      definition: presentDefinition(manifest),
      detection,
      importCandidates: [],
      setupReadiness: {
        kind: 'current',
        reviewedEffectDigest: 'current-effect',
        completedAtMs: 123,
      },
    };
    actionOperationStore.reset();
    const current = await render('page', 'scripts.setup');
    expect(current.getTextContent()).toContain(
      'projects.scripts.setup.readySince',
    );
    expect(current.getTextContent()).not.toContain(
      'projects.scripts.run.waitsForSetup',
    );
  });
  it('runs a declared script through projects.script.run and shows that operation’s own status', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection,
      importCandidates: [],
    };
    shared.responses['projects.script.run'] = {
      operation: operation('accepted', 1),
    };
    const screen = await render('page', 'scripts.script:test');
    expect(textOf(screen, 'scripts.script:test.status')).toContain(
      'projects.scripts.run.notRun',
    );
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.script:test.run');
    });
    expect(
      shared.calls.find((call) => call.actionId === 'projects.script.run')
        ?.input,
    ).toMatchObject({
      workspace,
      selection: { kind: 'named', name: 'test' },
    });
    await vi.waitFor(() =>
      expect(textOf(screen, 'scripts.script:test.status')).toContain(
        'projects.scripts.run.accepted',
      ),
    );
    await act(async () => {
      actionOperationStore.mergeSnapshots({
        serverId: workspace.serverId,
        snapshots: [operation('failed', 2) as never],
      });
    });
    await vi.waitFor(() =>
      expect(textOf(screen, 'scripts.script:test.status')).toContain(
        'projects.scripts.run.failed',
      ),
    );
  });

  it('names the worker in a late retained Script setup review without starting a different preparation', async () => {
    shared.inspection = {
      definition: presentDefinition({
        ...declared,
        workspace: { setup: [{ kind: 'command', command: 'yarn install' }] },
      }),
      detection,
      importCandidates: [],
    };
    const held: ActionOperationSnapshotV1 = {
      ...operation('accepted', 2),
      scope: { accountId: 'account-1', machineId: 'worker-machine' },
      domainRef: {
        kind: 'projectCommand', purpose: 'script', serverId: workspace.serverId,
        machineId: 'worker-machine', workspaceRefId: 'worker-checkout', cwd: '/worker/repo',
        sourceWorkspace: workspace, script: { name: 'test', source: nativeRef('test') },
      },
      setupReview: {
        kind: 'pendingApproval' as const,
        code: 'project_setup_consent_required',
        reviewedEffectDigest: 'a'.repeat(64),
        reviewedEffect: { commands: [{ source: { kind: 'command', command: 'yarn install' } }] },
      },
    };
    // Acceptance can arrive before the producer publishes its review hold.
    shared.responses['projects.script.run'] = {
      operation: operation('accepted', 1),
    };
    const screen = await render('page', 'scripts.script:test');
    expect(screen.findByTestId('scripts.setup.review')).toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.script:test.run');
      actionOperationStore.mergeSnapshots({
        serverId: workspace.serverId,
        snapshots: [held],
      });
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('scripts.setup.review')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('scripts.setup.review.effect:step:0'),
    ).toBeTruthy();
    expect(screen.getTextContent()).toContain('worker-machine');
    // The daemon holds the review until the person's trust write resumes it.
    shared.operationRead.mockImplementation(async () => ({
      kind: 'found',
      operation: shared.trustMutations.length > 0
        ? { ...held, revision: 3, setupReview: undefined }
        : held,
    }));
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.setup.review.scope:untilChanged');
    });
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.setup.review.run');
    });
    expect(
      shared.calls.filter((call) => call.actionId === 'projects.prepare'),
    ).toEqual([]);
    expect(
      shared.calls.filter((call) => call.actionId === 'projects.script.run'),
    ).toHaveLength(1);
    // "Until it changes" (chosen; This time is the default) is the person's own grant for this Project's exact effect.
    await vi.waitFor(() => expect(shared.trustMutations).toEqual([
      expect.objectContaining({
        project: { serverId: workspace.serverId, projectId: 'w1' },
        expectedRevision: 'absent',
        content: {
          t: 'plain',
          v: expect.objectContaining({ reviewedEffectDigest: 'a'.repeat(64) }),
        },
      }),
    ]));
  });

  it.each(['ask', 'fail'] as const)(
    'shows the no-worker refusal with the configured fallback offer (%s) and never falls back on its own',
    async (unavailable) => {
      shared.inspection = {
        definition: presentDefinition({
          version: 1,
          scripts: {
            test: { source: nativeRef('test'), execution: 'portable' },
          },
        }),
        detection,
        importCandidates: [],
      };
      shared.failures['projects.script.run'] = {
        ok: false,
        errorCode:
          unavailable === 'ask' ? 'choice_required' : 'no_available_machine',
        error:
          unavailable === 'ask' ? 'choice_required' : 'no_available_machine',
        details: {
          kind: 'no_worker_can_accept',
          unavailable,
          reason: 'no_available_machine',
        },
      };
      const screen = await render('page', 'scripts.script:test');
      expect(screen.findByTestId('scripts.script:test.noWorker')).toBeNull();
      await act(async () => {
        await screen.pressByTestIdAsync('scripts.script:test.run');
      });
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('scripts.script:test.noWorker'),
        ).toBeTruthy(),
      );
      const runs = () =>
        shared.calls.filter((call) => call.actionId === 'projects.script.run');
      // The refusal is reported; nothing reran on the primary checkout by itself.
      expect(runs()).toHaveLength(1);
      expect(
        screen.findByTestId('scripts.script:test.noWorker.dontRun'),
      ).toBeTruthy();
      if (unavailable === 'fail') {
        expect(
          screen.findByTestId('scripts.script:test.noWorker.runHere'),
        ).toBeNull();
        // "Don't run" puts the refusal away and runs nothing.
        await act(async () => {
          await screen.pressByTestIdAsync(
            'scripts.script:test.noWorker.dontRun',
          );
        });
        expect(screen.findByTestId('scripts.script:test.noWorker')).toBeNull();
        expect(runs()).toHaveLength(1);
        return;
      }
      delete shared.failures['projects.script.run'];
      await act(async () => {
        await screen.pressByTestIdAsync('scripts.script:test.noWorker.runHere');
      });
      await vi.waitFor(() => expect(runs()).toHaveLength(2));
      expect(runs()[1]?.input).toMatchObject({ choice: { kind: 'primary' } });
    },
  );

  it('offers to set up the missing worker copy through Sync and never retries the Run by itself', async () => {
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal' as never);
    shared.inspection = {
      definition: presentDefinition({ version: 1, scripts: { test: { source: nativeRef('test'), execution: 'portable' } } }),
      detection,
      importCandidates: [],
    };
    shared.failures['projects.script.run'] = {
      ok: false, errorCode: 'worker_copy_missing', error: 'worker_copy_missing',
      details: { kind: 'no_worker_can_accept', unavailable: 'fail', reason: 'worker_copy_missing',
        workerCopy: { serverId: workspace.serverId, sourceWorkspaceRefId: workspace.workspaceId,
          sourceMachineId: workspace.machineId, targetMachineId: 'm2' } },
    };
    const screen = await render('page', 'scripts.script:test');
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test.run'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.script:test.noWorker.setUpCopy')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test.noWorker.setUpCopy'); });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toMatchObject({ props: { options: { targetMachineId: 'm2', purpose: 'worker_clean_copy' } } });
    expect(shared.calls.filter((call) => call.actionId === 'projects.script.run')).toHaveLength(1);
  });

  it('reads what agents are told only once its disclosure is opened', async () => {
    shared.inspection = {
      definition: presentDefinition({ version: 1, scripts: { test: { source: nativeRef('test'), execution: 'portable' } } }),
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.script:test');
    await vi.waitFor(() => expect(screen.findAllByTestId('scripts.agents.guide').length).toBeGreaterThan(0));
    expect(screen.findByTestId('scripts.agents.guide.state')).toBeNull();
    expect(screen.findByTestId('scripts.agents.guide.text')).toBeNull();
    await act(async () => {
      screen.findAllByTestId('scripts.agents.guide').find((node) => typeof node.props.onExpandedChange === 'function')?.props.onExpandedChange(true);
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('scripts.agents.guide.state') ?? screen.findByTestId('scripts.agents.guide.text')).toBeTruthy(),
    );
  });

  it('adds a found script to the project file with one guarded write of its reference', async () => {
    // The Scripts query excludes references already declared in the project file.
    const found = { ...detection, entries: [{ source: nativeRef('lint'), usage: 'script' }] };
    shared.inspection = {
      definition: presentDefinition(declared),
      detection: found,
      importCandidates: [],
    };
    shared.responses['projects.manifest.update'] = {
      status: 'conflict',
      current: { basis: { kind: 'absent' }, document: null },
    };
    // Found scripts wait in one quiet line; the disclosure opens on press and the page stays short.
    const screen = await render('page', 'scripts.found.header');
    shared.inspection = { definition: { ...presentDefinition(declared, { futureAuthorField: { keep: true } }),
      basis: { kind: 'present', hash: 'b'.repeat(64) } }, detection: found, importCandidates: [] };
    expect(screen.findByTestId('scripts.detected:0.add')).toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.found.header');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('scripts.detected:0.add')).toBeTruthy(),
    );
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.detected:0.add');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    const editorReadIndex = shared.calls.findIndex(call => call.actionId === 'projects.inspect' && call.input.read?.kind === 'editor');
    expect(editorReadIndex).toBeGreaterThanOrEqual(0);
    expect(shared.calls.findIndex(call => call.actionId === 'projects.manifest.update')).toBeGreaterThan(editorReadIndex);
    expect(update?.input.expectedBasis).toEqual({ kind: 'present', hash: 'b'.repeat(64) });
    expect(JSON.parse(update?.input.bytes).futureAuthorField).toEqual({ keep: true });
    expect(JSON.parse(update?.input.bytes).scripts.lint).toEqual({
      source: nativeRef('lint'),
    });
    expect(JSON.parse(update?.input.bytes).scripts.test).toEqual({
      source: nativeRef('test'),
    });
  });
});

describe('ProjectScriptsBody project file editor', () => {
  beforeEach(isolateManifestDrafts);
  it.each([false, true])('preserves loaded sub-GB and fractional-GB memory demand and exact byte edits (phone=%s)', async phone => {
    shared.device = phone ? 'phone' : null;
    const initial = { version: 1, scripts: {
      test: { source: nativeRef('test'), memoryDemand: { bytes: 512 * 2 ** 20, basis: { kind: 'measured' } } },
      lint: { source: nativeRef('lint'), memoryDemand: { bytes: 1.5 * 2 ** 30, basis: { kind: 'declared' } } },
    } };
    shared.inspection = { definition: presentDefinition(initial), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    const first = phone ? 'project-manifest-editor.section:scripts:test' : 'project-manifest-editor.script:test';
    await vi.waitFor(() => expect(screen.findByTestId(first)).toBeTruthy());
    expect(screen.getTextContent()).toContain('512 MB');
    expect(screen.getTextContent()).toContain('1.5 GB');
    if (phone) await screen.pressByTestIdAsync(first);
    for (const [name, bytes, edited] of [['test', 512 * 2 ** 20, 1], ['lint', 1.5 * 2 ** 30, Number.MAX_SAFE_INTEGER]] as const) {
      await screen.pressByTestIdAsync(`project-manifest-editor.script:${name}`);
      const testID = `project-manifest-editor.script:${name}.memory`;
      await vi.waitFor(() => expect(screen.findByTestId(testID)).toBeTruthy());
      expect(screen.findByTestId(testID)?.props.value).toBe(String(bytes));
      await act(async () => { screen.findAllByTestId(testID)[0]?.props.onBlur?.(); });
      if (name === 'test') expect(screen.findByTestId('project-manifest-editor.save')?.props.disabled).toBe(true);
      await act(async () => { screen.changeTextByTestId(testID, String(edited)); });
      await act(async () => { screen.findAllByTestId(testID)[0]?.props.onBlur?.(); });
    }
    shared.responses['projects.manifest.update'] = { status: 'refused', code: 'write_failed' };
    await screen.pressByTestIdAsync('project-manifest-editor.save');
    const update = shared.calls.find(call => call.actionId === 'projects.manifest.update');
    const saved = JSON.parse(update?.input.bytes);
    expect(saved.scripts.test.memoryDemand).toEqual({ bytes: 1, basis: { kind: 'declared' } });
    expect(saved.scripts.lint.memoryDemand).toEqual({ bytes: Number.MAX_SAFE_INTEGER, basis: { kind: 'declared' } });
  });

  it('keeps the Form usable while reporting unrecognized keys, and saves through projects.manifest.update', async () => {
    shared.inspection = {
      definition: presentDefinition(declared, { sevices: {} }),
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-manifest-editor')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('project-manifest-editor.unknownKeys'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('project-manifest-editor.script:test'),
    ).toBeTruthy();
    await act(async () => {
      await screen.pressByTestIdAsync(
        'project-manifest-editor.script:test.execution:portable',
      );
    });
    shared.responses['projects.manifest.update'] = {
      status: 'refused',
      code: 'write_failed',
    };
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    const saved = JSON.parse(update?.input.bytes);
    expect(saved.scripts.test.execution).toBe('portable');
    // The unrecognized key is preserved; it confers nothing and is never dropped by a Form save.
    expect(saved.sevices).toEqual({});
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-manifest-editor.error')).toBeTruthy(),
    );
  });

  it('authors steps, scripts, the Devcontainer namespace and found references in the Form, then saves them in one guarded write', async () => {
    const devcontainer = { configPath: '.devcontainer/devcontainer.json' };
    shared.inspection = {
      definition: presentDefinition(
        {
          version: 1,
          workspace: {
            setup: [
              { kind: 'command', command: 'yarn install', futureStep: { keep: 1 } },
              { kind: 'command', command: 'yarn build', futureStep: { keep: 2 } },
            ],
          },
          scripts: {
            test: { source: nativeRef('test') },
            lint: { source: { kind: 'command', command: 'eslint .', futureSource: { keep: 'script' } } },
          },
          services: { web: { source: { kind: 'command', command: 'yarn dev', futureSource: { keep: 'service' } } } },
        },
        { sevices: {} },
      ),
      detection: { ...detection, devcontainers: [devcontainer] },
      importCandidates: [
        {
          source: nativeRef('test'),
          usage: 'script',
          availability: 'available',
          preselected: true,
        },
        {
          source: {
            kind: 'native',
            tool: 'just',
            file: 'justfile',
            target: 'fmt',
          },
          usage: 'script',
          availability: 'unavailable',
          code: 'tool_not_found',
          preselected: false,
        },
        {
          source: nativeRef('e2e'),
          usage: 'script',
          availability: 'available',
          preselected: false,
        },
      ],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-manifest-editor.step:1'),
      ).toBeTruthy(),
    );
    const commit = async (testID: string, value: string) => {
      await vi.waitFor(() => expect(screen.findByTestId(testID)).toBeTruthy());
      await act(async () => {
        screen.changeTextByTestId(testID, value);
      });
      await act(async () => {
        screen.findAllByTestId(testID)[0]?.props.onBlur?.();
      });
    };
    // Setup: edit a literal step, then move it first.
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.step:1');
    });
    await commit(
      'project-manifest-editor.step:1.command',
      'yarn build:protocol',
    );
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.step:1.moveUp');
    });
    // Scripts: rename in place and declare a memory need.
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:lint');
    });
    await commit('project-manifest-editor.script:lint.name', 'check');
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:check');
    });
    await commit('project-manifest-editor.script:check.command', 'eslint src');
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.service:web');
    });
    await commit('project-manifest-editor.service:web.command', 'yarn dev:web');
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:test');
    });
    await commit('project-manifest-editor.script:test.memory', String(8 * 2 ** 30));
    // The namespace is its own choice beside the toolchain.
    await act(async () => screen.findAllByTestId('project-manifest-editor.devcontainer')[0]?.props.onOpenChange(true));
    await vi.waitFor(() => expect(screen.findAllByTestId('project-manifest-editor.devcontainer')[0]?.props.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: JSON.stringify(devcontainer) })])));
    await act(async () => {
      screen
        .findAllByTestId('project-manifest-editor.devcontainer')[0]
        ?.props.onSelect(JSON.stringify(devcontainer));
    });
    // Found references: a missing tool stays visible and cannot be checked; an available one is added.
    await screen.pressByTestIdAsync('project-manifest-editor.found.open');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found:1')).toBeTruthy());
    expect(
      screen.findHostByTestId('project-manifest-editor.found:1')?.props.accessibilityState?.disabled,
      JSON.stringify(screen.findAllByTestId('project-manifest-editor.found:1').map(node => ({
        type: typeof node.type === 'string' ? node.type : 'component', disabled: node.props.disabled,
        accessibilityState: node.props.accessibilityState, ariaDisabled: node.props['aria-disabled'],
      }))),
    ).toBe(true);
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.found:2');
    });
    // Add a literal script.
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.addScript');
    });
    await act(async () => {
      screen.changeTextByTestId(
        'project-manifest-editor.addScript.name',
        'dev',
      );
      screen.changeTextByTestId(
        'project-manifest-editor.addScript.command',
        'yarn dev',
      );
    });
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.addScript.save');
    });
    shared.responses['projects.manifest.update'] = {
      status: 'refused',
      code: 'write_failed',
    };
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    expect(update?.input.expectedBasis).toEqual({ kind: 'present', hash });
    const saved = JSON.parse(update?.input.bytes);
    expect(saved.workspace.setup).toEqual([
      { kind: 'command', command: 'yarn build:protocol', futureStep: { keep: 2 } },
      { kind: 'command', command: 'yarn install', futureStep: { keep: 1 } },
    ]);
    expect(Object.keys(saved.scripts)).toEqual(['test', 'check', 'e2e', 'dev']);
    expect(saved.scripts.check).toEqual({
      source: { kind: 'command', command: 'eslint src', futureSource: { keep: 'script' } },
    });
    expect(saved.services.web.source).toEqual({ kind: 'command', command: 'yarn dev:web', futureSource: { keep: 'service' } });
    expect(saved.scripts.test.memoryDemand).toEqual({
      bytes: 8 * 2 ** 30,
      basis: { kind: 'declared' },
    });
    expect(saved.scripts.e2e).toEqual({ source: nativeRef('e2e') });
    expect(saved.scripts.dev).toEqual({
      source: { kind: 'command', command: 'yarn dev' },
    });
    expect(saved.devcontainer).toEqual(devcontainer);
    expect(saved.scripts.fmt).toBeUndefined();
    // Unknown content survives every Form edit.
    expect(saved.sevices).toEqual({});
  });

  it('removes a declaration from the Form and unchecks its found reference', async () => {
    shared.inspection = {
      definition: presentDefinition({
        version: 1,
        scripts: {
          test: { source: nativeRef('test') },
          lint: { source: nativeRef('lint') },
        },
      }),
      detection,
      importCandidates: [
        {
          source: nativeRef('test'),
          usage: 'script',
          availability: 'available',
          preselected: true,
        },
      ],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found.open')).toBeTruthy());
    await screen.pressByTestIdAsync('project-manifest-editor.found.open');
    await vi.waitFor(() =>
      expect(
        screen.findAllByTestId('project-manifest-editor.found:0')[0]?.props.selected,
      ).toBe(true),
    );
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.script:lint');
    });
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-manifest-editor.script:lint.remove'),
      ).toBeTruthy(),
    );
    await act(async () => {
      await screen.pressByTestIdAsync(
        'project-manifest-editor.script:lint.remove',
      );
    });
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.found:0');
    });
    expect(
      screen.findAllByTestId('project-manifest-editor.found:0')[0]?.props.selected,
    ).toBe(false);
    shared.responses['projects.manifest.update'] = {
      status: 'refused',
      code: 'write_failed',
    };
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    const update = shared.calls.find(
      (call) => call.actionId === 'projects.manifest.update',
    );
    expect(JSON.parse(update?.input.bytes).scripts).toEqual({});
  });

  it('imports a colliding native reference under an explicit name without replacing the existing declaration', async () => {
    shared.inspection = { definition: presentDefinition({ version: 1, scripts: { test: {
      source: { kind: 'command', command: 'echo original' }, future: { keep: true },
    } } }), detection, importCandidates: [{ source: nativeRef('test'), usage: 'script', availability: 'available', preselected: false },
      { source: nativeRef('missing'), usage: 'script', availability: 'unavailable', preselected: false }] };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found.open')).toBeTruthy());
    await screen.pressByTestIdAsync('project-manifest-editor.found.open');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found:0')).toBeTruthy());
    expect(screen.findByTestId('project-manifest-editor.found:0')?.props.disabled).not.toBe(true);
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.found:0'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found:0.name')).toBeTruthy());
    await act(async () => { screen.changeTextByTestId('project-manifest-editor.found:0.name', 'native-test'); });
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.found:0.save'); });
    expect(screen.findAllByTestId('project-manifest-editor.found:1')[0]?.props.disabled).toBe(true);
    shared.responses['projects.manifest.update'] = { status: 'refused', code: 'write_failed' };
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.save'); });
    const saved = JSON.parse(shared.calls.find(call => call.actionId === 'projects.manifest.update')?.input.bytes);
    expect(saved.scripts.test).toEqual({ source: { kind: 'command', command: 'echo original' }, future: { keep: true } });
    expect(saved.scripts['native-test']).toEqual({ source: nativeRef('test') });
    expect(saved.scripts.missing).toBeUndefined();
  });

  it('unchecks the first matching declaration and setup step while retaining later matches', async () => {
    const setup = nativeRef('install');
    shared.inspection = {
      definition: presentDefinition({ version: 1, scripts: {
        first: { source: nativeRef('test') }, second: { source: nativeRef('test') },
      }, workspace: { setup: [setup, setup] } }),
      detection: { ...detection, entries: [] },
      importCandidates: [
        { source: nativeRef('test'), usage: 'script', availability: 'available', preselected: false },
        { source: setup, usage: 'setup', availability: 'available', preselected: false },
      ],
    };
    const screen = await render('page', 'scripts.edit');
    await screen.pressByTestIdAsync('scripts.edit');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found.open')).toBeTruthy());
    await screen.pressByTestIdAsync('project-manifest-editor.found.open');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.found:0')).toBeTruthy());
    await screen.pressByTestIdAsync('project-manifest-editor.found:0');
    await screen.pressByTestIdAsync('project-manifest-editor.found:1');
    expect(screen.findAllByTestId('project-manifest-editor.found:0')[0]?.props.selected).toBe(true);
    expect(screen.findAllByTestId('project-manifest-editor.found:1')[0]?.props.selected).toBe(true);
    shared.responses['projects.manifest.update'] = { status: 'refused', code: 'write_failed' };
    await screen.pressByTestIdAsync('project-manifest-editor.save');
    const saved = JSON.parse(shared.calls.find(call => call.actionId === 'projects.manifest.update')?.input.bytes);
    expect(saved.scripts).toEqual({ second: { source: nativeRef('test') } });
    expect(saved.workspace.setup).toEqual([setup]);
  });

  it('sets the JSON view in the page column, in a page of its own that the code fills below the header', async () => {
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.mode:raw'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.raw')).toBeTruthy());
    const ancestors: Array<Record<string, unknown>> = [];
    for (let node = screen.findByTestId('project-manifest-editor.raw')?.parent; node; node = node.parent) ancestors.push(node.props);
    // The editor's own page list fills the pane (the code scrolls itself), and the code sits in the page column.
    expect(ancestors.some((props) => props.testID === 'project-manifest-editor.scroll' && props.fill === true)).toBe(true);
    expect(ancestors.some((props) => props.testID === 'project-manifest-editor.rawColumn')).toBe(true);
  });

  it.each(['{ "version": 1, ', '{"version":2}'])('opens an invalid project file in JSON, keeps its bytes and turns Form and Save off (%s)', async (bytes) => {
    shared.inspection = {
      definition: {
        basis: { kind: 'present', hash },
        document: readProjectManifestDocument(bytes),
      },
      detection,
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.invalid');
    if (bytes === '{"version":2}') expect(screen.getTextContent()).toContain('version: Use 1.');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.openEditor');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-manifest-editor.raw')).toBeTruthy(),
    );
    expect(
      screen.findByTestId('project-manifest-editor.code')?.props.value,
    ).toBe(bytes);
    expect(screen.findByTestId('project-manifest-editor.invalid')).toBeTruthy();
    if (bytes === '{"version":2}') {
      expect(screen.getTextContent()).toContain('version: Use 1.');
      expect(screen.getTextContent()).not.toContain('version: version:');
    }
    await act(async () => {
      await screen.pressByTestIdAsync('project-manifest-editor.save');
    });
    expect(
      shared.calls.some((call) => call.actionId === 'projects.manifest.update'),
    ).toBe(false);
  });
});

describe('ProjectScriptsBody setup row', () => {
  const withSetup = { ...declared, workspace: { setup: [{ kind: 'command', command: 'yarn install' }] } };
  function setupOperation(state: 'running' | 'failed') {
    return {
      version: 1, operationId: 'setup-1', revision: 1, actionId: 'projects.prepare', state,
      scope: { accountId: 'account-1', machineId: 'm1' }, title: 'projects.prepare', createdAt: 1_000, startedAt: 1_100,
      ...(state === 'failed' ? { settledAt: 2_000, error: { errorCode: 'process_settled', error: 'process_settled' } } : {}),
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: workspace.serverId, machineId: 'm1', workspaceRefId: 'w1',
        cwd: '/repo', sourceWorkspace: workspace, terminalId: 't-setup' },
      cancellation: 'supported',
    };
  }

  it('swaps Run again for Stop while setup runs and requests the real cancellation', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.setup');
    expect(screen.findByTestId('scripts.setup.run')).toBeTruthy();
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [setupOperation('running') as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.stop')).toBeTruthy());
    expect(screen.findByTestId('scripts.setup.run')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.stop'); });
    await vi.waitFor(() => expect(shared.calls.find((call) => call.actionId === 'action.operations.cancel')?.input)
      .toMatchObject({ operationId: 'setup-1' }));
  });

  it('keeps Stop on a compact setup row that is running when its disclosure is opened', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('widget', 'scripts.setup');
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [setupOperation('running') as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.stop')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    expect(screen.findByTestId('scripts.setup.stop')).toBeTruthy();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.stop'); });
    await vi.waitFor(() => expect(shared.calls.find((call) => call.actionId === 'action.operations.cancel')?.input)
      .toMatchObject({ operationId: 'setup-1' }));
  });

  it('opens the same setup review from a compact host and prepares from it', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('widget', 'scripts.setup');
    expect(screen.findByTestId('scripts.setup.review')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    shared.responses['projects.prepare'] = { kind: 'success', reviewedEffectDigest: 'a'.repeat(64) };
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.review.run'); });
    expect(shared.calls.find((call) => call.actionId === 'projects.prepare')?.input).toMatchObject({ workspace, phase: 'setup' });
  });

  it('says the Setup row waits for the person once its review is open, in the needs-you tone', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('widget', 'scripts.setup');
    expect(textOf(screen, 'scripts.setup')).not.toContain('projects.scripts.setup.pending');
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    expect(textOf(screen, 'scripts.setup')).toContain('projects.scripts.setup.pending');
    const row = screen.findAllByTestId('scripts.setup').find((node) => node.props.pressableStyle !== undefined);
    expect(row?.props.pressableStyle).toMatchObject({ backgroundColor: expect.any(String) });
  });

  it('names where the reviewed file came from without claiming it is committed', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.setup');
    const { error: _error, settledAt: _settledAt, ...held } = setupOperation('failed') as Record<string, unknown>;
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{
        ...held, state: 'accepted',
        setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'a'.repeat(64),
          reviewedEffect: { presentation: { bindings: [], provenance: {
            file: '.happier/project.json', kind: 'repository', headCommit: 'a41c9e2f00', branch: 'v0.3', fileState: 'modified' } } } },
      } as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review.provenance')).toBeTruthy());
    const text = textOf(screen, 'scripts.setup.review.provenance');
    expect(text).toContain('projects.scripts.setup.provenanceAtBranch');
    expect(text).toContain('projects.scripts.setup.provenanceModified');
  });

  it('states a committed reviewed file by its commit alone, without a commit-state suffix', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.setup');
    const { error: _error, settledAt: _settledAt, ...held } = setupOperation('failed') as Record<string, unknown>;
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{
        ...held, state: 'accepted',
        setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'a'.repeat(64),
          reviewedEffect: { presentation: { bindings: [], provenance: {
            file: '.happier/project.json', kind: 'repository', headCommit: 'a41c9e2f00', branch: 'v0.3', fileState: 'unknown',
            committed: { commit: 'a41c9e2f00' } } } } },
      } as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review.provenance')).toBeTruthy());
    const text = textOf(screen, 'scripts.setup.review.provenance');
    expect(text).toContain('projects.scripts.setup.provenanceAtBranch');
    expect(text).not.toContain('projects.scripts.setup.provenanceUnknown');
  });

  it('folds the Setup card back to its row once the held review is decided elsewhere', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const outputScopeId = `project:${encodeURIComponent(workspace.serverId)}:w1`;
    const screen = await render('page', 'scripts.setup', { outputScopeId });
    const expanded = () => screen.findByTestId('scripts.setup')?.props.accessibilityState?.expanded;
    const { error: _error, settledAt: _settledAt, ...held } = setupOperation('failed') as Record<string, unknown>;
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{
        ...held, state: 'accepted',
        setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'a'.repeat(64), reviewedEffect: {} },
      } as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    expect(expanded()).toBe(true);
    await act(async () => {
      const running = setupOperation('running');
      const { terminalId: _terminalId, ...domainRef } = running.domainRef;
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...running, domainRef, revision: 2 } as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeNull());
    await vi.waitFor(() => expect(expanded()).toBe(false));
  });

  it('keeps a failed setup’s output one press away, in the host’s bottom terminal', async () => {
    shared.inspection = { definition: presentDefinition(withSetup), detection, importCandidates: [] };
    const outputScopeId = `project:${encodeURIComponent(workspace.serverId)}:w1`;
    const screen = await render('page', 'scripts.setup', { outputScopeId });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [setupOperation('failed') as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.failed')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.openOutput'); });
    await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(outputScopeId)?.tabs
      .flatMap(tab => tab.terminals)).toContainEqual(expect.objectContaining({
        target: expect.objectContaining({ kind: 'terminal_view', terminalId: 't-setup', machineId: 'm1', cwd: '/repo' }),
      })));
  });
});

describe('ProjectScriptsBody output', () => {
  const outputScopeId = () => `project:${encodeURIComponent(workspace.serverId)}:w1`;
  const withTerminal = () => ({ ...operation('accepted', 1), domainRef: { ...operation('accepted', 1).domainRef, terminalId: 't1' } });

  it('opens a run’s output as its host’s bottom terminal tab, borrowing the same PTY, not a modal', async () => {
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show');
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('widget', 'scripts.script:test', { outputScopeId: outputScopeId() });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [withTerminal() as never] });
    });
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test'); });
    await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(outputScopeId())?.tabs
      .flatMap(tab => tab.terminals)).toContainEqual(expect.objectContaining({
        target: expect.objectContaining({ kind: 'terminal_view', machineId: 'm1', terminalId: 't1', terminalKey: 'project-command:t1', cwd: '/repo' }),
        title: 'test · tester.local',
      })));
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });

  it.each(['docked', 'overlay'] as const)('a Run never opens the output terminal by itself (%s)', async (bottomPresentation) => {
    // The row owns the running state (elapsed time, latest output line); the terminal opens only when the person asks.
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    shared.responses['projects.script.run'] = { operation: withTerminal() };
    const screen = await render('rail', 'scripts.script:test.run', { outputScopeId: outputScopeId(), bottomPresentation });

    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test.run'); });
    await vi.waitFor(() => expect(shared.calls.some((call) => call.actionId === 'projects.script.run')).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(readSessionTerminalWorkspaceForScope(outputScopeId())?.tabs ?? []).toEqual([]);
  });

  it('opens the operation detail where the host has no terminal or refuses the tab', async () => {
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal' as never);
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('widget', 'scripts.script:test', { outputScopeId: outputScopeId(), terminalHost: false });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [withTerminal() as never] });
    });
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test'); });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.calls[0]?.[0]).toMatchObject({ props: { serverId: workspace.serverId, operationId: 'op-1' } });
    show.mockRestore();
  });
});

describe('ProjectScriptsBody on a phone', () => {
  beforeEach(isolateManifestDrafts);
  it('lists the project file’s sections and pushes one in place, keeping the draft on Back', async () => {
    shared.device = 'phone';
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:scripts:test')).toBeTruthy());
    const footer = screen.findByTestId('project-manifest-editor.phoneActions');
    expect(footer).not.toBeNull();
    expect(footer?.findAllByProps({ testID: 'project-manifest-editor.save' }).length).toBeGreaterThan(0);
    expect(footer?.findAllByProps({ testID: 'project-manifest-editor.discard' }).length).toBeGreaterThan(0);
    expect(screen.findByTestId('project-manifest-editor.script:test')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.section:scripts:test'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.script:test')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.script:test.execution:portable'); });
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.sectionBack'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:scripts:test')).toBeTruthy());
    shared.responses['projects.manifest.update'] = { status: 'refused', code: 'write_failed' };
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.save'); });
    const update = shared.calls.find((call) => call.actionId === 'projects.manifest.update');
    expect(JSON.parse(update?.input.bytes).scripts.test.execution).toBe('portable');
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.discard'); });
    expect(screen.findByTestId('project-manifest-editor.save')?.props.disabled).toBe(true);
    expect(shared.calls.filter(call => call.actionId === 'projects.manifest.update')).toHaveLength(1);
  });

  it('hands its Back to the Project bar: one Back closes a pushed section, the next closes the editor', async () => {
    shared.device = 'phone';
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    let back: (() => void) | null = null;
    const screen = await render('page', 'scripts.edit', { registerPageBack: (next) => { back = next; } });
    expect(back).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:scripts:test')).toBeTruthy());
    expect(screen.findByTestId('project-manifest-editor.back')).toBeNull();
    expect(typeof back).toBe('function');
    await act(async () => { await screen.pressByTestIdAsync('project-manifest-editor.section:scripts:test'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.script:test')).toBeTruthy());
    expect(screen.findByTestId('project-manifest-editor.sectionBack')).toBeNull();
    await act(async () => { back?.(); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:scripts:test')).toBeTruthy());
    await act(async () => { back?.(); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.edit')).toBeTruthy());
    expect(back).toBeNull();
  });

  it('leaves the phone editor in one Back after Setup switches to JSON', async () => {
    shared.device = 'phone';
    shared.inspection = { definition: presentDefinition({ ...declared, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } }), detection, importCandidates: [] };
    let back: (() => void) | null = null;
    const screen = await render('page', 'scripts.edit', { registerPageBack: (next) => { back = next; } });
    await screen.pressByTestIdAsync('scripts.edit');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:setup')).toBeTruthy());
    await screen.pressByTestIdAsync('project-manifest-editor.section:setup');
    await screen.pressByTestIdAsync('project-manifest-editor.mode:raw');
    expect(screen.findAllByType('CodeEditor' as never)).toHaveLength(1);
    await act(async () => { back?.(); });
    expect(screen.findByTestId('project-manifest-editor')).toBeNull();
    expect(screen.findByTestId('scripts.edit')).toBeTruthy();
    expect(back).toBeNull();
  });

  it('loads tool availability only after opening the phone Environment section', async () => {
    shared.device = 'phone';
    const tool = (name: string, availability: 'available' | 'unavailable' | 'unresolved') =>
      ({ tool: name, file: '.mise.toml', availability, ...(availability === 'available' ? { version: '1.0.0' } : {}) });
    shared.inspection = {
      definition: presentDefinition({ version: 1, toolchain: { kind: 'toolchain', tool: 'mise', configPath: '.mise.toml' } }),
      detection, importCandidates: [], tools: [tool('node', 'available'), tool('protoc', 'unresolved')],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:toolchain')).toBeTruthy());
    expect(screen.findByTestId('project-manifest-editor.section:toolchain.tools')).toBeNull();
    await screen.pressByTestIdAsync('project-manifest-editor.section:toolchain');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.tool:node')).toBeTruthy());
    expect(textOf(screen, 'project-manifest-editor.tool:node')).toContain('projects.scripts.editor.toolAvailable');
    expect(textOf(screen, 'project-manifest-editor.tool:protoc')).toContain('projects.scripts.editor.toolUnresolved');
  });

  it('names a single tool\'s availability on the Machine under the phone Environment row', async () => {
    shared.device = 'phone';
    shared.inspection = {
      definition: presentDefinition({ version: 1, toolchain: { kind: 'toolchain', tool: 'devenv', configPath: 'devenv.nix' } }),
      detection, importCandidates: [], tools: [{ tool: 'devenv', file: 'devenv.nix', availability: 'available' }],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.section:toolchain')).toBeTruthy());
    await screen.pressByTestIdAsync('project-manifest-editor.section:toolchain');
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.tool:devenv')).toBeTruthy());
    expect(textOf(screen, 'project-manifest-editor.tool:devenv')).toContain('projects.scripts.editor.toolAvailable');
  });

  it('opens a run’s output in the operation detail, never a desktop terminal tab', async () => {
    shared.device = 'phone';
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'modal' as never);
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [] };
    const screen = await render('page', 'scripts.script:test', { outputScopeId: `project:${encodeURIComponent(workspace.serverId)}:w1` });
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{
        ...operation('accepted', 1), domainRef: { ...operation('accepted', 1).domainRef, terminalId: 't1' } } as never] });
    });
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:test'); });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(shared.calls.some((call) => call.actionId === 'session.terminals.open')).toBe(false);
    show.mockRestore();
  });
});

describe('ProjectScriptsBody setup review on a phone', () => {
  beforeEach(isolateManifestDrafts);
  const devenv = { kind: 'toolchain', tool: 'devenv', configPath: 'devenv.nix' } as const;
  const literal = { kind: 'command', command: 'devenv shell -- true' } as const;
  const hold = (): ActionOperationSnapshotV1 => ({
    ...operation('accepted', 2),
    domainRef: { kind: 'projectCommand', purpose: 'script', serverId: workspace.serverId, machineId: 'm1',
      workspaceRefId: 'w1', cwd: '/repo', sourceWorkspace: workspace, script: { name: 'verify', source: literal } },
    setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required',
      reviewedEffectDigest: hash, reviewedEffect: { commands: [{ source: literal }] } },
  });
  const present = () => {
    shared.device = 'phone';
    shared.inspection = {
      definition: presentDefinition({ version: 1, toolchain: devenv, scripts: { verify: { source: literal } } }),
      detection,
      importCandidates: [],
    };
    actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [hold()] });
  };

  it('keeps the Setup card to the waiting state and pushes the review as its own page with a pinned footer', async () => {
    present();
    let back: (() => void) | null = null;
    const screen = await render('page', 'scripts.setup.reviewEntry', { registerPageBack: (next) => { back = next; } });
    expect(textOf(screen, 'scripts.setup')).toContain('projects.scripts.toolchain.pending');
    // The decision is not made on the card: no review body, scope choice or Run beside the page's rows.
    expect(screen.findByTestId('scripts.setup.review')).toBeNull();
    expect(screen.findByTestId('scripts.setup.reviewPage')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewEntry'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.reviewPage')).toBeTruthy());
    expect(textOf(screen, 'scripts.setup.reviewPage.title')).toContain('projects.scripts.setup.review');
    expect(screen.findByTestId('scripts.setup.reviewPage.effect:step:0')).toBeTruthy();
    const footer = screen.findByTestId('scripts.setup.reviewPage.actions');
    expect(footer?.findAllByProps({ testID: 'scripts.setup.reviewPage.run' }).length).toBeGreaterThan(0);
    expect(footer?.findAllByProps({ testID: 'scripts.setup.reviewPage.notNow' }).length).toBeGreaterThan(0);
    // The Project bar's Back is the page's way out, and the choice made on the page survives it.
    expect(back).not.toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewPage.scope:untilChanged'); });
    await act(async () => { back?.(); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.reviewPage')).toBeNull());
    expect(back).toBeNull();
    expect(screen.findByTestId('scripts.setup.reviewEntry')).toBeTruthy();
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewEntry'); });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projects.scripts.setup.consequenceUntilChanged'));
  });

  it('decides on the page like the card does, and leaves the page once the review is decided', async () => {
    present();
    const screen = await render('page', 'scripts.setup.reviewEntry', { registerPageBack: () => {} });
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewEntry'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.reviewPage')).toBeTruthy());
    // A fresh read still sees the hold until the trust mutation is accepted.
    shared.operationRead.mockImplementation(async () => ({
      kind: 'found',
      operation: shared.trustMutations.length > 0
        ? { ...hold(), revision: 3, setupReview: undefined }
        : hold(),
    }));
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewPage.scope:untilChanged'); });
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewPage.run'); });
    await vi.waitFor(() => expect(shared.trustMutations).toEqual([expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({ reviewedEffectDigest: hash }) } })]));
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...hold(), revision: 3, setupReview: undefined, state: 'succeeded' } as never] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.reviewPage')).toBeNull());
  });

  it('keeps the scope picked on the phone page when the same review widens to the desktop card', async () => {
    present();
    let back: (() => void) | null = null;
    const screen = await render('page', 'scripts.setup.reviewEntry', { registerPageBack: (next) => { back = next; } });
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewEntry'); });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.reviewPage')).toBeTruthy());
    await act(async () => { await screen.pressByTestIdAsync('scripts.setup.reviewPage.scope:untilChanged'); });
    await act(async () => { back?.(); });
    shared.device = null;
    // The held review is touched again (a later revision), so the row re-reads the device class.
    await act(async () => {
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...hold(), revision: 3 }] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projects.scripts.setup.consequenceUntilChanged');
  });

  it('keeps the inline review where no pushed page exists: a desktop page and a compact host', async () => {
    present();
    shared.device = null;
    const screen = await render('page', 'scripts.setup.review');
    expect(screen.findByTestId('scripts.setup.reviewEntry')).toBeNull();
  });
});

describe('ProjectScriptsBody native previews and tools', () => {
  beforeEach(isolateManifestDrafts);
  const invocation = (args: string[], requestedVersion?: string) => ({
    tool: 'yarn',
    args,
    cwd: '/repo',
    ...(requestedVersion ? { requestedVersion } : {}),
  });

  it('keeps native row summaries compact and reveals the selected runner argv only on opening', async () => {
    shared.inspection = {
      definition: presentDefinition(declared),
      detection: { ...detection, entries: [{ source: nativeRef('lint'), usage: 'script' }] },
      importCandidates: [
        {
          source: nativeRef('lint'),
          usage: 'script',
          availability: 'unavailable',
          preselected: false,
          invocation: invocation(['lint'], '4.5.3'),
        },
      ],
      commands: [
        {
          name: 'test',
          usage: 'script',
          source: nativeRef('test'),
          availability: 'available',
          invocation: invocation(['test']),
        },
      ],
    };
    const screen = await render('page', 'scripts.script:test');
    expect(textOf(screen, 'scripts.script:test.status')).not.toContain('yarn test');
    await screen.pressByTestIdAsync('scripts.script:test');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('yarn test'));
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.found.header');
    });
    expect(screen.findByTestId('scripts.detected:0.nativeDetail')).toBeNull();
    await screen.pressByTestIdAsync('scripts.detected:0');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('yarn lint'));
  });

  it('shows installed tool versions only when inspection knows them, in the meta line and editor rows', async () => {
    const manifest = {
      ...declared,
      toolchain: {
        kind: 'toolchain',
        tool: 'mise',
        configPath: '.mise.toml',
      },
    };
    shared.inspection = {
      definition: presentDefinition(manifest),
      detection,
      importCandidates: [],
      tools: [
        {
          tool: 'node',
          file: '.mise.toml',
          requestedVersion: '22',
          availability: 'available',
          version: '22.11.0',
        },
        {
          tool: 'protoc',
          file: '.mise.toml',
          requestedVersion: '28.3',
          availability: 'unresolved',
        },
      ],
    };
    const screen = await render('page', 'scripts.edit');
    const header = screen.getTextContent();
    expect(header).toContain('node 22.11.0');
    // A requested version is intent, not an installed fact.
    expect(header).not.toContain('protoc 28.3');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.edit');
    });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.toolchain')).toBeTruthy());
    expect(screen.findByTestId('project-manifest-editor.tool:node')).toBeNull();
    await act(async () => screen.findAllByTestId('project-manifest-editor.toolchain')[0]?.props.onOpenChange(true));
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-manifest-editor.tool:node'),
      ).toBeTruthy(),
    );
    expect(
      screen.findByTestId('project-manifest-editor.tool:node.version')?.props
        .children,
    ).toBe('22.11.0');
    expect(
      screen.findByTestId('project-manifest-editor.tool:protoc'),
    ).toBeTruthy();
    expect(
      screen.findByTestId('project-manifest-editor.tool:protoc.version'),
    ).toBeNull();
  });
});

describe('ProjectScriptsBody native environment states (plan 24 copy)', () => {
  beforeEach(isolateManifestDrafts);
  const devenv = { kind: 'toolchain', tool: 'devenv', configPath: 'devenv.nix' } as const;
  const literal = { kind: 'command', command: 'devenv shell -- true' } as const;

  it.each([
    ['a selected native environment', devenv, 'projects.scripts.toolchain.unavailable'],
    ['the host environment', { kind: 'host' }, 'projects.scripts.run.refused'],
  ] as const)('reads a missing native tool for %s without leaking its raw code or its earlier output', async (_name, toolchain, expected) => {
    shared.inspection = {
      definition: presentDefinition({ version: 1, toolchain, scripts: { verify: { source: literal } } }),
      detection,
      importCandidates: [],
    };
    shared.failures['projects.script.run'] = { ok: false, errorCode: 'native_tool_unavailable', error: 'native_tool_unavailable' };
    const screen = await render('page', 'scripts.script:verify');
    await act(async () => { await screen.pressByTestIdAsync('scripts.script:verify.run'); });
    await vi.waitFor(() => expect(textOf(screen, 'scripts.script:verify.status')).toContain(expected));
    const status = textOf(screen, 'scripts.script:verify.status');
    expect(status.includes('projects.scripts.toolchain.noFallback')).toBe(expected.includes('toolchain'));
    // A refusal is the newest fact: the row does not stack a previous run's output under it.
    expect(screen.findByTestId('scripts.script:verify.noOutput')).toBeNull();
  });

  it('says a held review of a native environment waits for approval to evaluate it', async () => {
    shared.inspection = {
      definition: presentDefinition({ version: 1, toolchain: devenv, scripts: { verify: { source: literal } } }),
      detection,
      importCandidates: [],
    };
    const held: ActionOperationSnapshotV1 = {
      ...operation('accepted', 2),
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: workspace.serverId, machineId: 'm1',
        workspaceRefId: 'w1', cwd: '/repo', sourceWorkspace: workspace, script: { name: 'verify', source: literal } },
      setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required', reviewedEffectDigest: hash, reviewedEffect: {} },
    };
    shared.responses['projects.script.run'] = { operation: operation('accepted', 1) };
    const screen = await render('page', 'scripts.script:verify');
    await act(async () => {
      await screen.pressByTestIdAsync('scripts.script:verify.run');
      actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [held] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projects.scripts.toolchain.pending');
    expect(screen.getTextContent()).not.toContain('projects.scripts.setup.pending');
  });

  it('shows a review held by a Script run as the Setup card, and every row waits for it', async () => {
    shared.inspection = {
      definition: presentDefinition({ version: 1, toolchain: devenv, scripts: { verify: { source: literal }, lint: { source: literal } } }),
      detection,
      importCandidates: [],
    };
    // The Run came from before this page loaded (a reload, or another client): nothing here started it.
    const held: ActionOperationSnapshotV1 = {
      ...operation('accepted', 2),
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: workspace.serverId, machineId: 'm1',
        workspaceRefId: 'w1', cwd: '/repo', sourceWorkspace: workspace, script: { name: 'verify', source: literal } },
      setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required', reviewedEffectDigest: hash, reviewedEffect: {} },
    };
    actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [held] });
    const screen = await render('page', 'scripts.script:verify');
    await vi.waitFor(() => expect(screen.findByTestId('scripts.setup.review')).toBeTruthy());
    expect(textOf(screen, 'scripts.setup')).toContain('projects.scripts.toolchain.pending');
    // The approval is decided once, on the Setup card; the rows only say what they wait for.
    expect(textOf(screen, 'scripts.script:verify.status')).toContain('projects.scripts.run.waitsForSetup');
    expect(textOf(screen, 'scripts.script:verify.status')).not.toContain('projects.scripts.toolchain.pending');
    expect(textOf(screen, 'scripts.script:lint.status')).toContain('projects.scripts.run.waitsForSetup');
  });

  const partialInspection = (diagnostics: { file: string; code: string }[]) => ({
    definition: presentDefinition({ version: 1, toolchain: devenv, scripts: { verify: { source: literal } } }),
    detection: { ...detection, coverage: 'partial', diagnostics },
    importCandidates: [],
  });

  it('reads unevaluated Nix as a fact about the environment, not as a failed read with a Retry', async () => {
    shared.inspection = partialInspection([{ file: 'devenv.nix', code: 'unevaluated_nix' }]);
    const screen = await render('page', 'scripts.script:verify');
    expect(screen.getTextContent()).toContain('projects.scripts.toolchain.unevaluated');
    expect(screen.getTextContent()).not.toContain('projects.scripts.definition.partial');
    expect(screen.findByTestId('scripts.partial')).toBeNull();
  });

  it('still reports a definition that could not be read next to the unevaluated Nix fact', async () => {
    shared.inspection = partialInspection([{ file: 'devenv.nix', code: 'unevaluated_nix' }, { file: 'Makefile', code: 'unreadable' }]);
    const screen = await render('page', 'scripts.script:verify');
    expect(screen.getTextContent()).toContain('projects.scripts.definition.partial');
    expect(screen.findAllByTestId('scripts.partial').some((node) => JSON.stringify(node.props.details) === '["Makefile: unreadable"]')).toBe(true);
    expect(screen.getTextContent()).toContain('projects.scripts.toolchain.unevaluated');
  });

  it('shows checking only while an opened toolchain inspection is pending', async () => {
    shared.inspection = {
      definition: presentDefinition({ version: 1, toolchain: devenv }),
      detection: { ...detection, toolchains: [devenv] },
      importCandidates: [],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.toolchain')).toBeTruthy());
    expect(screen.findByTestId('project-manifest-editor.toolchain.checking')).toBeNull();
    const pending = createDeferred<unknown>();
    shared.inspectionPending = pending.promise;
    await act(async () => screen.findAllByTestId('project-manifest-editor.toolchain')[0]?.props.onOpenChange(true));
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.toolchain.checking')).toBeTruthy());
    await act(async () => pending.resolve(shared.inspection));
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.toolchain.checking')).toBeNull());
  });

  it('keeps the host as the explicit default when nothing native was detected', async () => {
    shared.inspection = {
      definition: presentDefinition({ version: 1, scripts: { test: { source: nativeRef('test') } } }),
      detection,
      importCandidates: [],
      tools: [],
    };
    const screen = await render('page', 'scripts.edit');
    await act(async () => { await screen.pressByTestIdAsync('scripts.edit'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-manifest-editor.toolchain')).toBeTruthy());
    expect(screen.getTextContent()).not.toContain('projects.scripts.toolchain.empty');
    await act(async () => screen.findAllByTestId('project-manifest-editor.toolchain')[0]?.props.onOpenChange(true));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projects.scripts.toolchain.empty'));
    expect(screen.findByTestId('project-manifest-editor.toolchain.checking')).toBeNull();
  });
});

describe('ProjectScriptsBody with thousands of found scripts', () => {
  beforeEach(isolateManifestDrafts);
  it.each([false, true])('refreshes a changed native inventory while retaining the unchanged row (project file: %s)', async hasProjectFile => {
    const initial = { definition: hasProjectFile ? presentDefinition({ version: 1, scripts: {} }) : { basis: { kind: 'absent' }, document: null },
      detection, importCandidates: [] };
    shared.inspection = initial;
    const screen = await render('page', hasProjectFile ? 'scripts.found.header' : 'scripts.detected:0', { onOpenServices: () => {} });
    if (hasProjectFile) await screen.pressByTestIdAsync('scripts.found.header');
    expect(screen.findByTestId('scripts.services.open')).toBeNull();
    const retained = screen.findByTestId('scripts.detected:1');
    expect(retained).not.toBeNull();
    shared.inspection = { ...initial, detection: { ...detection, entries: [
      { source: nativeRef('changed-native-target'), usage: 'script' }, detection.entries[1],
      { source: nativeRef('new-service'), usage: 'service' },
    ] } };
    // The real operation producer wakes the mounted inspection reader, as a Run settling does live.
    await act(async () => { actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [operation('succeeded', 1)] }); });
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('changed-native-target'));
    expect(screen.findByTestId('scripts.services.open')).not.toBeNull();
    expect(screen.findByTestId('scripts.detected:1')).toBe(retained);
  });

  // happier-dev with no project file: about 6,230 scripts across a few hundred package.json files.
  function scaled(count: number, files: number) {
    const sources = Array.from({ length: count }, (_, index) => ({
      kind: 'native', tool: 'package_script', file: `packages/p${index % files}/package.json`, target: `script-${index}`,
    } as const));
    return {
      sources,
      detection: { ...detection, entries: sources.map(source => ({ source, usage: 'script' })) },
      importCandidates: sources.map(source => ({ source, usage: 'script', availability: 'available', preselected: true,
        invocation: { tool: 'yarn', args: [source.target], cwd: '/repo' } })),
    };
  }
  const mountedRows = (screen: Awaited<ReturnType<typeof render>>, prefix: string) => new Set(screen
    .findAll(node => typeof node.props?.testID === 'string' && new RegExp(`^${prefix}:\\d+$`).test(node.props.testID))
    .map(node => node.props.testID as string)).size;

  it('opens the no-project-file page with a bounded set of mounted rows and every script one Show more away', async () => {
    const found = scaled(6_230, 300);
    shared.inspection = { definition: { basis: { kind: 'absent' }, document: null }, detection: found.detection, importCandidates: found.importCandidates };
    const screen = await render('page', 'scripts.detected:0');
    const opened = mountedRows(screen, 'scripts.detected');
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThanOrEqual(200);
    expect(screen.findByTestId('scripts.detected.showMore')).not.toBeNull();
    const admittedGroups = () => mountedRows(screen, 'scripts.detected.group');
    const groupsBefore = admittedGroups();
    await act(async () => { await screen.pressByTestIdAsync('scripts.detected.showMore'); });
    // Show more admits the next page into the list; what mounts stays bounded by the viewport (B6).
    expect(admittedGroups()).toBeGreaterThan(groupsBefore);
    expect(mountedRows(screen, 'scripts.detected')).toBeLessThanOrEqual(200);
  });

  it('reaches the last found script through Show more, without dropping any', async () => {
    const found = scaled(230, 3);
    shared.inspection = { definition: { basis: { kind: 'absent' }, document: null }, detection: found.detection, importCandidates: found.importCandidates };
    const screen = await render('page', 'scripts.detected:0');
    for (let press = 0; press < 20 && screen.findByTestId('scripts.detected.showMore'); press += 1)
      await act(async () => { await screen.pressByTestIdAsync('scripts.detected.showMore'); });
    expect(screen.findByTestId('scripts.detected.showMore')).toBeNull();
    // Every script is admitted: each file's group is in the list, built near the viewport or holding its
    // rows' height until scrolled to (B6), so none is dropped and none is a page away.
    expect(mountedRows(screen, 'scripts.detected.group')).toBe(3);
    const { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } = await import('@/components/ui/lists/pageRowMetrics');
    const heldRows = screen.findAll(node => /^scripts\.detected\.group:\d+$/.test(String(node.props?.testID)) && typeof node.type === 'string')
      .reduce((sum, node) => sum + Math.round(Number((node.props.style as { height?: number } | undefined)?.height ?? 0) / PAGE_ROW_TOUCH_MIN_HEIGHT_PX), 0);
    expect(mountedRows(screen, 'scripts.detected') + heldRows).toBe(230);
  });

  it('keeps the found disclosure beside a project file bounded the same way', async () => {
    const found = scaled(2_000, 80);
    shared.inspection = { definition: presentDefinition(declared), detection: { ...found.detection,
      entries: [detection.entries[1], ...found.detection.entries] }, importCandidates: found.importCandidates };
    const screen = await render('page', 'scripts.found.header');
    await act(async () => { await screen.pressByTestIdAsync('scripts.found.header'); });
    const opened = mountedRows(screen, 'scripts.detected');
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThanOrEqual(200);
    await act(async () => { await screen.pressByTestIdAsync('scripts.found.showMore'); });
    expect(mountedRows(screen, 'scripts.detected')).toBeGreaterThan(opened);
  });
});

describe('Project setup layers on the Scripts page (plan A L6)', () => {
  it('lists the scripts that run from every layer and names where each non-repository one comes from', async () => {
    const effectiveManifest = { version: 1, scripts: {
      test: { source: nativeRef('test') },
      seed: { source: { kind: 'command', command: './scripts/seed-dev.sh' } },
      lint: { source: nativeRef('lint') },
    } };
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [],
      effectiveDefinition: { effectiveManifest,
        sharedBasis: { sourceId: 'src-acme-web', contentRevision: { headerVersion: 1, bodyVersion: 3 }, digest: hash },
        origins: [
          { path: ['scripts', 'test'], layer: 'repository', overridden: false },
          { path: ['scripts', 'seed'], layer: 'shared', overridden: false },
          { path: ['scripts', 'lint'], layer: 'personal', overridden: false },
        ] } };
    const screen = await render('page', 'scripts.script:seed');
    // The Machine runs the composed definition, so the page lists what runs, not only the repository file.
    expect(textOf(screen, 'scripts.script:test.status')).not.toContain('projects.scripts.origin');
    expect(textOf(screen, 'scripts.script:seed.status')).toContain('projects.scripts.origin.shared');
    expect(textOf(screen, 'scripts.script:lint.status')).toContain('projects.scripts.origin.personal');
    expect(screen.getTextContent()).toContain('projects.scripts.layers.personal');
  });
  it('offers the shared setup update check only when a shared setup is attached, and reads nothing upstream before it', async () => {
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'shared-setup-update');
    onTestFinished(() => { show.mockRestore(); });
    const origins = [{ path: ['scripts', 'test'], layer: 'repository', overridden: false }];
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [],
      effectiveDefinition: { effectiveManifest: declared, origins } };
    const plain = await render('page', 'scripts.script:test');
    expect(plain.findAllHostsByTestId('scripts.more')).toHaveLength(0);
    await plain.unmount();
    shared.inspection = { definition: presentDefinition(declared), detection, importCandidates: [],
      effectiveDefinition: { effectiveManifest: declared, origins,
        sharedBasis: { sourceId: 'src-acme-web', contentRevision: { headerVersion: 1, bodyVersion: 3 }, digest: hash } } };
    const screen = await render('page', 'scripts.more');
    expect(shared.calls.some(call => call.actionId === 'projects.inspect'
      && (call.input as { reviewSharedSetup?: unknown }).reviewSharedSetup !== undefined)).toBe(false);
    await act(async () => { await screen.pressByTestIdAsync('scripts.more'); });
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'scripts.more:menu')!;
    expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['checkShared']);
    await act(async () => { menu.props.onSelect('checkShared'); });
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      props: expect.objectContaining({ sourceId: 'src-acme-web' }),
      chrome: expect.objectContaining({ testID: 'project-shared-setup-update' }) }));
  });
});
