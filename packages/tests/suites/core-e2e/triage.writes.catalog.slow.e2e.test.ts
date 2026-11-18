import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// QB-30 — configured Action catalog, offered choices, saved defaults, and cold persistence.
// U-ACTIONS-CATALOG / U-PROFILES-SESSION-DEFAULTS — the catalog owner persists the
// record and the runtime reads the same record after a fresh Account client.
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import { TriageSessionHandoffChoicesV1Schema } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_DEFAULT_ACTIONS_V1 } from '../../../plugins/triage/src/settings/actions';
import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageAdministerActionResultV1Schema,
  TriageReadActionsResultV1Schema,
} from '../../../plugins/triage/src/actions/actionsCatalogProtocol';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'triage-writes-catalog' });

describe('Triage writes: configured Action catalog', () => {
  let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  let accountSecret: Uint8Array;
  let machineId = '';
  let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;

  beforeAll(async () => {
    const testDir = run.testDir(`catalog-${randomUUID()}`);
    const sourceRuntime = pathToFileURL(join(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href;
    server = await startServerLight({ testDir, extraEnv: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import', sourceRuntime].filter(Boolean).join(' '),
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    const auth = await createTestAuth(server.baseUrl);
    accountSecret = auth.accountSigningSeed;
    const homeDir = join(testDir, 'daemon-home');
    await mkdir(homeDir, { recursive: true });
    const seeded = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
    machineId = seeded.machineId;
    daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
      ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import', sourceRuntime].filter(Boolean).join(' '),
      CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    } });
  }, 240_000);

  beforeEach(async () => {
    if (!server) throw new Error('Catalog runtime server not started');
    client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret });
    await waitFor(() => client!.isAccountReady() && client!.isMachineControlReady(machineId), { timeoutMs: 60_000 });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  afterAll(async () => {
    await client?.close();
    await daemon?.stop();
    await server?.stop();
  }, 120_000);

  async function invoke(localId: string, input: unknown) {
    if (!client) throw new Error('Catalog runtime client not connected');
    const result = await client.executeConfirmed('action.invoke', {
      action: { pluginId: 'happier.triage', localId },
      input,
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: client.serverId });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Triage Action ${localId} refused (${result.errorCode})`);
    return result.result;
  }

  const read = async () => TriageReadActionsResultV1Schema.parse(await invoke(
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }));
  const write = async (input: unknown) => TriageAdministerActionResultV1Schema.parse(await invoke(
    TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, input));
  const choices = async (subject?: 'deploymentEnvironment') => {
    const result = TriageSessionHandoffChoicesV1Schema.parse(await invoke(TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
      { v: 1, projection: 'sessionHandoff', task: 'fix', ...(subject ? { subject } : {}) }));
    expect(result.kind).toBe('choices');
    if (result.kind !== 'choices') throw new Error('Configured handoff choices unavailable');
    return result;
  };

  it('seeds, renames, orders, filters, disables and removes actions through a fresh client, then resets defaults', async () => {
    const initial = await read();
    expect(initial.availability).toBe('absent');
    for (const seeded of TRIAGE_DEFAULT_ACTIONS_V1) {
      expect(initial.actions.find(action => action.actionId === seeded.actionId)).toEqual(seeded);
    }
    let revision = initial.revision;
    for (const [actionId, label] of [['ask', 'Fix'], ['fix', 'Review'], ['review', 'Ask']]) {
      const original = initial.actions.find(action => action.actionId === actionId);
      if (!original) throw new Error(`Missing shipped Action ${actionId}`);
      const { actionId: _, ...record } = original;
      // Fallback instructions are read-only; an ordinary rename must retain them.
      const { seededFallbackInstruction: __, ...target } = record.target;
      const renamed = await write({ v: 1, kind: 'update', actionId, expectedRevision: revision,
        ...record, target, label });
      expect(renamed.status).toBe('applied');
      expect(renamed.actions?.find(action => action.actionId === actionId)).toEqual({ ...original, label });
      if (!renamed.revision) throw new Error('Rename did not return its catalog revision');
      revision = renamed.revision;
    }
    expect(await choices()).toMatchObject({ defaultActionId: 'fix', actions: expect.arrayContaining([
      expect.objectContaining({ label: 'Fix', selection: { configuredActionId: 'ask',
        sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' } }),
      expect.objectContaining({ label: 'Review', selection: { configuredActionId: 'fix',
        sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' } }),
    ]) });
    const draft = (label: string) => ({ label, enabled: true, appliesTo: ['deploymentEnvironment'], profileId: null,
      workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } });
    const first = await write({ v: 1, kind: 'create', expectedRevision: revision, ...draft(`Catalog A ${randomUUID()}`) });
    expect(first.status).toBe('applied');
    const firstAction = first.actions?.at(-1);
    expect(firstAction).toBeDefined();
    if (!firstAction) throw new Error('First configured Action was not returned');
    const second = await write({ v: 1, kind: 'create', expectedRevision: first.revision,
      ...draft(`Catalog B ${randomUUID()}`), appliesTo: ['other'], workspaceMode: 'repository' });
    expect(second.status).toBe('applied');
    const secondAction = second.actions?.at(-1);
    expect(secondAction).toBeDefined();
    if (!secondAction) throw new Error('Second configured Action was not returned');
    const reordered = await write({ v: 1, kind: 'reorder', expectedRevision: second.revision,
      actionIds: [secondAction.actionId, firstAction.actionId, ...second.actions!.filter(action =>
        action.actionId !== firstAction.actionId && action.actionId !== secondAction.actionId).map(action => action.actionId)] });
    expect(reordered.status).toBe('applied');
    const offered = await choices('deploymentEnvironment');
    expect(offered.actions.slice(0, 2).map(action => action.selection.configuredActionId))
      .toEqual([secondAction.actionId, firstAction.actionId]);
    const shared = await choices();
    expect(shared.actions.some(action => action.selection.configuredActionId === firstAction.actionId)).toBe(false);
    expect(shared.actions[0].selection.configuredActionId).toBe(secondAction.actionId);
    const disabled = await write({ v: 1, kind: 'update', actionId: firstAction.actionId,
      expectedRevision: reordered.revision, ...draft(firstAction.label), enabled: false });
    expect(disabled.status).toBe('applied');

    await client?.close();
    client = undefined;
    if (!server) throw new Error('Catalog runtime server unavailable during cold read');
    client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret });
    await waitFor(() => client!.isAccountReady(), { timeoutMs: 60_000 });
    await client.waitForPluginAccountAvailability();
    const cold = await read();
    expect(cold.actions.map(action => action.actionId).slice(0, 2)).toEqual([secondAction.actionId, firstAction.actionId]);
    expect(cold.actions.find(action => action.actionId === firstAction.actionId)).toMatchObject({ enabled: false });
    expect(cold.actions.find(action => action.actionId === secondAction.actionId)).toMatchObject({ enabled: true });
    const coldChoices = await choices('deploymentEnvironment');
    expect(coldChoices.actions.some(action => action.selection.configuredActionId === firstAction.actionId)).toBe(false);
    expect(coldChoices.actions[0].selection.configuredActionId).toBe(secondAction.actionId);

    const removedA = await write({ v: 1, kind: 'delete', actionId: firstAction.actionId, expectedRevision: cold.revision });
    expect(removedA.status).toBe('applied');
    const removedB = await write({ v: 1, kind: 'delete', actionId: secondAction.actionId, expectedRevision: removedA.revision });
    expect(removedB.status).toBe('applied');
    expect((await read()).actions.some(action => [firstAction.actionId, secondAction.actionId].includes(action.actionId))).toBe(false);
    expect((await choices('deploymentEnvironment')).actions.some(action =>
      [firstAction.actionId, secondAction.actionId].includes(action.selection.configuredActionId))).toBe(false);

    const optedOut = await write({ v: 1, kind: 'delete', actionId: 'fix', expectedRevision: removedB.revision });
    expect(optedOut.status).toBe('applied');
    expect((await read()).actions.find(action => action.actionId === 'fix')).toMatchObject({ enabled: false });
    expect(await choices()).toMatchObject({ defaultActionId: null });
    const reset = await write({ v: 1, kind: 'reset', expectedRevision: optedOut.revision });
    expect(reset.status).toBe('applied');
    const restored = await read();
    expect(restored.availability).toBe('absent');
    for (const seeded of TRIAGE_DEFAULT_ACTIONS_V1) {
      expect(restored.actions.find(action => action.actionId === seeded.actionId)).toEqual(seeded);
    }
    expect(await choices()).toMatchObject({ defaultActionId: 'fix' });
  });

  it('saves prompt and profile defaults through their owners and preserves their identities on the next save', async () => {
    if (!client) throw new Error('Catalog runtime client not connected');
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId: client.serverId };
    const initial = await read();
    const created = await write({ v: 1, kind: 'create', expectedRevision: initial.revision,
      label: 'Review', enabled: true, appliesTo: ['other'], profileId: null, workspaceMode: 'reference_only',
      target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } });
    expect(created.status).toBe('applied');
    const action = created.actions?.at(-1);
    if (!action) throw new Error('Configured Action was not created');
    const placement = { fixed: { serverId: client.serverId, machineId }, directoryIntent: { kind: 'managed' } };
    const save = (profileId: string | null, promptText: string, launchMode: 'start' | 'review') => write({
      v: 1, kind: 'saveDefaults', actionId: action.actionId, label: 'Fix', promptText, profileId,
      placement, checkout: 'reuse_workspace', launchMode,
    });
    const saved = await save(null, 'Explain the catalog journey.', 'start');
    expect(saved.status).toBe('applied');
    const first = saved.actions?.find(record => record.actionId === action.actionId);
    expect(first).toMatchObject({ workspaceMode: 'reference_only', target: { kind: 'agent', delivery: 'send' } });
    if (!first?.profileId || !first.target.promptInvocationId) throw new Error('Saved references were not returned');
    const profile = await client.executeConfirmed('launch_profiles.read', { id: first.profileId }, context);
    expect(profile).toMatchObject({ ok: true, result: { status: 'present', profile: {
      id: first.profileId, placement, checkout: 'reuse_workspace' } } });
    const resolved = await client.executeConfirmed('prompts.invocation.resolve', { invocationId: first.target.promptInvocationId }, context);
    expect(resolved).toMatchObject({ ok: true, result: { status: 'resolved', text: 'Explain the catalog journey.' } });

    const updated = await save(first.profileId, 'Explain the updated catalog journey.', 'review');
    expect(updated.status).toBe('applied');
    const next = updated.actions?.find(record => record.actionId === action.actionId);
    expect(next).toMatchObject({ profileId: first.profileId, workspaceMode: 'reference_only',
      target: { kind: 'agent', promptInvocationId: first.target.promptInvocationId, delivery: 'compose' } });
    const resolvedAgain = await client.executeConfirmed('prompts.invocation.resolve', { invocationId: first.target.promptInvocationId }, context);
    expect(resolvedAgain).toMatchObject({ ok: true, result: { status: 'resolved', text: 'Explain the updated catalog journey.' } });
    const removed = await write({ v: 1, kind: 'delete', actionId: action.actionId, expectedRevision: updated.revision });
    expect(removed.status).toBe('applied');
  });
});
