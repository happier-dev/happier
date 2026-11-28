import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'vitest';
import { MACHINE_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { MACHINE_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contributionIdentity';
import { ManagedCancelOutputV1Schema, ManagedControllerReportV1Schema, ManagedGetOutputV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { MACHINE_PROVISIONER_DIMENSIONS_V1, type MachineProvisionerSelectionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import type { EnvOverrides } from '../../src/testkit/env';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

/**
 * Real-provider variant; requires an explicitly selected disposable provider on
 * the selected controller host, creating a fresh SSH guest with a first-use
 * Trust prompt. Costs and guest deletion are part of this run.
 * The guest must reach server-light's loopback URL in the runner's network
 * namespace, and have the selected real Agent usable after enrollment. A remote
 * VM needs an existing reachable-Home fixture; this suite creates no transport.
 *
 * Required env: HAPPIER_E2E_MANAGED_JOURNEY=1,
 * HAPPIER_E2E_MANAGED_CONTROLLER_HOST, HAPPIER_E2E_MANAGED_PROVIDER_JSON,
 * HAPPIER_E2E_MANAGED_SELECTORS_JSON, HAPPIER_E2E_MANAGED_SELECTION_JSON,
 * HAPPIER_E2E_MANAGED_AGENT_TARGET_JSON, HAPPIER_E2E_MANAGED_GUEST_DIRECTORY,
 * HAPPIER_E2E_MANAGED_JOURNEY_TIMEOUT_MS, HAPPIER_TEST_POSTGRES_DATABASE_URL.
 * Source-server preparation supplies the guest CLI archive. Optional controller process
 * env (real provider configuration): HAPPIER_E2E_MANAGED_CONTROLLER_ENV_JSON.
 * Set HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT=1 before starting Vitest.
 * Opt-out is a skip, never successful composed evidence.
 */
const enabled = process.env.HAPPIER_E2E_MANAGED_JOURNEY === '1';
const required = (key: string) => {
  const value = process.env[key]?.trim();
  assert.ok(value, `Managed journey requires ${key}`);
  return value;
};
const timeoutMs = enabled ? Number(required('HAPPIER_E2E_MANAGED_JOURNEY_TIMEOUT_MS')) : 0;
if (enabled) assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Journey timeout must be positive milliseconds');

it.skipIf(!enabled)('J1/J2 Create, Trust, Online, Stop, Start and both asleep Send routes deliver once before Delete', async () => {
  const deadlineAt = Date.now() + timeoutMs;
  assert.equal(hostname(), required('HAPPIER_E2E_MANAGED_CONTROLLER_HOST'), 'Run on the explicitly selected real controller');
  const provider = PluginContributionIdentityV1Schema.parse(JSON.parse(required('HAPPIER_E2E_MANAGED_PROVIDER_JSON')));
  const selectors = PluginJsonValueV2Schema.parse(JSON.parse(required('HAPPIER_E2E_MANAGED_SELECTORS_JSON')));
  const rawSelection: unknown = JSON.parse(required('HAPPIER_E2E_MANAGED_SELECTION_JSON'));
  assert.ok(rawSelection && typeof rawSelection === 'object' && !Array.isArray(rawSelection));
  const selection: Partial<Record<keyof MachineProvisionerSelectionV1, string>> = {};
  for (const [dimension, value] of Object.entries(rawSelection)) {
    const key = MACHINE_PROVISIONER_DIMENSIONS_V1.find(candidate => candidate === dimension);
    assert.ok(key, `Unknown native option dimension: ${dimension}`);
    assert.equal(typeof value, 'string', `Native option id for ${dimension} must be a string`);
    if (typeof value === 'string') selection[key] = value;
  }
  const agentTarget: unknown = JSON.parse(required('HAPPIER_E2E_MANAGED_AGENT_TARGET_JSON'));
  const guestDirectory = required('HAPPIER_E2E_MANAGED_GUEST_DIRECTORY');
  const controllerEnv: EnvOverrides = {};
  if (process.env.HAPPIER_E2E_MANAGED_CONTROLLER_ENV_JSON) {
    const env: unknown = JSON.parse(process.env.HAPPIER_E2E_MANAGED_CONTROLLER_ENV_JSON);
    assert.ok(env && typeof env === 'object' && !Array.isArray(env));
    for (const [key, value] of Object.entries(env)) {
      assert.equal(typeof value, 'string', `Controller environment ${key} must be a string`);
      if (typeof value === 'string') controllerEnv[key] = value;
    }
  }
  const [{ startTeamSetupFFixture }, { connectUiPersonActionClient }, { runManagedMachineJourney }] = await Promise.all([
    import('../../src/testkit/teamSetupF'), import('@happier-tests/ui-action-client'),
    import('../../src/scenarios/managedMachines.scenario'),
  ]);
  const run = createRunDirs({ runLabel: 'managed-machine-journey' });
  const testDir = run.testDir('create-trust-power-both-send-delete');
  const fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', serverEnv: {
    DATABASE_URL: required('HAPPIER_TEST_POSTGRES_DATABASE_URL'), HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
  } });
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  try {
    const account = await fixture.createAccount('managed-journey-owner');
    const controller = await fixture.enrollDaemon(account, { env: controllerEnv });
    ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
    await runManagedMachineJourney({ fixture, account, controller, ui, testDir, provider, selectors,
      selection, agentTarget, guestDirectory, deadlineAt,
      enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, requireSshTrust: true });
  } finally {
    try { await ui?.close(); } finally { await fixture.stop(); }
  }
}, timeoutMs);

// Linux Docker variant using the official DockerLibrary bookworm-scm image.
// Only the third-party Agent is deterministic.
// Provider allocation, PostgreSQL Home, Account pairing, separate enrolled guest
// daemon, native power and both public Send paths remain real. Unlike placed
// sandbox Sessions, this calls ordinary acquire and requires enrolledMachineId.
const cancelLateEnrollment = process.env.HAPPIER_E2E_MANAGED_CANCEL_LATE_ENROLLMENT === '1';
const removeEnrolledGuest = process.env.HAPPIER_E2E_MANAGED_REMOVE_ENROLLED_GUEST === '1';
const nativeDockerTest = cancelLateEnrollment
  ? 'J2 native Docker guest refuses registration after cancellation and confirms approved Delete'
  : removeEnrolledGuest
    ? 'ADS.F1 removing an enrolled Docker child keeps its paired parent signed in'
    : 'J2 native Docker guest wakes for UI and CLI Send and processes each input once';
it(nativeDockerTest, async () => {
  // Source-server preparation supplies the canonical guest CLI archive.
  // Immutable multi-platform index; DockerLibrary revision d0ecd4b7313e9bc6b00d9a4fe62ad5787bc197ae.
  const image = process.env.HAPPIER_TEST_SANDBOX_IMAGE?.trim()
    || 'docker.io/library/buildpack-deps@sha256:5bac6b3020afcf0358de87990605d5dc4c3f060629381912266b9b9278375af3';
  const [{ startTeamSetupFFixture }, { startDatabaseWorkbenchPostgres },
    { connectUiPersonActionClient }, { runManagedMachineJourney }, { waitFor }] = await Promise.all([
    import('../../src/testkit/teamSetupF'), import('../../src/testkit/process/databaseWorkbenchPostgres'),
    import('@happier-tests/ui-action-client'), import('../../src/scenarios/managedMachines.scenario'), import('../../src/testkit/timing'),
  ]);
  const run = createRunDirs({ runLabel: 'managed-native-wake-journey' });
  const testDir = run.testDir('docker-enrolled-both-send-delete');
  const vendorPath = join(testDir, 'sandbox-claude');
  execFileSync('cc', [resolve(repoRootDir(), 'packages/tests/fixtures/machines/sandbox-claude.c'), '-o', vendorPath]);
  const vendorBytes = (await readFile(vendorPath)).toString('base64');
  // Advertise the real host interface reachable through Docker's ordinary
  // default bridge. A PostgreSQL Home is not a personal SQLite Home and does
  // not publish a same-host identity or choose host networking for this guest.
  const guestHomeHost = execFileSync('docker', ['network', 'inspect', 'bridge',
    '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim();
  assert.ok(guestHomeHost, 'The selected Docker bridge must expose its actual host gateway');
  const database = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL ? undefined
    : await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let boundId: string | undefined;
  let guestRegistrationStarted = false;
  let lateRegistrationStatus: number | undefined;
  let cancelBoundGuest: ((managedId: string) => Promise<void>) | undefined;
  const reportPath = '/v1/machines/managed/controller/report';
  const registrationPath = '/v1/machines';
  const nativeContainers = (managedId: string) => execFileSync('docker', ['ps', '--all', '--quiet',
    '--filter', `label=happier.managed-machine=${managedId}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  try {
    fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', guestReachableHome: { host: guestHomeHost }, serverEnv: {
      DATABASE_URL: database?.homeDatabaseUrl ?? process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL,
      HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
      ...(cancelLateEnrollment ? { HAPPIER_HOME_IROH_MODE: 'disabled' } : {}),
    }, ...(cancelLateEnrollment ? {
      captureRequestBody: request => request.path === reportPath,
      async beforeHttpRequest(request) {
        if (!boundId || guestRegistrationStarted || request.method !== 'POST' || request.path !== registrationPath) return;
        if (!cancelBoundGuest) throw new Error('Missing the real person’s cancel Action');
        guestRegistrationStarted = true;
        await cancelBoundGuest(boundId);
      },
      beforeForwardResponse(request) {
        if (!boundId && request.path === reportPath && request.statusCode === 200) {
          const report = ManagedControllerReportV1Schema.parse((JSON.parse(request.body?.text ?? 'null') as { body?: unknown } | null)?.body);
          if (report.result.kind === 'bound') boundId = report.managedId;
        }
        if (guestRegistrationStarted && request.method === 'POST' && request.path === registrationPath && request.statusCode !== null) {
          lateRegistrationStatus ??= request.statusCode;
        }
      },
    } : {}) });
    const account = await fixture.createAccount('native-wake-owner');
    assert.equal((await fixture.claimHomeOwner(account)).result.status, 'claimed');
    assert.ok(fixture.guestHomeCaCertificatePath, 'The native guest needs the real fixture Home public CA');
    const homeCaBytes = (await readFile(fixture.guestHomeCaCertificatePath)).toString('base64');
    // The provider's ordinary reviewed setup installs public OS trust and the
    // third-party Agent fixture before real bootstrap and enrollment.
    const selectors = { runtime: 'docker', configuration: { kind: 'image', image,
      setupScript: `printf '%s' '${homeCaBytes}' | base64 -d > /usr/local/share/ca-certificates/happier-fixture.crt && update-ca-certificates && printf '%s' '${vendorBytes}' | base64 -d > /usr/local/bin/journey-claude && chmod 0755 /usr/local/bin/journey-claude` } };
    const controller = await fixture.enrollDaemon(account);
    ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
    const homeId = fixture.serverId;
    const home = fixture;
    cancelBoundGuest = async managedId => {
      const target = { homeId, managedId };
      const read = await account.execute('machines.managed.get', target);
      if (!read.ok) throw new Error(`Could not read the bound guest (${read.errorCode})`);
      const bound = unwrapManagedMachineReadV1(ManagedGetOutputV1Schema.parse(read.result));
      assert.equal(bound.allocation, 'bound');
      assert.equal(bound.enrolledMachineId, undefined);
      assert.equal(nativeContainers(managedId).length, 1, 'Cancellation must target a real Docker resource');
      const canceled = await account.executeAsPerson('machines.managed.cancel', {
        ...target, expectedIntentRevision: bound.intentRevision,
      }, { presentUserConfirmation: { actionId: 'machines.managed.cancel' } });
      if (!canceled.ok) throw new Error(`Could not cancel the bound guest (${canceled.errorCode})`);
      assert.equal(ManagedCancelOutputV1Schema.parse(canceled.result).machine.creationState, 'canceled');
    };
    const result = await runManagedMachineJourney({ fixture, account, controller, ui, testDir,
      provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, selectors, selection: {},
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      guestDirectory: '/workspace', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
      requireSshTrust: false, sessionEnvironment: { HAPPIER_CLAUDE_PATH: '/usr/local/bin/journey-claude' },
      ...(cancelLateEnrollment ? { async assertLateEnrollmentRefused() {
        await waitFor(() => lateRegistrationStatus !== undefined, { context: 'late native Machine registration response' });
        assert.equal(lateRegistrationStatus, 409);
      } } : removeEnrolledGuest ? { async removeEnrolledGuest(guestMachineId: string) {
        assert.notEqual(guestMachineId, controller.target.machineId);
        const invokeFromParent = (actionId: string, actionInput: unknown) => runCliJson({
          testDir, cliHomeDir: controller.homeDir, serverUrl: home.actionServerApiUrl, webappUrl: home.server.baseUrl,
          env: { ...process.env, NODE_OPTIONS: home.sourceOptions, NODE_EXTRA_CA_CERTS: home.guestHomeCaCertificatePath },
          label: `paired-parent-${actionId}`, launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
          acceptedExitCodes: [1],
          args: ['actions', 'invoke', actionId, '--input-json', JSON.stringify(actionInput), '--yes', '--json'],
        });
        const removed = await invokeFromParent(MACHINE_REMOVE_ACTION_ID_V1, { serverId: homeId, machineId: guestMachineId });
        assert.equal(removed.ok, true, `Remove child: ${JSON.stringify(removed)}`);
        const parent = await invokeFromParent(MACHINE_LIST_ACTION_ID_V1, { serverId: homeId });
        assert.equal(parent.ok, true, `Parent CLI stays signed in: ${JSON.stringify(parent)}`);
      } } : {}) });
    if (cancelLateEnrollment) {
      assert.ok(result.managedId);
      assert.deepEqual(nativeContainers(result.managedId), [], 'Approved Delete must also leave the native resource absent');
    }
  } finally {
    try { await ui?.close(); } finally {
      try { await fixture?.stop(); } finally { await database?.stop(); }
    }
  }
}, 0);

// Opt in only on the selected Lima controller after obtaining the native allocation slot.
it.skipIf(process.env.HAPPIER_E2E_MANAGED_LIMA !== '1')('MR-R6 native Lima guest enrolls, runs an Agent and retains its identity across power and Send', async () => {
  const [{ startTeamSetupFFixture }, { startDatabaseWorkbenchPostgres },
    { connectUiPersonActionClient }, { runManagedMachineJourney }, { LimaResourceSchema }] = await Promise.all([
    import('../../src/testkit/teamSetupF'), import('../../src/testkit/process/databaseWorkbenchPostgres'),
    import('@happier-tests/ui-action-client'), import('../../src/scenarios/managedMachines.scenario'),
    import('../../../plugins/machine-lima/src/machine/schemas'),
  ]);
  const testDir = createRunDirs({ runLabel: 'managed-lima-journey' }).testDir('native-lima-agent-power-delete');
  const store = join(testDir, 'lima-store');
  await mkdir(store, { recursive: true });
  const vendorPath = join(testDir, 'sandbox-claude');
  execFileSync('cc', [resolve(repoRootDir(), 'packages/tests/fixtures/machines/sandbox-claude.c'), '-o', vendorPath]);
  const vendorBytes = await readFile(vendorPath);
  const database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let trustedManagedId: string | undefined;
  try {
    fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres', guestReachableHome: true,
      serverEnv: { DATABASE_URL: database.homeDatabaseUrl, HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
        HAPPIER_HOME_IROH_MODE: 'disabled' },
      captureRequestBody: request => request.path === '/v1/machines/managed/controller/report',
      async beforeForwardResponse(request) {
        if (request.path !== '/v1/machines/managed/controller/report' || request.statusCode !== 200) return;
        const report = ManagedControllerReportV1Schema.parse((JSON.parse(request.body?.text ?? 'null') as { body?: unknown } | null)?.body);
        if (report.result.kind !== 'bound' || report.managedId === trustedManagedId) return;
        assert.ok(fixture?.guestHomeCaCertificatePath, 'The native guest needs the fixture Home public CA');
        // E2EE reports keep native values sealed. Open the committed resource
        // through its actual Account before configuring this OS trust fixture.
        const read = await account.execute('machines.managed.get', { homeId: fixture.serverId, managedId: report.managedId });
        assert.equal(read.ok, true, JSON.stringify(read));
        if (!read.ok) throw new Error('Bound Lima resource unavailable to its actual custodian');
        const machine = unwrapManagedMachineReadV1(ManagedGetOutputV1Schema.parse(read.result));
        assert.ok(machine.resource);
        const resource = LimaResourceSchema.parse(machine.resource.value);
        execFileSync('limactl', ['shell', '--workdir=/', resource.instance, '--', 'sudo', '-n', '--', 'sh', '-c',
          'umask 022; cat > /usr/local/share/ca-certificates/happier-fixture.crt && update-ca-certificates'],
        { env: { ...process.env, LIMA_HOME: resource.store }, input: await readFile(fixture.guestHomeCaCertificatePath) });
        trustedManagedId = report.managedId;
      },
    });
    const account = await fixture.createAccount('native-lima-owner');
    assert.equal((await fixture.claimHomeOwner(account)).result.status, 'claimed');
    const controller = await fixture.enrollDaemon(account);
    // A fresh controller has no managed Lima and checking never installs it.
    // The person approves the provider's own repair Action in the Inbox, as the picker offers.
    const installed = await account.executeReviewed('action.invoke',
      { action: { pluginId: 'happier.machine.lima', localId: 'install' }, input: {} },
      { externalActionTarget: { kind: 'machine', machineId: controller.target.machineId },
        presentUserConfirmation: { actionId: 'action.invoke' } });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
    await runManagedMachineJourney({ fixture, account, controller, ui, testDir,
      provider: { pluginId: 'happier.machine.lima', localId: 'lima' },
      // Native Lima defaults from nl1 info: x86_64/qemu, 4 CPUs, 4GiB RAM,
      // 100GiB sparse disk. Options resolves the template before acquisition.
      selectors: { store, image: 'template:ubuntu-24.04', arch: 'x86_64', vmType: 'qemu',
        cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [] }, selection: { size: '4/4/100' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      guestDirectory: '/tmp', enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, requireSshTrust: false,
      sessionEnvironment: { HAPPIER_CLAUDE_PATH: '/tmp/journey-claude' },
      async installAgentFixture(machine) {
        assert.ok(machine.resource, 'Real enrollment must retain its native Lima resource');
        const resource = LimaResourceSchema.parse(machine.resource.value);
        // Only the third-party Agent is a fixture. Allocation, bootstrap,
        // enrollment, separate daemon, power, Home and Session remain real.
        execFileSync('limactl', ['shell', '--workdir=/', resource.instance, '--', 'sh', '-c',
          'umask 022; cat > /tmp/journey-claude && chmod 0755 /tmp/journey-claude'],
        { env: { ...process.env, LIMA_HOME: resource.store }, input: vendorBytes });
      },
    });
  } finally {
    try { await ui?.close(); } finally {
      try { await fixture?.stop(); } finally { await database.stop(); }
    }
  }
}, 0);
