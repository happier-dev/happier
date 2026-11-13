import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { updateSettings } from '@/persistence';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import type { ManagedMachineAcquisitionDriverInput } from './acquire';
import { initializeManagedMachineEnrollmentPolicies } from './enrollmentPolicy';

const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
const controller = { machineId: 'controller', installationId: 'installation' };
// A member creates on another Account's controller: that controller holds no
// requester Account material, and the child dispatcher seals a fresh codec.
const memberRoot = ExternalActionExecutionAuthorizationV1Schema.parse({
  v: 1,
  token: 'root-proof',
  binding: {
    serverIdentityId: 'srv_home',
    accountId: 'member',
    authentication: { kind: 'account', tokenEpoch: 2 },
    actionId: 'machines.managed.acquire',
    requestId: 'creation',
    requestEnvelopeDigest: 'a'.repeat(43),
    machineId: controller.machineId,
    custodianAccountId: 'company',
    installationId: controller.installationId,
    target: { kind: 'machine', machineId: controller.machineId },
    accountEncryptionMode: 'e2ee',
  },
});
const machine = ManagedMachineV1Schema.parse({
  id: 'managed',
  homeId: 'srv_home',
  custodianAccountId: 'company',
  enrollmentAccountId: 'member',
  controller,
  launch: {
    provider: { pluginId: 'acme.compute', localId: 'vm' },
    schemaVersion: 1,
    name: 'guest',
    choices: {},
  },
  resource: {
    contributionRef: { pluginId: 'acme.compute', localId: 'vm' },
    schemaVersion: 1,
    value: { id: 'paid-guest' },
  },
  allocation: 'bound',
  creationState: 'active',
  enrolledMachineId: 'guest',
  desired: 'start',
  desiredWhen: 'now',
  intentRevision: 0,
  retention: { kind: 'until-delete' },
  wakeOnAcceptedMessage: false,
  enrollmentIdentity: {
    kind: 'dedicatedDaemonUser',
    username: 'happier',
    serviceMode: 'user',
    role: 'server',
    adminAccessAtCreation: 'none',
  },
});

describe('managed enrollment policy children', () => {
  beforeEach(async () => {
    await updateSettings((settings) => ({
      ...settings,
      servers: {
        ...settings.servers,
        'home-profile': {
          id: 'home-profile',
          name: 'Home',
          serverUrl: 'https://home.example',
          webappUrl: 'https://home.example',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
          homeConnectionDescriptorAuthority: 'exact',
          homeConnectionDescriptor: {
            v: 1,
            homeServerIdentityId: 'srv_home',
            canonicalServerUrl: 'https://home.example',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.example' }],
          },
        },
      },
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('dispatches a member creation administrator child on an e2ee controller without requester Account material', async () => {
    const paths: string[] = [];
    // Home HTTP is the system boundary; the dispatcher's own admission runs for real.
    vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      paths.push(new URL(url).pathname);
      return { status: 503, data: { error: 'unavailable' } };
    });
    const input = {
      serverUrl: 'https://home.example',
      homeId: 'srv_home',
      controller,
      homeTarget: await resolveCliHomeTarget({
        kind: 'saved_profile',
        profileRef: 'home-profile',
      }),
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
    } as unknown as ManagedMachineAcquisitionDriverInput;
    await expect(
      initializeManagedMachineEnrollmentPolicies(input, machine, {
        requestId: 'creation',
        context: {
          surface: 'cli',
          actionRequestId: 'creation',
          serverId: 'home-profile',
          externalActionExecutionAuthorization: memberRoot,
          externalActionTarget: memberRoot.binding.target,
        },
      }),
    ).rejects.toBeDefined();
    // The canonical child dispatcher, not a caller precheck, owns this admission.
    expect(paths[0]).toBe('/v1/machines/managed/controller/context');
  });
});
