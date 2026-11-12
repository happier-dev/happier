import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountReadContext, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createManagedNativeBootstrapIO, reconcileManagedMachine, type ManagedNativeInvocation } from '@happier-dev/cli-common/machines/managed';
import { runManagedMachineEnrollment } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { connectedAccountRuntime } from '../account.js';
import { MACHINE_PROVISIONER, PLUGIN, PLUGIN_MANIFEST } from '../manifest.js';
import { FLY_GUEST_BOOT, FlyExecRequestSchema, FlyMachineSchema } from './schemas.js';

const resource = { contributionRef: { pluginId: PLUGIN_MANIFEST.id, localId: 'fly' }, schemaVersion: 1,
  value: { app: { name: 'managed', ownership: 'existing' }, machineId: 'machine-1', volume: { id: 'vol-1', ownership: 'attached' } } };
const controller = { machineId: 'controller', installationId: 'controller-installation' };
const machine = ManagedMachineV1Schema.parse({ id: 'managed-fly', homeId: 'srv_fly', custodianAccountId: 'owner', controller,
  launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Fly', choices: {} },
  allocation: 'bound', creationState: 'active', resource, enrolledMachineId: 'ordinary-machine',
  desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
  enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
const correlation = ManagedEnrollmentCorrelationV1Schema.parse({ homeId: machine.homeId, managedId: machine.id,
  requestId: 'retry-existing', expectedIntentRevision: 1, controller, resource });
const unexpected = async (): Promise<never> => { throw new Error('Boot repair must reuse the admitted resource and enrollment'); };

describe('Fly through the shared managed native recipe', () => {
  it.skipIf(process.platform === 'win32')('preserves binary views and repairs retained native boot through real roles without another allocation or pairing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-fly-shared-'));
    let native = FlyMachineSchema.parse({ id: resource.value.machineId, instance_id: 'cold-rootfs', state: 'stopped', region: 'ams',
      config: { image: 'ubuntu:24.04', mounts: [{ volume: resource.value.volume.id, path: FLY_GUEST_BOOT.homeDir }],
        env: { HOME: FLY_GUEST_BOOT.homeDir, HAPPIER_HOME_DIR: FLY_GUEST_BOOT.happyHomeDir },
        init: { exec: FLY_GUEST_BOOT.command }, restart: { policy: 'no' }, services: [], auto_destroy: false } });
    const requests: Array<{ path: string; method: string }> = [];
    // Only native HTTP effects are simulated. The emitted file command runs on
    // a disposable filesystem; manifest registration, codecs and recipe are real.
    const http = createPluginHttpFixture({ async request(request) {
      const path = new URL(request.url).pathname;
      const method = request.method ?? 'GET';
      requests.push({ path, method });
      let value: unknown;
      if (path.endsWith('/exec') && method === 'POST') {
        const command = FlyExecRequestSchema.parse(JSON.parse(new TextDecoder().decode(request.body)));
        const stdout = execFileSync(command.command[0]!, command.command.slice(1), { input: command.stdin, encoding: 'utf8' });
        value = { exit_code: 0, stdout, stderr: '' };
      } else if (path.endsWith('/volumes/vol-1') && method === 'GET') {
        value = { id: resource.value.volume.id, state: 'created', attached_machine_id: native.id };
      } else if (path.endsWith('/machines/machine-1')) {
        if (method === 'POST') {
          const update: unknown = JSON.parse(new TextDecoder().decode(request.body));
          if (!update || typeof update !== 'object' || !('config' in update)) throw new Error('Missing native boot update');
          native = FlyMachineSchema.parse({ ...native, instance_id: 'boot-configured', state: 'started', config: update.config });
        }
        value = native;
      } else throw new Error(`Unexpected native HTTP effect ${method} ${path}`);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } });
    const credentials = new Map([['token', 'fixture-token']]);
    // Seed the credential-store fixture and use the real account materializer;
    // no native/client/recipe logic is replaced with a mock.
    const accountContext = { configuration: { values: { organizationSlug: 'selected-org' } },
      credentials: { get: async (id: string) => credentials.get(id) ?? null },
      signal: new AbortController().signal, services: { http } } as unknown as ConnectedAccountReadContext;
    const materialize: ConnectedAccountsService['materialize'] = (_purpose, request, options) =>
      connectedAccountRuntime.materialize(request, accountContext, options);
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: PLUGIN,
      services: { http, connectedAccounts: { materialize } as ConnectedAccountsService } });
    const invoke: ManagedNativeInvocation = async (role, body) => {
      const localId = role === 'putFile' ? MACHINE_PROVISIONER.bootstrapTransport.putFile
        : role === 'exec' ? MACHINE_PROVISIONER.bootstrapTransport.exec
          : role === 'bootstrap' ? MACHINE_PROVISIONER.actions.bootstrap
            : role === 'inspect' ? MACHINE_PROVISIONER.actions.inspect : undefined;
      if (!localId) throw new Error(`Unexpected managed role ${role}`);
      // The public testkit validates this shared-port input through the real Action schema.
      return await kit.invokeAction(localId, body as JsonValue, { surface: 'plugin' });
    };
    try {
      const io = createManagedNativeBootstrapIO(correlation, invoke);
      const payload = new Uint8Array([7, 0, 255, 128, 42]);
      const path = join(directory, 'installer');
      await io.putFile({ path, bytes: payload.subarray(1, 4) });
      expect(await readFile(path)).toEqual(Buffer.from([0, 255, 128]));
      expect(await io.exec({ command: 'cat', input: '\uFEFF秘密\n' })).toMatchObject({ stdout: '\uFEFF秘密\n', status: 0 });
      let admissionReads = 0;
      const reports: unknown[] = [];
      const result = await reconcileManagedMachine({ machine, action: 'machines.managed.bootstrap.retry', requestId: correlation.requestId,
        provisioner: { id: 'fly', ...MACHINE_PROVISIONER },
        home: { correlation: () => correlation, async row(path, body) {
          expect(path).toBe('report');
          reports.push(body);
          return machine;
        }, submit: unexpected,
          reportIssuedAcquireFact: unexpected, preparePendingAcquireBoundReport: unexpected },
        createNative: () => ({ prepareRoles: unexpected, invoke }), waitForObservation: unexpected,
        bootstrap: { preflight: unexpected, prepareCredential: unexpected, readCredential: unexpected,
          async enroll(input) {
            expect(reports[0]).toMatchObject({ observation: { availability: 'unavailable', reason: 'bootstrap.incomplete' } });
            const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: machine.homeId,
              canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] },
              authority: 'trusted_enrollment' });
            const enrolled = await runManagedMachineEnrollment({ correlation: input.correlation, target, channel: 'stable', carrier: input.carrier }, {
              readCurrentManagedRow: async () => { admissionReads++; return input.machine; }, native: io,
              createPromptId: () => 'unused', runTask: unexpected, approveLocalAuthRequest: unexpected,
            });
            return { ...input.machine, enrolledMachineId: enrolled.machineId };
          } },
      });
      expect(result).toEqual(machine);
      expect(reports.at(-1)).toMatchObject({ observation: { availability: 'present', power: 'running' } });
      expect(admissionReads).toBe(1);
      expect(native).toMatchObject({ id: resource.value.machineId, state: 'started', config: {
        env: { HOME: FLY_GUEST_BOOT.homeDir, HAPPIER_HOME_DIR: FLY_GUEST_BOOT.happyHomeDir },
        mounts: [{ volume: resource.value.volume.id, path: FLY_GUEST_BOOT.homeDir }], restart: { policy: 'no' }, auto_destroy: false,
        init: { exec: ['sh', '-c', expect.stringContaining("'daemon' 'start-sync'")] },
      } });
      expect(requests.filter(request => request.method === 'POST' && !request.path.endsWith('/exec')))
        .toEqual([{ method: 'POST', path: '/v1/apps/managed/machines/machine-1' }]);
      expect(await readFile(path)).toEqual(Buffer.from([0, 255, 128]));
    } finally {
      await kit.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
