import { createSetupOutputFixture, setupOutputCases, type SetupOutputFixture } from '../../src/testkit/machines/setupOutputFixture';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listActionSpecs, SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { io } from 'socket.io-client';
import { callSocketRpc } from '@happier-dev/sync-client';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { connectUiActionClient, createUiMachineOutputFixture, createAccountOutputFixture, createMachineClientEnrollmentOutputFixture, allowRealActionServerSocketBoundary } from '@happier-tests/ui-action-client';
import { createNativeOutputFixture, nativeOutputCases, type NativeOutputFixture } from '../../src/testkit/machines/nativeOutputFixture';
import { createStorageOutputFixture, storageOutputCases, type StorageOutputFixture } from '../../src/testkit/machines/storageOutputFixture';
import { createProcessOutputFixture, processOutputCases, type ProcessOutputFixture } from '../../src/testkit/machines/processOutputFixture';
import { createManagedControllerOutputFixture, managedControllerOutputCases, type ManagedControllerOutputFixture,
  createManagedHomeOutputFixture, managedHomeOutputCases,
  createManagedBootstrapResponseOutputFixture } from '../../src/testkit/machines/managedControllerOutputFixture';
import { readManagedBootstrapResponseOutputInput } from '../../../../apps/ui/sources/dev/testkit/machineClientEnrollmentOutputFixture';
import { connectOutputReceiver } from '../../src/testkit/machines/connectedOutputReceiver';
import { createInventoryOutputFixture, inventoryOutputCases, type InventoryOutputFixture } from '../../src/testkit/machines/inventoryOutputFixture';
import { createServiceOutputFixture, serviceOutputCases, type ServiceOutputFixture } from '../../src/testkit/machines/serviceOutputFixture';
import { withConfiguredDaemonTestHome } from '../../../../apps/cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readOrCreateInstallationIdentity } from '../../../../apps/cli/src/daemon/identity/store';

const specifications = listActionSpecs().filter(spec => spec.id.startsWith('machines.'));
type ProducerCase = Readonly<{ input: () => unknown | Promise<unknown>; prepare?: () => Promise<void> }>;
type Home = Readonly<{
  baseUrl: string; homeId: string; ownerAccountId: string; ownerToken: string;
  memberAccountId: string; memberToken: string; installedToken: string;
  createOutputMachine(input: Readonly<{ id: string; active?: boolean; accountId?: string }>): Promise<string>;
  createOutputManagedMachine(input: Readonly<{id: string; setupGuestId?: string; boundResource?: boolean}>): Promise<Readonly<{managedId: string; intentRevision: number}>>;
  close(): Promise<void>;
}>;
const serverTestkitPath = '../../../../apps/server/sources/testkit/browserMachineActionServer.testkit';
const machineId = 'output-contract-machine';
const poolId = 'bb74b8ed-97b4-4991-9d37-0fabd44a714a';
let home: Home;
let client: Awaited<ReturnType<typeof connectUiActionClient>>;
let directory: string;
let installation: MachineInstallationIdentityV1;
let configuredHome: Promise<void> | undefined;
let releaseConfiguredHome: (() => void) | undefined;
let receiver: Awaited<ReturnType<typeof connectOutputReceiver>> | undefined;
let inventory: InventoryOutputFixture | undefined;
let browser: ReturnType<typeof io> | undefined;
let realSocketBoundary: ReturnType<typeof allowRealActionServerSocketBoundary> | undefined;

function assertProducerOutput(spec: (typeof specifications)[number], output: unknown, producer: string) {
  const direct = spec.outputSchema?.safeParse(output);
  const signedSchema = SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS[spec.id as keyof typeof SIGNED_ROOT_ACTION_OUTPUT_SCHEMAS];
  const signed = signedSchema?.safeParse(output);
  const issues = (result: typeof direct) => result?.success ? [] : result?.error.issues.map(issue => ({
    code: issue.code, path: issue.path,
  })) ?? [{ code: 'missing_schema', path: [] }];
  // Report schema locations only. Native output and private Account content
  // never enter the aggregate's diagnostic transcript.
  console.info(JSON.stringify({ gate: 'machines-output-contract', id: spec.id, producer,
    direct: direct?.success === true, signed: signed?.success === true }));
  expect.soft(issues(direct), `${spec.id}: ${producer} direct output`).toEqual([]);
  expect.soft(issues(signed), `${spec.id}: ${producer} signed/public output`).toEqual([]);
}

