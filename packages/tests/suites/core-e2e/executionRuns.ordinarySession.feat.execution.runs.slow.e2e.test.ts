import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceAddressV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { findMachineAgentInventoryItemForTargetV1, MachinesAgentsListOutputSchema } from '@happier-dev/protocol/capabilities/machineAgentInventory';

import { connectSessionMcpClient, readSessionMcpContextFromEnvironment } from '../../../../apps/cli/src/mcp/runtime/sessionMcpLocalClient';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { buildTestAccountCliAuthCredentials } from '../../src/testkit/cliAuth';
import {
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  createConnectedServiceProfile,
  spawnConnectedClaudeSession,
  startConnectedServiceRecoveryTokenServer,
  startConnectedServicesClaudeDaemon,
  type ConnectedServiceRecoveryTokenServer,
  type StartedConnectedServicesClaudeDaemonFixture,
} from '../../src/testkit/connectedServicesRecovery';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { resolveMachineIdsFromSettings } from '../../src/testkit/providers/scenarios/runtimeHelpers';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { waitForSessionActive } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { waitFor } from '../../src/testkit/timing';
import { initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';

const run = createRunDirs({ runLabel: 'core' });
let fixture: StartedConnectedServicesClaudeDaemonFixture | undefined;
let vendor: ConnectedServiceRecoveryTokenServer | undefined;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let nativeMcp: Awaited<ReturnType<typeof connectSessionMcpClient>> | undefined;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

async function nativeAction(actionId: string, input: Record<string, unknown>) {
  if (!nativeMcp) throw new Error('Native Session MCP is not connected');
  const response = await nativeMcp.client.callTool({ name: 'action_execute', arguments: { actionId, input } });
  const content = response.content;
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Missing MCP result');
  const result: unknown = JSON.parse(content[0].text);
  expect(response.isError, JSON.stringify(result)).not.toBe(true);
  return object(result);
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of [() => nativeMcp?.close(), () => ui?.close(),
    () => fixture?.daemon.stop(), () => fixture?.homeRequests?.stop(),
    () => fixture?.server.stop(), () => vendor?.stop()]) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors,
    `Ordinary Session cleanup failed: ${errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`);
}, 60_000);

