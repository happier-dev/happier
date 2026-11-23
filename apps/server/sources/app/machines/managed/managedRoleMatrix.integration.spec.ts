import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createManagedPolicyCensusProofV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { registerManagedMachineRoutes } from './managedRoutes';
import { createCreatorFixture } from './managedCreatorAccess.testkit';

/**
 * One managed-row decider (owner rulings 2026-10-31 and 2026-11-10): the custodian and controller Manage
 * see and act on the row with its credential selectors; the guest's owner and other guest grantees get Use
 * with selectors redacted; controller Can-use and other Accounts get nothing.
 */
describe('managed row role matrix at the HTTP ingress', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-managed-role-matrix-',
      initAuth: false,
      initEncrypt: true,
      env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}` },
    });
  }, 120_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('decides visibility, selector redaction and target admission once per actor', async () => {
    const { homeId, custodian, creator, stranger, controller, launch, row } =
      await createCreatorFixture();
    const manager = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const user = await db.account.create({ data: { encryptionMode: 'plain' } });
    const guest = await db.machine.create({
      data: {
        id: randomUUID(),
        accountId: creator.id,
        metadata: '{}',
        installationId: randomUUID(),
      },
    });
    await db.managedMachine.update({
      where: { id: row.id },
      data: {
        enrolledMachineId: guest.id,
        // A one-off allocation: its launch carries the credential selectors under test.
        presetId: null,
        presetRevision: null,
        allocation: 'bound',
        resource: {
          contributionRef: launch.provider,
          schemaVersion: 1,
          value: { id: 'matrix-native-resource' },
        },
        launch: {
          ...launch,
          credentials: [
            {
              purpose: { consumer: launch.provider, purpose: 'native' },
              account: {
                service: {
                  pluginId: 'fixture.creator',
                  localId: 'native-account',
                },
                accountId: 'private-connection',
              },
            },
          ],
        },
        bootstrapCredentialRef: {
          kind: 'shared_resource',
          resourceId: 'private-bootstrap',
        },
      },
    });
    // Direct grant rows: this fixture's controller carries no content key, which the grant service requires.
    const grant = (accountId: string, accessLevel: 'view' | 'admin') => db.machineGrant.create({ data: {
      principalKind: 'account', accountId, machineId: controller.id, accessLevel, createdByAccountId: custodian.id } });
    await grant(manager.id, 'admin');
    await grant(user.id, 'view');
    const keys = tweetnacl.sign.keyPair();
    await db.machine.update({
      where: { id: controller.id },
      data: { installationPublicKey: Buffer.from(keys.publicKey) },
    });
    const placement = {
      machineId: controller.id,
      installationId: controller.installationId!,
    };

    const app = createAuthenticatedTestApp();
    registerManagedMachineRoutes(app);
    await app.ready();
    const managed = (
      actorId: string,
      action: 'machines.managed.list' | 'machines.managed.get',
      input: object,
    ) =>
      app.inject({
        method: 'POST',
        url: managedMachineActionEndpointPathV1(action),
        headers: { 'x-test-user-id': actorId },
        payload: input,
      });
    const targetAdmitted = async (
      requesterAccountId: string,
      committedSessionId?: string,
    ) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/machines/managed/controller/policies',
        headers: { 'x-test-user-id': custodian.id },
        payload: {
          homeId,
          controller: placement,
          managedId: row.id,
          proof: createManagedPolicyCensusProofV1({
            homeId,
            controller: placement,
            custodianAccountId: custodian.id,
            privateKey: keys.secretKey,
          }),
          target: {
            requesterAccountId,
            ...(committedSessionId ? { committedSessionId } : {}),
          },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().targetAdmitted as boolean;
    };
    const expectRead = async (
      actorId: string,
      expected: 'selectors' | 'redacted' | 'refused',
    ) => {
      const got = await managed(actorId, 'machines.managed.get', {
        homeId,
        managedId: row.id,
      });
      const listed = (
        await managed(actorId, 'machines.managed.list', { homeId })
      )
        .json()
        .machines.find((machine: { id: string }) => machine.id === row.id);
      if (expected === 'refused') {
        expect(got.statusCode, got.body).toBe(403);
        expect(listed).toBeUndefined();
        return;
      }
      expect(got.statusCode, got.body).toBe(200);
      for (const machine of [got.json(), listed]) {
        if (expected === 'selectors') {
          expect(machine.launch.credentials).toHaveLength(1);
          expect(machine.bootstrapCredentialRef).toEqual({
            kind: 'shared_resource',
            resourceId: 'private-bootstrap',
          });
        } else {
          expect(machine.launch).not.toHaveProperty('credentials');
          expect(machine).not.toHaveProperty('bootstrapCredentialRef');
        }
      }
    };
    try {
      await expectRead(custodian.id, 'selectors');
      await expectRead(manager.id, 'selectors');
      await expectRead(creator.id, 'redacted');
      await expectRead(user.id, 'refused');
      await expectRead(stranger.id, 'refused');

      // The guest's owner who also holds controller Manage is a Manage reader, not a redacted creator.
      await grant(creator.id, 'admin');
      await expectRead(creator.id, 'selectors');

      // A session-bound sandbox admits its committed creator Session and every Manage holder.
      await db.managedMachine.update({
        where: { id: row.id },
        data: {
          admittedInput: {
            enrollmentAccountId: creator.id,
            acquisitionMode: 'resource-bound',
          },
        },
      });
      const session = await db.session.create({
        data: {
          accountId: creator.id,
          tag: randomUUID(),
          metadata: '{}',
          managedCreationId: row.id,
        },
      });
      expect(await targetAdmitted(custodian.id)).toBe(true);
      expect(await targetAdmitted(manager.id)).toBe(true);
      expect(await targetAdmitted(creator.id, session.id)).toBe(true);
      expect(await targetAdmitted(user.id)).toBe(false);
      expect(await targetAdmitted(stranger.id)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
