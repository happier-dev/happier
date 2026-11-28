import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { SessionTranscriptGetSemanticSuccessSchema, SESSION_TRANSCRIPT_GET_MAX_LIMIT } from '@happier-dev/protocol/actions/specs/session/transcript';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ManagedAcceptedV1Schema, ManagedGetOutputV1Schema, ManagedInspectOutputV1Schema,
  ManagedDeleteOutputV1Schema, ManagedResizeOutputV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/enrollmentIdentityV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/jsonSchemaValidation';
import { MachineProvisionersListResultV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1,
  readMachineProvisionerPrerequisitesV1, type MachineProvisionerSelectionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { connectUiActionClient } from '@happier-tests/ui-action-client';
import type { TeamSetupFFixture } from '../testkit/teamSetupF';
import { waitFor } from '../testkit/timing';

type Ui = Awaited<ReturnType<typeof connectUiActionClient>>;
type Account = Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
type Controller = Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;

/** Real provisioner, enrollment, power and Session delivery. No boundary is simulated. */
export async function runManagedMachineJourney(input: Readonly<{
  fixture: TeamSetupFFixture; account: Account; controller: Controller; ui: Ui; testDir: string;
  provider: Readonly<{ pluginId: string; localId: string }>;
  selectors: unknown; selection: MachineProvisionerSelectionV1;
  agentTarget: unknown; guestDirectory: string;
  enrollmentIdentity: ManagedMachineEnrollmentIdentityV1;
  requireSshTrust: boolean;
  sessionEnvironment?: Readonly<Record<string, string>>;
  /** Install only a deterministic third-party Agent after real guest enrollment. */
  installAgentFixture?: (machine: ReturnType<typeof unwrapManagedMachineReadV1>) => Promise<void>;
  /** The guest ingress holds real Machine registration until the person cancels creation. */
  assertLateEnrollmentRefused?: () => Promise<void>;
  verifyBeforeNativeCleanup?: (guestMachineId: string) => Promise<void>;
  /** Share an explicit caller budget when the containing run supplies one. */
  deadlineAt?: number;
}>) {
  const { fixture, account, controller, ui } = input;
  const homeId = fixture.serverId;
  const installation = MachineInstallationIdentityV1Schema.parse(JSON.parse(
    await readFile(join(controller.homeDir, 'installation-identity.json'), 'utf8')));
  const controllerRef = { machineId: controller.target.machineId, installationId: installation.installationId };
  const context = { surface: 'ui' as const, authority: 'present_user' as const,
    serverId: ui.serverId, actionCaller: { kind: 'host' as const } };
  const phaseTimes: Record<string, number> = {};
  let managedId: string | undefined;
  let creationOperationId: string | undefined;
  let guestMachineId: string | undefined;
  let trustedHost = false;
  let failure: unknown;
  async function action(id: ActionId, value: unknown) {
    const parsed = getActionSpec(id).inputSchema.parse(value);
    const result = await ui.executeConfirmed(id, parsed, { ...context, serverIdentityId: homeId, actionRequestId: randomUUID() });
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result)}`);
    return result.result;
  }
  async function until(phase: string, predicate: () => Promise<boolean> | boolean) {
    const startedAt = performance.now();
    await waitFor(predicate, {
      ...(input.deadlineAt === undefined ? {} : { timeoutMs: Math.max(1, input.deadlineAt - Date.now()) }),
      context: phase, failFast: true });
    phaseTimes[phase] = Math.round(performance.now() - startedAt);
  }
  async function readMachine() {
    return unwrapManagedMachineReadV1(ManagedGetOutputV1Schema.parse(await action('machines.managed.get', { homeId, managedId })));
  }
  async function operation(operationId: string, observePrompt = false) {
    const result = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', {
      serverId: ui.serverId, machineId: controllerRef.machineId, operationId,
      ...(observePrompt ? { waitForTerminal: true, includeManagedPrompt: true } : {}),
    }));
    assert.equal(result.kind, 'found', 'Accepted managed operation must remain readable');
    if (result.kind !== 'found') throw new Error('Managed operation missing');
    return result.operation;
  }
  async function settle(operationId: string, phase: string) {
    const answered = new Set<string>();
    await until(phase, async () => {
      const current = await operation(operationId, true);
      if (current.state === 'failed' || current.state === 'cancelled') {
        if (phase === 'create-trust' && input.assertLateEnrollmentRefused) return true;
        // Keep the complete typed cause at the journey's far end before cleanup.
        await writeFile(join(input.testDir, `${phase}.operation.json`), JSON.stringify(current, null, 2));
        assert.equal(current.state, 'succeeded', JSON.stringify(current.error));
      }
      const domain = current.domainRef;
      const task = domain?.kind === 'managedMachine' ? domain.bootstrapTask : undefined;
      const prompt = task?.prompt;
      if (task && prompt) {
        assert.notEqual(prompt.kind, 'administrator.establish', 'This personal guest must not require a password fixture');
        const key = JSON.stringify([task.id, prompt]);
        if (!answered.has(key) && prompt.kind !== 'administrator.establish') {
          if (prompt.kind === 'ssh.trustHost') assert.match(prompt.fingerprint, /^SHA256:/);
          // This is the person's actual Trust/Pairing answer through the UI Action.
          await action('machines.managed.bootstrap.respond', { serverId: ui.serverId, homeId,
            managedId, operationId, taskId: task.id, purpose: 'approve', prompt, approved: true });
          if (prompt.kind === 'ssh.trustHost') trustedHost = true;
          answered.add(key);
        }
      }
      return current.state === 'succeeded';
    });
  }
  async function power(intent: 'stop' | 'start') {
    const current = await readMachine();
    const accepted = ManagedIntentResultSchema.parse(await action('machines.managed.power.set', {
      homeId, managedId, when: 'now', expectedRevision: current.intentRevision, intent,
    }));
    assert.equal(accepted.kind, 'accepted', JSON.stringify(accepted));
    if (accepted.kind !== 'accepted') throw new Error('Power intent refused');
    if (accepted.operation) await settle(accepted.operation.operationId, `power-${intent}`);
    await until(`native-${intent}`, async () => {
      const inspected = ManagedInspectOutputV1Schema.parse(await action('machines.managed.inspect', { homeId, managedId }));
      return inspected.machine.observation?.power === (intent === 'stop' ? 'stopped' : 'running');
    });
    await until(`presence-${intent}`, () => intent === 'stop'
      ? !ui.isMachineActive(guestMachineId!) : ui.isMachineControlReady(guestMachineId!));
  }
  async function transcript(sessionId: string) {
    const items = [];
    let cursor: string | null = null;
    do {
      const page = SessionTranscriptGetSemanticSuccessSchema.parse(await action('session.transcript.get', {
        sessionId, limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT, cursor, direction: 'before',
        roles: ['user', 'assistant'], maxCharsPerMessage: null,
      }));
      items.push(...page.items);
      cursor = page.hasMore ? page.nextCursor : null;
      assert.ok(!page.hasMore || cursor, 'Transcript pagination must provide its continuation');
    } while (cursor);
    return items;
  }
  async function reply(sessionId: string, token: string) {
    await until(`reply-${token}`, async () => (await transcript(sessionId))
      .some(item => item.role === 'assistant' && item.text?.includes(token)));
  }
  try {
    const listed = MachineProvisionersListResultV1Schema.parse(await action('machines.provisioners.list', {
      homeId, controller: controllerRef, contribution: input.provider,
    }));
    const entry = listed.provisioners.find(row => row.contribution.pluginId === input.provider.pluginId
      && row.contribution.localId === input.provider.localId);
    assert.ok(entry, 'The selected real provider must be published by the controller');
    const check = MachineProvisionerCheckResultV1Schema.parse(await action('machines.provisioners.check', {
      homeId, controller: controllerRef, contribution: input.provider,
    }));
    assert.equal(check.available, true, JSON.stringify(check));
    const options = MachineProvisionerOptionsResultV1Schema.parse(await action('machines.provisioners.options', {
      homeId, controller: controllerRef, contribution: input.provider, selectors: input.selectors,
    }));
    const selected = projectMachineProvisionerSelectionV1({ options, selection: input.selection, launchSchema: entry.descriptor.launchSchema });
    assert.equal(selected.kind, 'ready', JSON.stringify(selected));
    if (selected.kind !== 'ready') throw new Error('Real provider options did not produce a launch');
    const launch = { provider: input.provider, schemaVersion: entry.descriptor.schemaVersion,
      name: `managed-journey-${randomUUID()}`, choices: selected.launch };
    const reviewedFacts = buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(entry.descriptor.launchSchema),
      launch, controller: controllerRef, optionStatus: 'current', provisioner: entry.descriptor,
      prerequisites: readMachineProvisionerPrerequisitesV1(check, options), billing: entry.descriptor.billing,
      retentionCapabilities: entry.descriptor.retention, optionProjection: selected,
      machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } });
    const created = ManagedAcceptedV1Schema.parse(await action('machines.managed.acquire', {
      selection: { kind: 'one-off', homeId, controller: controllerRef, launch,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true },
      enrollmentIdentity: input.enrollmentIdentity,
      reviewedFacts,
    }));
    managedId = created.managedId;
    creationOperationId = created.operation?.operationId;
    assert.ok(creationOperationId, 'Creation must expose its real installation operation');
    await settle(creationOperationId, 'create-trust');
    if (input.assertLateEnrollmentRefused) {
      await input.assertLateEnrollmentRefused();
      const canceled = await readMachine();
      assert.equal(canceled.creationState, 'canceled');
      assert.equal(Boolean(canceled.enrolledMachineId), false);
      const deleted = ManagedDeleteOutputV1Schema.parse(await action('machines.managed.delete', {
        homeId, managedId, when: 'now', expectedRevision: canceled.intentRevision,
        intent: 'delete', reviewedDependencies: true,
      }));
      assert.equal(deleted.kind, 'accepted', JSON.stringify(deleted));
      if (deleted.kind === 'accepted' && deleted.operation) await settle(deleted.operation.operationId, 'cancelled-delete');
      await until('cancelled-confirmed-absent', async () => (await readMachine()).allocation === 'confirmed-absent');
      return { managedId, guestMachineId: undefined, phaseTimes };
    }
    if (input.requireSshTrust) assert.equal(trustedHost, true, 'J1 requires a fresh SSH guest whose first-use Trust prompt was approved');
    const createdMachine = await readMachine();
    assert.equal(createdMachine.allocation, 'bound');
    assert.equal(createdMachine.bootstrapInstalled, true);
    guestMachineId = createdMachine.enrolledMachineId;
    assert.ok(guestMachineId, 'Installation success must enroll a real guest');
    await until('guest-online', () => ui.isMachineControlReady(guestMachineId!));
    const workspace = await ui.executeConfirmed('daemon.filesystem.listDirectory', { rootPath: input.guestDirectory, path: '.' }, {
      ...context, serverIdentityId: homeId, actionRequestId: randomUUID(),
      externalActionTarget: { kind: 'machine', machineId: guestMachineId },
    });
    assert.equal(workspace.ok, true, 'The enrolled guest must accept workspace RPC');
    if (!workspace.ok) throw new Error(`Guest workspace RPC refused (${workspace.errorCode})`);
    assert.ok(workspace.result && typeof workspace.result === 'object' && 'success' in workspace.result && workspace.result.success === true,
      'The selected workspace must be readable before power and Send exercise it');
    console.info('MR-R2 native allocation, bootstrap, enrollment, connection and workspace readiness observed');
    await input.installAgentFixture?.(createdMachine);
    // Exercise the selected provider's offered CPU resize through the same
    // reviewed UI Action as its power operations, then read native inspection.
    await power('stop');
    if (entry.descriptor.actions.resize) {
      const resized = ManagedResizeOutputV1Schema.parse(await action('machines.managed.resize', {
        homeId, managedId, size: { cpuCores: 2 },
      }));
      assert.equal(resized.result.kind, 'confirmed', JSON.stringify(resized));
      const inspected = ManagedInspectOutputV1Schema.parse(await action('machines.managed.inspect', { homeId, managedId }));
      assert.equal(inspected.machine.observation?.size?.cpuCores, 2,
        'The offered resize must reach the native resource, not only settle the Action');
      assert.equal((await readMachine()).enrolledMachineId, guestMachineId);
    }
    await power('start');
    const spawned = SessionSpawnNewActionResultV1Schema.parse(await action('session.spawn_new', {
      executionTarget: { serverId: ui.serverId, machineId: guestMachineId },
      directory: { kind: 'path', path: input.guestDirectory }, agentTarget: input.agentTarget,
      ...(input.sessionEnvironment ? { environmentVariables: input.sessionEnvironment } : {}),
      terminal: { mode: 'plain' },
    }));
    assert.equal(spawned.type, 'success', JSON.stringify(spawned));
    if (spawned.type !== 'success') throw new Error('Guest Session did not start');
    const onlineToken = `WAKE_${randomUUID()}`;
    await action('session.message.send', { sessionId: spawned.sessionId,
      message: `Reply with exactly ${onlineToken}. Do not use tools.` });
    await reply(spawned.sessionId, onlineToken);
    for (const route of ['ui', 'cli-action'] as const) {
      await power('stop');
      const token = `WAKE_${randomUUID()}`;
      const message = `Reply with exactly ${token}. Do not use tools.`;
      const request = getActionSpec('session.message.send').inputSchema.parse({ sessionId: spawned.sessionId, message });
      if (route === 'ui') {
        const submitted = await ui.submitSessionMessage(spawned.sessionId, message);
        assert.equal(submitted.type, 'success', JSON.stringify(submitted));
      }
      else {
        const result = await account.execute('session.message.send', request);
        assert.equal(result.ok, true, JSON.stringify(result));
      }
      await until(`wake-${route}`, () => ui.isMachineControlReady(guestMachineId!));
      await reply(spawned.sessionId, token);
      // A subsequent completed turn is a delivery barrier, not a sleep chosen to hide duplicates.
      const barrier = `BARRIER_${randomUUID()}`;
      await action('session.message.send', { sessionId: spawned.sessionId,
        message: `Reply with exactly ${barrier}. Do not use tools.` });
      await reply(spawned.sessionId, barrier);
      const rows = await transcript(spawned.sessionId);
      assert.equal(rows.filter(row => row.role === 'user' && row.text === message).length, 1,
        `${route}: accepted input must persist exactly once`);
      assert.equal(rows.filter(row => row.role === 'assistant' && row.text?.includes(token)).length, 1,
        `${route}: the resumed Agent must process accepted input exactly once`);
    }
    // Distinct admitted Session roots on one sleeping Machine must all finish;
    // no executor or UI-specific wake retry may hide a failed latecomer.
    const concurrentSessions = [spawned.sessionId];
    for (let index = 0; index < 3; index++) {
      const additional = SessionSpawnNewActionResultV1Schema.parse(await action('session.spawn_new', {
        executionTarget: { serverId: ui.serverId, machineId: guestMachineId },
        directory: { kind: 'path', path: input.guestDirectory }, agentTarget: input.agentTarget,
        ...(input.sessionEnvironment ? { environmentVariables: input.sessionEnvironment } : {}),
        terminal: { mode: 'plain' },
      }));
      assert.equal(additional.type, 'success', JSON.stringify(additional));
      if (additional.type !== 'success') throw new Error('Concurrent wake Session did not start');
      concurrentSessions.push(additional.sessionId);
    }
    await power('stop');
    const concurrentInputs = concurrentSessions.map(sessionId => {
      const token = `WAKE_${randomUUID()}`;
      return { sessionId, token, message: `Reply with exactly ${token}. Do not use tools.` };
    });
    const concurrentResults = await Promise.allSettled(concurrentInputs.map(({ sessionId, message }) =>
      account.execute('session.message.send', getActionSpec('session.message.send').inputSchema.parse({ sessionId, message }))));
    await writeFile(join(input.testDir, 'concurrent-send-results.json'), JSON.stringify(
      concurrentResults.map((result, index) => ({ ...concurrentInputs[index],
        ...(result.status === 'fulfilled' ? { result: result.value } : { rejected: String(result.reason) }) })), null, 2));
    for (const result of concurrentResults) {
      assert.equal(result.status, 'fulfilled', 'Every concurrent wake caller must settle successfully');
      if (result.status !== 'fulfilled') throw result.reason;
      assert.equal(result.value.ok, true, JSON.stringify(result.value));
    }
    await until('wake-concurrent-sessions', () => ui.isMachineControlReady(guestMachineId!));
    for (const { sessionId, token, message } of concurrentInputs) {
      await reply(sessionId, token);
      const barrier = `BARRIER_${randomUUID()}`;
      await action('session.message.send', { sessionId, message: `Reply with exactly ${barrier}. Do not use tools.` });
      await reply(sessionId, barrier);
      const rows = await transcript(sessionId);
      assert.equal(rows.filter(row => row.role === 'user' && row.text === message).length, 1,
        'Concurrent wake input must persist exactly once in its own Session');
      assert.equal(rows.filter(row => row.role === 'assistant' && row.text?.includes(token)).length, 1,
        'Concurrent wake input must receive exactly one reply in its own Session');
    }
    await power('stop');
    const initialToken = `WAKE_${randomUUID()}`;
    const initialMessage = `Reply with exactly ${initialToken}. Do not use tools.`;
    // Ordinary composer Send has no explicit confirmation. Adding one would
    // conceal the historical owned-guest bypass of Home wake admission.
    const initialResult = await ui.execute('session.spawn_new', getActionSpec('session.spawn_new').inputSchema.parse({
      creationKey: randomUUID(), executionTarget: { serverId: ui.serverId, machineId: guestMachineId },
      directory: { kind: 'path', path: input.guestDirectory }, agentTarget: input.agentTarget,
      ...(input.sessionEnvironment ? { environmentVariables: input.sessionEnvironment } : {}),
      terminal: { mode: 'plain' }, initialInput: { text: initialMessage },
    }), { ...context, serverIdentityId: homeId, actionRequestId: randomUUID() });
    assert.equal(initialResult.ok, true, JSON.stringify(initialResult));
    const initialSession = SessionSpawnNewActionResultV1Schema.parse(initialResult.result);
    assert.equal(initialSession.type, 'success', JSON.stringify(initialSession));
    if (initialSession.type !== 'success') throw new Error('Asleep composer Session did not start');
    assert.equal(initialSession.disposition, 'created');
    assert.equal(initialSession.initialInput.status, 'accepted', JSON.stringify(initialSession.initialInput));
    await until('wake-ui-initial-input', () => ui.isMachineControlReady(guestMachineId!));
    await reply(initialSession.sessionId, initialToken);
    const initialBarrier = `BARRIER_${randomUUID()}`;
    await action('session.message.send', { sessionId: initialSession.sessionId,
      message: `Reply with exactly ${initialBarrier}. Do not use tools.` });
    await reply(initialSession.sessionId, initialBarrier);
    const initialRows = await transcript(initialSession.sessionId);
    assert.equal(initialRows.filter(row => row.role === 'user' && row.text === initialMessage).length, 1,
      'UI composer: initial input must persist exactly once');
    assert.equal(initialRows.filter(row => row.role === 'assistant' && row.text?.includes(initialToken)).length, 1,
      'UI composer: the awakened Agent must process initial input exactly once');
    if (entry.descriptor.actions.rebuild) {
      const previous = await readMachine();
      assert.ok(reviewedFacts.reviewedEffectDigest, 'An offered rebuild must consume the actual native effect review');
      const rebuilt = ManagedIntentResultSchema.parse(await action('machines.managed.rebuild', {
        homeId, managedMachineId: managedId, expectedRevision: previous.intentRevision,
        kind: 'rebuild', reviewedEffectDigest: reviewedFacts.reviewedEffectDigest,
      }));
      assert.equal(rebuilt.kind, 'accepted', JSON.stringify(rebuilt));
      if (rebuilt.kind !== 'accepted' || !rebuilt.operation) throw new Error('Rebuild did not expose its installation operation');
      await settle(rebuilt.operation.operationId, 'rebuild');
      const replacement = await readMachine();
      assert.ok(replacement.enrolledMachineId, 'The rebuilt native guest must enroll again');
      assert.notDeepEqual(replacement.resource, previous.resource, 'Rebuild must replace the actual native installation');
      guestMachineId = replacement.enrolledMachineId;
      await until('rebuilt-guest-online', () => ui.isMachineControlReady(guestMachineId!));
      await input.installAgentFixture?.(replacement);
      const rebuiltSession = SessionSpawnNewActionResultV1Schema.parse(await action('session.spawn_new', {
        executionTarget: { serverId: ui.serverId, machineId: guestMachineId },
        directory: { kind: 'path', path: input.guestDirectory }, agentTarget: input.agentTarget,
        ...(input.sessionEnvironment ? { environmentVariables: input.sessionEnvironment } : {}),
        terminal: { mode: 'plain' },
      }));
      assert.equal(rebuiltSession.type, 'success', JSON.stringify(rebuiltSession));
      if (rebuiltSession.type !== 'success') throw new Error('Rebuilt guest Session did not start');
      const token = `REBUILT_${randomUUID()}`;
      await action('session.message.send', { sessionId: rebuiltSession.sessionId,
        message: `Reply with exactly ${token}. Do not use tools.` });
      await reply(rebuiltSession.sessionId, token);
    }
  } catch (error) { failure = error; }
  // Capture both native guest diagnostics and the controller's retained cause BEFORE Delete.
  if (managedId) {
    try {
      const inspect = await action('machines.managed.inspect', { homeId, managedId, includeGuestDiagnostics: true });
      await writeFile(join(input.testDir, 'before-delete.inspect.json'), JSON.stringify(inspect, null, 2));
      const controllerOperation = creationOperationId ? await operation(creationOperationId) : null;
      await writeFile(join(input.testDir, 'before-delete.controller.json'), JSON.stringify(controllerOperation, null, 2));
      if (!failure && guestMachineId && input.verifyBeforeNativeCleanup) {
        try { await input.verifyBeforeNativeCleanup(guestMachineId); }
        catch (error) { failure = error; }
      }
      const current = await readMachine();
      const deleted = ManagedDeleteOutputV1Schema.parse(await action('machines.managed.delete', {
        homeId, managedId, when: 'now', expectedRevision: current.intentRevision,
        intent: 'delete', reviewedDependencies: true,
      }));
      assert.equal(deleted.kind, 'accepted', JSON.stringify(deleted));
      if (deleted.kind === 'accepted' && deleted.operation) await settle(deleted.operation.operationId, 'delete');
      await until('confirmed-absent', async () => (await readMachine()).allocation === 'confirmed-absent');
    } catch (cleanupError) {
      failure = failure ? new AggregateError([failure, cleanupError], 'Managed journey and cleanup failed') : cleanupError;
    }
  }
  await writeFile(join(input.testDir, 'journey-timings.json'), JSON.stringify({ phaseTimes, managedId, guestMachineId }, null, 2));
  if (failure) throw failure;
  return { managedId, guestMachineId, phaseTimes };
}