// A source-driven ordinary Session: Home, daemon, runner and UI admission are
// real. Only Claude and its OAuth endpoint are vendor boundary substitutes.
it('starts selected-auth work once and delivers approved Project output to the ordinary Session', async () => {
  const testDir = run.testDir(`execution-runs-ordinary-session-${randomUUID()}`);
  // Explicit source entrypoints consume the canonical authored workspace exports.
  const sourceNodeOptions = [process.env.NODE_OPTIONS, '--import',
    pathToFileURL(resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href,
  ].filter(Boolean).join(' ');
  const vendorAccountId = randomUUID();
  const vendorOrganizationId = randomUUID();
  vendor = await startConnectedServiceRecoveryTokenServer({ respond: request => request.path === '/api/oauth/profile'
    ? { status: 200, body: { account: { uuid: vendorAccountId, email_address: 'ordinary-session@example.test', has_claude_max: true },
      organization: { uuid: vendorOrganizationId, organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } } }
    : ({ status: 200, body: {
    access_token: 'ordinary-session-access', refresh_token: 'ordinary-session-refresh',
    expires_in: 3600, token_type: 'Bearer', scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
  } }) });
  fixture = await startConnectedServicesClaudeDaemon({
    testDir, testName: 'execution-runs-ordinary-session', tokenUrl: vendor.tokenUrl,
    fakeClaudePath: fakeClaudeFixturePath(), fakeClaudeLogPath: resolve(testDir, 'fake-claude.jsonl'),
    // This suite uses both source entrypoints; package builds belong to lane preparation.
    serverExtraEnv: { HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1', NODE_OPTIONS: sourceNodeOptions },
    terminalCredential: true,
    fakeClaudeScenario: 'delegate-json', accountSettings: { claudeUnifiedTerminalEnabled: false,
      actionsSettingsV1: { v: 1, actions: { 'projects.script.run': { enabled: true, disabledSurfaces: [],
        disabledPlacements: [], approvalRequiredSurfaces: ['agent'] } } } }, recordHomeRequests: true,
    extraEnv: { NODE_OPTIONS: `${sourceNodeOptions} --import ${pathToFileURL(resolve(repoRootDir(), 'packages/tests/src/fixtures/fake-claude-oauth-profile.mjs')).href}`, HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1', HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
      HAPPIER_E2E_FAKE_CLAUDE_NATIVE_SIGNED_OUT: '1' },
  });
  await createConnectedServiceProfile({ fixture, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
    profileId: 'selected', qualifiedCredential: true, providerEmail: 'ordinary-session@example.test',
    providerAccountId: vendorAccountId,
    accessToken: 'ordinary-session-access', refreshToken: 'ordinary-session-refresh',
    scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer', idToken: null,
  });
  const credentials = buildTestAccountCliAuthCredentials({ auth: fixture.auth, mode: 'legacy' });
  ui = await connectUiActionClient({ serverUrl: fixture.serverBaseUrl, credentials });
  const { serverId, execute } = ui;
  await waitFor(() => ui!.isAccountReady(), { timeoutMs: 60_000 }).catch(error => {
    const requests = fixture?.homeRequests?.entries().map(({ method, path, statusCode }) => ({ method, path, statusCode }));
    throw new Error(`UI Account scope did not become available; Home requests=${JSON.stringify(requests)}`, { cause: error });
  });
  const ownerContext = { surface: 'ui' as const, authority: 'present_user' as const,
    serverId, actionCaller: { kind: 'host' as const } };
  const [machineId] = await resolveMachineIdsFromSettings({ settingsPath: resolve(fixture.daemonHomeDir, 'settings.json'), timeoutMs: 30_000 });
  expect(machineId).toEqual(expect.any(String));
  // Control-port startup precedes the daemon's authenticated Home connection.
  await waitFor(() => ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
  await initGitRepo({ repoDir: fixture.workspaceDir });
  await writeFile(resolve(fixture.workspaceDir, 'Makefile'), '.PHONY: keeper\nkeeper:\n\t@echo L12_KEEPER_SCRIPT\n\t@echo completed >> keeper-result.txt\n');

  const sessionId = await spawnConnectedClaudeSession({ fixture, sessionId: randomUUID(), profileId: 'selected' });
  await waitForSessionActive({ baseUrl: fixture.serverBaseUrl, token: fixture.auth.token, sessionId, timeoutMs: 60_000 });
  // The real send owner acquires a cold Session by ID; an unopened Session need
  // not have a full detail carrier in the UI store.
  const context = { ...ownerContext, defaultSessionId: sessionId };
  expect(await execute('session.message.send', { sessionId, message: 'Ordinary Session ready.' }, context)).toMatchObject({ ok: true });
  const invocation = await waitForFakeClaudeInvocation(fixture.fakeClaudeLogPath, row => row.mode === 'sdk'
    && typeof row.sessionMcpContextFile === 'string');
  if (typeof invocation.sessionMcpContextFile !== 'string') throw new Error('Vendor did not receive Session MCP custody');
  // Act as the substituted vendor on the exact native transport issued to it.
  nativeMcp = await connectSessionMcpClient(await readSessionMcpContextFromEnvironment({
    HAPPIER_SESSION_MCP_CONTEXT_FILE: invocation.sessionMcpContextFile,
  }));
  let status: Record<string, unknown> = {};
  await waitFor(async () => {
    status = await nativeAction('session.status.get', { sessionId: 'self', includeAcceptedWorkspace: true });
    return status.acceptedWorkspace !== undefined;
  }, { timeoutMs: 60_000 });
  const workspace = WorkspaceAddressV1Schema.parse(object(status.acceptedWorkspace).checkout);
  expect(workspace).toMatchObject({ machineId, rootPath: fixture.workspaceDir });
  const inspected = ProjectDefinitionInspectOutputSchema.parse(await nativeAction('projects.inspect', { workspace }));
  expect(inspected.definition.basis.kind).toBe('absent');
  const source = inspected.detection.entries.map(entry => entry.source)
    .find(entry => entry.kind === 'native' && entry.tool === 'make' && entry.target === 'keeper');
  expect(source).toBeDefined();
  if (!source) throw new Error('Native Make target was not detected');

  const listed = await execute('machines.agents.list', { serverId, machineId, agentId: 'claude', refresh: true }, context);
  if (!listed.ok) throw new Error(JSON.stringify(listed));
  const inventory = MachinesAgentsListOutputSchema.parse(listed.result);
  expect(findMachineAgentInventoryItemForTargetV1(inventory.items, { kind: 'backend', backendId: 'claude' }))
    .toMatchObject({ installed: true, signIn: { status: 'signedOut' } });
  fixture.homeRequests?.clear();
  const result = await execute('execution.run.start', {
    sessionId, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    instructions: 'Report ready.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
    runClass: 'bounded', ioMode: 'request_response', modelId: 'claude-sonnet-4-5',
    connectedServices: `${CLAUDE_SUBSCRIPTION_SERVICE_ID}:profile:selected`,
  }, context);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { runId: expect.any(String) } });
  if (!result.ok) throw new Error('Selected-auth Run did not start');
  const runId = object(result.result).runId;
  let finished: unknown;
  await waitFor(async () => {
    const state = await execute('execution.run.get', { sessionId, runId, includeStructured: true }, context);
    if (!state.ok) throw new Error(JSON.stringify(state));
    finished = state.result;
    return object(object(state.result).run).status !== 'running';
  }, { timeoutMs: 60_000, intervalMs: 250 });
  expect(finished).toMatchObject({ run: { status: 'succeeded' }, structuredMeta: {
    kind: 'delegate_output.v1', payload: {
      summary: expect.stringMatching(/^FAKE_DELEGATE_SUMMARY_\d+$/),
      deliverables: [{ title: 'Fake deliverable', details: 'Fake details' }],
    },
  } });
  const startRequests = fixture.homeRequests?.entries().filter(entry => entry.method === 'POST'
    && entry.path === '/v1/actions/execution.run.start');
  expect(startRequests).toHaveLength(1);
  expect(startRequests?.[0].statusCode).toBe(200);
  expect(fixture.homeRequests?.count(entry => entry.method === 'POST'
    && entry.path === '/v1/actions/execution.run.start/execution-authorization')).toBe(1);

  const pending = await nativeAction('projects.script.run', { workspace, selection: { kind: 'native', source } });
  expect(pending).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String) });
  const artifactId = pending.artifactId;
  const approved = await execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
  expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed' } });
  await waitForFakeClaudeUserText(fixture.fakeClaudeLogPath, text => text.includes('L12_KEEPER_SCRIPT'));
  expect(await readFile(resolve(fixture.workspaceDir, 'keeper-result.txt'), 'utf8')).toBe('completed\n');
  const outcomeId = `approval-result:${artifactId}`;
  const delivered = (await fetchAllMessages(fixture.serverBaseUrl, fixture.auth.token, sessionId))
    .filter(row => row.localId === outcomeId);
  expect(delivered).toHaveLength(1);
  if (delivered[0].content.t !== 'encrypted') throw new Error('Expected the E2EE Session envelope');
  const message = object(decryptLegacyBase64(delivered[0].content.c, fixture.accountSecret));
  expect(message).toMatchObject({ role: 'user', meta: {
    happierProvenanceV1: { v: 1, kind: 'host', producer: 'happierMcp' },
    happierInputRequestV1: { v: 1, producer: 'happierMcp' },
  } });
  // Rejoining a terminal approval must preserve its immutable input and not rerun the Script.
  expect(await execute('approval.request.decide', { artifactId, decision: 'approve' }, context))
    .toMatchObject({ ok: true, result: { status: 'executed' } });
  expect(await readFile(resolve(fixture.workspaceDir, 'keeper-result.txt'), 'utf8')).toBe('completed\n');
  expect((await fetchAllMessages(fixture.serverBaseUrl, fixture.auth.token, sessionId))
    .filter(row => row.localId === outcomeId)).toHaveLength(1);
// Process owners bound their lifecycle waits; resource admission may remain queued.
}, 0);