/** Setup through the real Home route, never a canned Action/RPC result. */
async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${home.baseUrl}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${home.ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(`Fixture route ${path} failed with HTTP ${response.status}`);
  return payload;
}

function poolRevision(output: unknown): number {
  if (output && typeof output === 'object' && 'pool' in output && output.pool
    && typeof output.pool === 'object' && 'revision' in output.pool && typeof output.pool.revision === 'number') {
    return output.pool.revision;
  }
  throw new Error('Actual Home pool projection omitted its revision');
}

const poolDefinition = { poolId, name: 'Output contract pool', members: [] };
const ensurePool = async () => {
  const response = await fetch(`${home.baseUrl}/v1/machines/pools/get`, { method: 'POST',
    headers: { Authorization: `Bearer ${home.ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ poolId }) });
  if (response.status === 404) await post('/v1/machines/pools/create', poolDefinition);
  else if (!response.ok) throw new Error(`Fixture pool lookup failed with HTTP ${response.status}`);
};
const presetId = 'output-contract-preset';
const presetDefinition = () => ({ id: presetId, homeId: home.homeId, name: 'Output contract preset',
  owner: { kind: 'account', accountId: home.ownerAccountId }, setup: { scripts: [] } });
const ensurePreset = async () => {
  const value = await post('/v1/machines/presets/get', { homeId: home.homeId, id: presetId });
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'refused') {
    await post('/v1/machines/presets/create', presetDefinition());
  }
};
async function presetRevision(): Promise<number> {
  const value = await post('/v1/machines/presets/get', { homeId: home.homeId, id: presetId });
  if (value && typeof value === 'object' && 'preset' in value && value.preset && typeof value.preset === 'object'
    && 'revision' in value.preset && typeof value.preset.revision === 'number') return value.preset.revision;
  throw new Error('Actual Home preset projection omitted its revision');
}
const accountTarget = () => ({ serverId: home.homeId, machineId });
const cases = new Map<ActionId, ProducerCase>([
  ['machines.list', { input: () => ({}) }],
  ['machines.metadata.update', { input: () => ({ ...accountTarget(), patch: { displayName: 'Output contract Machine' } }) }],
  ['machines.managed.list', { input: () => ({ homeId: home.homeId }) }],
  ['machines.presets.list', { input: () => ({ homeId: home.homeId }) }],
  // This is the preset domain's schema-declared terminal result, produced after
  // its real DB lookup, rather than a generic pre-dispatch refusal.
  ['machines.presets.get', { input: () => ({ homeId: home.homeId, id: 'absent-preset' }) }],
  ['machines.presets.create', { input: presetDefinition }],
  ['machines.presets.update', { prepare: ensurePreset, input: async () => ({ homeId: home.homeId, id: presetId,
    expectedRevision: await presetRevision(), patch: { name: 'Updated output contract preset' } }) }],
  ['machines.presets.archive', { prepare: ensurePreset, input: async () => ({ homeId: home.homeId, id: presetId,
    expectedRevision: await presetRevision() }) }],
  ['machines.presets.restore', { prepare: ensurePreset, input: async () => ({ homeId: home.homeId, id: presetId,
    expectedRevision: await presetRevision() }) }],
  ['machines.access.grants.list', { input: accountTarget }],
  ['machines.presence.read', { input: accountTarget }],
  ['machines.resources.policy.get', { input: accountTarget }],
  ['machines.roles.list', { input: accountTarget }],
  ['machines.roles.get', { input: accountTarget }],
  ['machines.worker.policy.get', { input: accountTarget }],
  ['machines.worker.policy.set', { input: () => ({ ...accountTarget(), expectedMetadataVersion: 0,
    expectedPolicy: { accepting: true, runAtMost: null }, policy: { accepting: true, runAtMost: 2 } }) }],
  ['machines.pools.list', { input: () => ({}) }],
  ['machines.pools.create', { input: () => poolDefinition }],
  ['machines.pools.get', { prepare: ensurePool, input: () => ({ poolId }) }],
  ['machines.pools.update', { prepare: ensurePool, input: async () => ({ ...poolDefinition,
    expectedRevision: poolRevision(await post('/v1/machines/pools/get', { poolId })), name: 'Updated output contract pool' }) }],
  ['machines.pools.delete', { prepare: ensurePool, input: async () => ({ poolId,
    expectedRevision: poolRevision(await post('/v1/machines/pools/get', { poolId })) }) }],
  ['machines.pools.resolve', { prepare: ensurePool, input: () => ({ poolId, requestKey: randomUUID(), purpose: 'session' }) }],
]);

const fixtureIds = new Set<ActionId>([...cases.keys(), ...nativeOutputCases.keys(), ...storageOutputCases.keys(),
  ...processOutputCases.keys(), ...inventoryOutputCases.keys(), ...serviceOutputCases.keys(), ...setupOutputCases.keys(),
  ...managedControllerOutputCases.keys(), ...managedHomeOutputCases.keys()]);

describe('Machines real producer output contracts', () => {
  describe('native storage catalog, reviewed mutation and scan producers', () => {
    let fixture: StorageOutputFixture;
    beforeAll(async () => { fixture = await createStorageOutputFixture(); });
    afterAll(async () => { await fixture?.close(); });
    it.each(specifications.filter(spec => storageOutputCases.has(spec.id)))('$id emits its declared direct and signed output', async spec => {
      const scenario = storageOutputCases.get(spec.id)!;
      const input = await scenario.input(fixture);
      expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
      const output = await (scenario.execute ? scenario.execute(fixture, input) : fixture.invoke(spec.id, input));
      assertProducerOutput(spec, output, 'storage receiver');
    });
  });

  describe('native process lifecycle and Guard producers', () => {
    let fixture: ProcessOutputFixture;
    beforeAll(async () => { fixture = await createProcessOutputFixture(); });
    afterAll(async () => { await fixture?.close(); });
    it.each(specifications.filter(spec => processOutputCases.has(spec.id)))('$id emits its declared direct and signed output', async spec => {
      const scenario = processOutputCases.get(spec.id)!;
      const input = await scenario.input(fixture);
      expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
      const output = await (scenario.execute ? scenario.execute(fixture, input) : fixture.invoke(spec.id, input));
      assertProducerOutput(spec, output, 'process/Guard receiver');
    });
  });

  describe('native service, administration and reachability producers', () => {
    let fixture: ServiceOutputFixture;
    beforeAll(async () => { fixture = await createServiceOutputFixture(); });
    afterAll(async () => { await fixture?.close(); });
    it.each(specifications.filter(spec => serviceOutputCases.has(spec.id)))('$id emits its declared direct and signed output', async spec => {
      const scenario = serviceOutputCases.get(spec.id)!;
      const input = await scenario.input(fixture);
      expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
      const output = await (scenario.execute ? scenario.execute(fixture, input) : fixture.invoke(spec.id, input));
      assertProducerOutput(spec, output, 'service/native receiver');
    });
  });

  describe('authenticated RPC → registered native producer owners', () => {
    let fixture: NativeOutputFixture;
    beforeAll(async () => { fixture = await createNativeOutputFixture(); });
    afterAll(async () => { await fixture?.close(); });
    it.each(specifications.filter(spec => nativeOutputCases.has(spec.id)))('$id emits its declared direct and signed output', async spec => {
      const scenario = nativeOutputCases.get(spec.id);
      if (!scenario) throw new Error(`Missing native producer fixture for ${spec.id}`);
      const input = await scenario.input(fixture);
      expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
      const output = await (scenario.execute ? scenario.execute(fixture, input) : fixture.invoke(spec.id, input));
      assertProducerOutput(spec, output, 'native receiver');
    });
  });

  describe('native setup recipe, key preparation and Workflow rollout producers', () => {
    let fixture: SetupOutputFixture;
    beforeAll(async () => { fixture = await createSetupOutputFixture(); });
    afterAll(async () => { await fixture?.close(); });
    it.each(specifications.filter(spec => setupOutputCases.has(spec.id)))('$id emits its declared direct and signed output', async spec => {
      const scenario = setupOutputCases.get(spec.id)!;
      const input = await scenario.input(fixture);
      expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
      const output = await (scenario.execute ? scenario.execute(fixture, input) : fixture.invoke(spec.id, input));
      assertProducerOutput(spec, output, 'installed setup/Workflow producer');
    });
  });

  describe('native managed controller and contributed provisioner producers', () => {
    let fixture: ManagedControllerOutputFixture;
    beforeAll(async () => { fixture = await createManagedControllerOutputFixture(); });
    afterAll(async () => { await fixture?.close(); });
    it.each(specifications.filter(spec => managedControllerOutputCases.has(spec.id)))('$id emits its declared direct and signed output', async spec => {
      const scenario = managedControllerOutputCases.get(spec.id)!;
      const input = await scenario.input(fixture);
      expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
      const output = await (scenario.execute ? scenario.execute(fixture, input) : fixture.invoke(spec.id, input));
      assertProducerOutput(spec, output, 'managed controller/contributed provider');
    });
  });

  describe('UI factory → authenticated Home → real SQLite producer', () => {
    beforeAll(async () => {
      await new Promise<void>((ready, failed) => {
        configuredHome = withConfiguredDaemonTestHome({ prefix: 'machines-output-contracts-',
          env: { HAPPIER_ACTIVE_SERVER_ID: 'output-contract-home', HAPPIER_SERVER_URL: undefined } }, async ({ homeDir }) => {
          try {
          directory = homeDir;
          installation = await readOrCreateInstallationIdentity();
      // The package-owned integration loader retains each app's source aliases.
      const server = await import(serverTestkitPath) as Readonly<{
        startBrowserMachineActionServer(input: Readonly<{ machineId: string;
          installation: MachineInstallationIdentityV1; happyHomeDir: string; publicEndpoint?: string }>): Promise<Home>;
      }>;
      home = await server.startBrowserMachineActionServer({ machineId, installation, happyHomeDir: directory,
        publicEndpoint: 'https://output-contract.example' });
          realSocketBoundary = allowRealActionServerSocketBoundary(home.baseUrl);
          receiver = await connectOutputReceiver({ directory, serverId: 'output-contract-home', machineId, home });
          ready();
          await new Promise<void>(release => { releaseConfiguredHome = release; });
          } catch (error) { failed(error); throw error; }
        });
        void configuredHome.catch(failed);
      });
    });

    afterAll(async () => {
      try { await inventory?.close(); browser?.disconnect(); await client?.close(); }
      finally { try { await receiver?.close(); await home?.close(); }
        finally { realSocketBoundary?.dispose(); releaseConfiguredHome?.(); await configuredHome; } }
    });

    it('emits declared direct and signed outputs for the real Home producer families', async () => {
      // UI's canonical per-test cleanup retires profiles and credentials. A
      // composed journey retains one real connected client for all its steps.
      client = await connectUiActionClient({ serverUrl: home.baseUrl, publicEndpoint: 'https://output-contract.example',
        credentials: { token: home.ownerToken } });
      await expect.poll(() => client.isAccountReady()).toBe(true);
      await expect.poll(() => client.isMachineActive(machineId)).toBe(true);
      for (const spec of specifications.filter(spec => cases.has(spec.id))) {
      const scenario = cases.get(spec.id);
      if (!scenario) throw new Error(`Missing producer fixture for ${spec.id}`);
      try {
      await scenario.prepare?.();
      const input = await scenario.input();
      expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
      const execution = await client.executeConfirmed(spec.id, input, { surface: 'ui', authority: 'present_user', serverId: client.serverId });
      expect.soft(execution, `${spec.id}: real producer must settle an output`).toMatchObject({ ok: true });
      if (!execution.ok) continue;
      assertProducerOutput(spec, execution.result, 'UI to Home');
      } catch (error) {
        expect.soft(error instanceof Error ? error.message : String(error), `${spec.id}: producer fixture failed`).toBeUndefined();
      }
      }
      if (!receiver) throw new Error('Missing installed real Machine receiver');
      browser = io(home.baseUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false,
        reconnection: false, auth: { token: home.ownerToken, ...buildAccountStoredContentCompatibilitySocketAuthV1(
          CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
      await new Promise<void>((resolve, reject) => { browser!.once('connect', resolve); browser!.once('connect_error', reject); browser!.connect(); });
      inventory = await createInventoryOutputFixture({ machine: receiver.machine, directory,
        target: { serverId: home.homeId, machineId, installationId: installation.installationId, custodianAccountId: home.ownerAccountId },
        transport: (method, input) => callSocketRpc({ socket: browser!, target: { kind: 'machine', id: machineId }, method,
          params: input, content: { mode: 'plain' }, timeoutMs: 10_000 }),
        readAccess: async signal => {
          const response = await fetch(`${home.baseUrl}/v1/machines/${machineId}/access`, {
            signal, headers: { Authorization: `Bearer ${home.ownerToken}` } });
          if (!response.ok) throw new Error(`Actual Machine access read failed: HTTP ${response.status}`);
          return response.json();
        } });
      const managedHome = await createManagedHomeOutputFixture({ ...home, machineId, installationId: installation.installationId });
      try {
        for (const spec of specifications.filter(spec => managedHomeOutputCases.has(spec.id))) {
          try {
            const scenario = managedHomeOutputCases.get(spec.id)!;
            const input = await scenario.input(managedHome);
            expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
            const output = await managedHome.invoke(spec.id, input);
            assertProducerOutput(spec, output, 'CLI Account to real Home');
          } catch (error) { expect.soft(error instanceof Error ? error.message : String(error), `${spec.id}: managed Home fixture failed`).toBeUndefined(); }
        }
      } finally { await managedHome.close(); }
      for (const spec of specifications.filter(spec => inventoryOutputCases.has(spec.id))) {
        try {
          const scenario = inventoryOutputCases.get(spec.id)!;
          const input = await scenario.input(inventory);
          expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
          const output = await (scenario.execute ? scenario.execute(inventory, input) : inventory.invoke(spec.id, input));
          assertProducerOutput(spec, output, 'CLI adapter to installed receiver');
        } catch (error) { expect.soft(error instanceof Error ? error.message : String(error), `${spec.id}: inventory fixture failed`).toBeUndefined(); }
      }
      const account = createAccountOutputFixture({ ...home, serverId: client.serverId, machineId, replacementMachineId: machineId });
      for (const id of account.cases.keys()) fixtureIds.add(id);
      try {
        for (const spec of specifications.filter(spec => account.cases.has(spec.id))) {
          try {
            const input = await account.cases.get(spec.id)!();
            expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
            const execution = await account.execute(spec.id, input);
            expect.soft(execution, `${spec.id}: real Account producer`).toMatchObject({ ok: true });
            if (execution.ok) assertProducerOutput(spec, execution.result, 'UI Account to real Home');
          } catch (error) { expect.soft(error instanceof Error ? error.message : String(error), `${spec.id}: Account fixture failed`).toBeUndefined(); }
        }
      } finally { await account.close(); }
      const ui = createUiMachineOutputFixture(client.serverId);
      for (const id of ui.cases.keys()) fixtureIds.add(id);
      try {
        for (const spec of specifications.filter(spec => ui.cases.has(spec.id))) {
          try {
            const input = await ui.cases.get(spec.id)!();
            expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
            const execution = await ui.execute(spec.id, input);
            expect.soft(execution, `${spec.id}: real client producer`).toMatchObject({ ok: true });
            if (!execution.ok) continue;
            assertProducerOutput(spec, execution.result, 'UI native task producer');
          } catch (error) {
            expect.soft(error instanceof Error ? error.message : String(error), `${spec.id}: client fixture failed`).toBeUndefined();
          }
        }
      } finally { ui.close(); }
      const bootstrap = await createManagedBootstrapResponseOutputFixture({ ...home, machineId,
        installationId: installation.installationId, receiver: receiver.machine });
      try {
      const enrollment = await createMachineClientEnrollmentOutputFixture({ serverId: client.serverId, homeId: home.homeId,
        machineId, baseUrl: home.baseUrl, publicEndpoint: 'https://output-contract.example', credentials: { token: home.ownerToken },
        prepareManagedBootstrapResponse: async () => readManagedBootstrapResponseOutputInput({ serverId: client.serverId,
          machine: bootstrap.machine, operation: bootstrap.operation }) });
      for (const id of enrollment.cases.keys()) fixtureIds.add(id);
      try {
        for (const spec of specifications.filter(spec => enrollment.cases.has(spec.id))) {
          try {
            const input = await enrollment.cases.get(spec.id)!();
            expect(spec.inputSchema.safeParse(input).success, `${spec.id}: fixture input`).toBe(true);
            const execution = await enrollment.execute(spec.id, input);
            expect.soft(execution, `${spec.id}: real enrollment/update producer`).toMatchObject({ ok: true });
            if (execution.ok) assertProducerOutput(spec, execution.result, 'UI enrollment/Updates owner');
          } catch (error) { expect.soft(error instanceof Error ? error.message : String(error), `${spec.id}: enrollment fixture failed`).toBeUndefined(); }
        }
      } finally { await enrollment.close(); }
      } finally { await bootstrap.close(); }

    });
  });
  it('has a real producer fixture for every registered Machines Action', () => {
    const missing = specifications.filter(spec => !fixtureIds.has(spec.id)).map(spec => `${spec.id} (${spec.executionPlacement})`);
    const extra = [...fixtureIds].filter(id => !specifications.some(spec => spec.id === id));
    // Missing fixtures are test-completion gaps, never product mismatch REDs.
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

});
