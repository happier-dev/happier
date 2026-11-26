import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  MachineOperationProtocolCapabilitiesV1Schema,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import {
  MachineProvisionerContributionV1Schema,
  defineMachineProvisionerSchemas,
  MachineProvisionerCheckResultProtocolV1Schema,
  MachineProvisionerBootstrapCarrierV1Schema,
  MachineProvisionerObservationV1Schema,
  MachineProvisionerPowerResultV1Schema,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import {
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { auth } from '@/app/auth/auth';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { registerManagedMachineRoutes } from './managedRoutes';

/**
 * C115: owner Stop/Delete of a controllerless managed row through the real
 * Account root issuance, HTTP authentication, signed-request verifier and
 * managed admission. Only the remote daemon is replaced: the test signs the
 * exact POST with the installed daemon key, as the daemon does.
 */
describe('controllerless managed row owner control through real signed issuance', () => {
  const homeId = `srv_${'c'.repeat(32)}`;
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-managed-controllerless-',
      initAuth: true,
      initEncrypt: true,
      env: {
        HAPPIER_SERVER_IDENTITY_ID: homeId,
        AUTH_REQUIRED_LOGIN_PROVIDERS: '',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      },
    });
  }, 180_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  const provisioner = MachineProvisionerContributionV1Schema.parse({
    id: 'cloud',
    title: 'Cloud',
    icon: 'machine',
    resourceKind: 'vm',
    schemaVersion: 1,
    launchSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    resourceSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    platforms: ['linux'],
    prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'not-billed' },
    retention: { supportedIntents: ['start', 'stop', 'delete'] },
    actions: {
      check: 'check',
      acquire: 'acquire',
      bootstrap: 'bootstrap',
      inspect: 'inspect',
      power: 'power',
      destroy: 'destroy',
    },
  });
  const launch = {
    provider: { pluginId: 'fixture.controllerless', localId: 'cloud' },
    schemaVersion: 1,
    name: 'Cloud',
    choices: {},
  };
  const reviewedFacts = {
    launch,
    provisioner,
    optionStatus: 'current',
    billing: provisioner.billing,
    prerequisites: [],
    retentionCapabilities: provisioner.retention,
    retention: { kind: 'until-delete' },
    wakeOnAcceptedMessage: true,
  };
  const roles = defineMachineProvisionerSchemas({
    launch: defineProtocolObject({}, { policy: 'closed' }),
    resource: defineProtocolObject(
      { id: defineProtocolString() },
      { policy: 'closed' },
    ),
  });
  const declaration = createReleaseLessDeclarationV1(
    PluginManifestV2Schema.parse({
      schemaVersion: 2,
      id: launch.provider.pluginId,
      version: '1.0.0',
      displayName: 'Controllerless fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {
        machineProvisioners: [provisioner],
        actions: [
          {
            id: 'check',
            inputSchema: roles.checkInput.jsonSchema,
            resultSchema:
              MachineProvisionerCheckResultProtocolV1Schema.jsonSchema,
          },
          {
            id: 'acquire',
            inputSchema: roles.acquireInput.jsonSchema,
            resultSchema: roles.acquireResult.jsonSchema,
          },
          {
            id: 'bootstrap',
            inputSchema: roles.bootstrapInput.jsonSchema,
            resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema,
          },
          {
            id: 'inspect',
            inputSchema: roles.resourceInput.jsonSchema,
            resultSchema: MachineProvisionerObservationV1Schema.jsonSchema,
          },
          {
            id: 'power',
            inputSchema: roles.powerInput.jsonSchema,
            resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema,
          },
          {
            id: 'destroy',
            inputSchema: roles.resourceInput.jsonSchema,
            resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema,
          },
        ].map((action) => ({
          ...action,
          title: action.id,
          execution: { target: 'daemon' },
          surfaces: ['plugin'],
          scopes: ['global'],
          dangerLevel: 'safe',
        })),
      },
    }),
  );
  const capabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({
    externalActionExecutionAuthorization: { protocolVersions: [1] },
  });

  async function account() {
    const created = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    await db.accountPluginIntent.create({
      data: {
        accountId: created.id,
        pluginId: launch.provider.pluginId,
        enabled: true,
        writableCollections: [],
        releaseLessDeclaration: declaration,
      },
    });
    return created;
  }
  /** An installed Account daemon: the executor the live CLI identity used. */
  async function daemon(accountId: string) {
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({
      data: {
        id: randomUUID(),
        accountId,
        installationId: randomUUID(),
        installationPublicKey: new Uint8Array(keys.publicKey),
        active: true,
        lastActiveAt: new Date(),
        pluginMaterializationRevision: BigInt(1),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: capabilities,
        metadata: encodePlainMachineStoredContent({
          host: 'daemon',
          platform: 'linux',
          happyCliVersion: 'test',
          homeDir: '/home/daemon',
          happyHomeDir: '/home/daemon/.happier',
        }),
        dataEncryptionKey: decodeBase64(
          MACHINE_PLAIN_DATA_KEY_MARKER,
          'base64',
        ),
      },
    });
    await db.pluginMachineMaterialization.create({
      data: {
        accountId,
        serverIdentityId: homeId,
        machineId: machine.id,
        materializationId: machine.installationId!,
        pluginId: launch.provider.pluginId,
        version: '1.0.0',
        sourceClass: 'bundledFirstParty',
        portableRelease: false,
        archiveDigestSha256: declaration.manifestDigestSha256,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: new Date(),
      },
    });
    return { machine, keys };
  }
  type Daemon = Awaited<ReturnType<typeof daemon>>;
  const share = (
    ownerId: string,
    machineId: string,
    accountId: string,
    level: 'view' | 'admin',
  ) =>
    inTx((tx) =>
      setEligibleMachineAccessGrantInTx(tx, {
        actorAccountId: ownerId,
        machineId,
        principal: { kind: 'account', accountId },
        level,
      }),
    );
  /** A bound cloud row whose controller was cleared and whose guest never enrolled (C115). */
  const managedRow = (
    custodianAccountId: string,
    controller?: { id: string; installationId: string | null },
  ) =>
    db.managedMachine.create({
      data: {
        homeId,
        custodianAccountId,
        admittedActionRequestId: randomUUID(),
        admittedInput: { enrollmentAccountId: custodianAccountId },
        launch,
        reviewedFacts,
        allocation: 'bound',
        resource: {
          contributionRef: launch.provider,
          schemaVersion: 1,
          value: { id: 'paid' },
        },
        creationState: 'active',
        desired: 'start',
        desiredWhen: 'now',
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: true,
        ...(controller
          ? {
              controllerMachineId: controller.id,
              controllerInstallationId: controller.installationId,
            }
          : {}),
      },
    });
  const token = (accountId: string, kind: 'account' | 'terminal') =>
    auth.createToken(
      accountId,
      undefined,
      kind === 'terminal'
        ? { kind, authority: 'account_automation' }
        : { kind, authority: 'present_user' },
    );
  const stopInput = (managedId: string) => ({
    homeId,
    managedId,
    when: 'now' as const,
    intent: 'stop' as const,
    expectedRevision: 0,
  });
  const deleteInput = (managedId: string) => ({
    ...stopInput(managedId),
    intent: 'delete' as const,
    reviewedDependencies: true,
  });

  async function server() {
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerExternalActionRoutes(app);
    registerManagedMachineRoutes(app);
    await app.ready();
    return app;
  }
  type App = Awaited<ReturnType<typeof server>>;

  /** The real Account root issuance for the invoking credential, as the CLI's Action receives it. */
  const issue = (
    app: App,
    bearer: string,
    actionId: string,
    executor: Daemon,
    input: unknown,
  ) =>
    app.inject({
      method: 'POST',
      url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        v: 1,
        machineId: executor.machine.id,
        envelope: {
          v: 1,
          requestId: randomUUID(),
          target: { kind: 'machine', machineId: executor.machine.id },
          input,
        },
      },
    });
  async function mint(
    app: App,
    bearer: string,
    actionId: string,
    executor: Daemon,
    input: unknown,
  ) {
    const minted = await issue(app, bearer, actionId, executor, input);
    expect(minted.statusCode, minted.body).toBe(200);
    return ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
  }
  type Root = Awaited<ReturnType<typeof mint>>;
  /** The daemon's exact signature over one managed POST for a minted root. */
  const signedHeaders = (
    root: Root,
    executor: Daemon,
    effectActionId: string,
    path: string,
    body: unknown,
  ) => ({
    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]:
      encodeExternalActionResolvedTargetV1(root.binding.target),
    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]:
      signExternalActionMachineRequestV1({
        authorizationToken: root.token,
        effectActionId,
        target: root.binding.target,
        installationId: executor.machine.installationId!,
        requestId: root.binding.requestId,
        method: 'POST',
        path,
        body,
        privateKey: executor.keys.secretKey,
      }),
  });
  const admitPath = '/v1/machines/managed/controller/admit-control';
  const admitControl = (
    app: App,
    root: Root,
    executor: Daemon,
    body: Readonly<{ action: string; input: unknown; requestId: string }>,
    effectActionId = body.action,
  ) =>
    app.inject({
      method: 'POST',
      url: admitPath,
      payload: body,
      headers: signedHeaders(root, executor, effectActionId, admitPath, body),
    });
  const readRow = (id: string) =>
    db.managedMachine.findUniqueOrThrow({ where: { id } });

  // The live identity's daemon is shared with another Account, so only the
  // owner proof (not the unshared-daemon fallback) can admit it.
  it.each(['terminal', 'account'] as const)(
    'admits the owner’s %s credential: Stop is controller_unavailable, Delete reaches cleanup',
    async (kind) => {
      const owner = await account();
      const other = await account();
      const executor = await daemon(owner.id);
      await share(owner.id, executor.machine.id, other.id, 'admin');
      const app = await server();
      try {
        const bearer = await token(owner.id, kind);
        const stopRow = await managedRow(owner.id);
        const stopRoot = await mint(
          app,
          bearer,
          'machines.managed.power.set',
          executor,
          stopInput(stopRow.id),
        );
        const stopped = await admitControl(app, stopRoot, executor, {
          action: 'machines.managed.power.set',
          input: stopInput(stopRow.id),
          requestId: stopRoot.binding.requestId,
        });
        expect(stopped.statusCode, stopped.body).toBe(409);
        expect(stopped.json()).toEqual({ code: 'controller_unavailable' });
        expect(await readRow(stopRow.id)).toEqual(stopRow);

        const deleteRow = await managedRow(owner.id);
        const deleteRoot = await mint(
          app,
          bearer,
          'machines.managed.delete',
          executor,
          deleteInput(deleteRow.id),
        );
        const body = {
          action: 'machines.managed.delete',
          input: deleteInput(deleteRow.id),
          requestId: deleteRoot.binding.requestId,
        };
        const deleted = await admitControl(app, deleteRoot, executor, body);
        expect(deleted.statusCode, deleted.body).toBe(200);
        expect(deleted.json().machine).toMatchObject({
          id: deleteRow.id,
          allocation: 'bound',
          desired: 'delete',
          intentRevision: 1,
          cleanup: { disposition: 'pending' },
        });
        expect(deleted.json().machine.controller).toBeUndefined();
        // The exact signed request replays its admitted result; it never admits twice.
        const replayed = await admitControl(app, deleteRoot, executor, body);
        expect(replayed.statusCode, replayed.body).toBe(200);
        expect(replayed.json()).toMatchObject({
          replayed: true,
          machine: { intentRevision: 1 },
        });
        // Native cleanup continues on the same signed root.
        const correlation = {
          homeId,
          managedId: deleteRow.id,
          requestId: deleteRoot.binding.requestId,
          expectedIntentRevision: 1,
        };
        const submitPath = '/v1/machines/managed/controller/submit-intent';
        const submitted = await app.inject({
          method: 'POST',
          url: submitPath,
          payload: correlation,
          headers: signedHeaders(
            deleteRoot,
            executor,
            'machines.managed.delete',
            submitPath,
            correlation,
          ),
        });
        expect(submitted.statusCode, submitted.body).toBe(200);
        expect(submitted.json()).toMatchObject({
          submitted: true,
          machine: { desired: 'delete' },
        });
      } finally {
        await app.close();
      }
    },
  );

  it('refuses every non-owner and every mismatched or controller-bound owner request without changing the row', async () => {
    const owner = await account();
    const foreign = await account();
    const useGuest = await account();
    const executor = await daemon(owner.id);
    const foreignDaemon = await daemon(foreign.id);
    // Machine share levels are view (Use) and admin (Manage).
    await share(owner.id, executor.machine.id, foreign.id, 'admin');
    await share(owner.id, executor.machine.id, useGuest.id, 'view');
    const row = await managedRow(owner.id);
    const app = await server();
    const unchanged = async (id = row.id, expected = row) =>
      expect(await readRow(id)).toEqual(expected);
    try {
      // Another Account (Manage on the owner's daemon, or on its own daemon),
      // and the daemon's Use guest, with either credential kind.
      let executed = 0;
      for (const [principal, signer] of [
        [foreign, executor],
        [foreign, foreignDaemon],
        [useGuest, executor],
      ] as const) {
        for (const kind of ['account', 'terminal'] as const) {
          const bearer = await token(principal.id, kind);
          for (const [action, input] of [
            ['machines.managed.delete', deleteInput(row.id)],
            ['machines.managed.power.set', stopInput(row.id)],
          ] as const) {
            const minted = await issue(app, bearer, action, signer, input);
            if (minted.statusCode !== 200) {
              expect(minted.statusCode, minted.body).toBeGreaterThanOrEqual(
                400,
              );
              continue;
            }
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(
              minted.json(),
            );
            const response = await admitControl(app, root, signer, {
              action,
              input,
              requestId: root.binding.requestId,
            });
            executed += 1;
            expect(
              response.statusCode,
              `${principal.id}/${kind}/${action}: ${response.body}`,
            ).toBe(403);
            expect(response.json()).toEqual({ code: 'permission_denied' });
            await unchanged();
          }
        }
      }
      // At least the Manage grantee's roots reach managed admission, so its refusal is the owner check.
      expect(executed).toBeGreaterThan(0);

      const bearer = await token(owner.id, 'terminal');
      const root = await mint(
        app,
        bearer,
        'machines.managed.delete',
        executor,
        deleteInput(row.id),
      );
      const body = {
        action: 'machines.managed.delete',
        input: deleteInput(row.id),
        requestId: root.binding.requestId,
      };
      // A signed Delete naming another request is not the admitted Delete.
      const otherRequest = await admitControl(app, root, executor, {
        ...body,
        requestId: randomUUID(),
      });
      // The signed-request verifier pins the root's exact action, input and request.
      expect(otherRequest.statusCode, otherRequest.body).toBe(401);
      expect(otherRequest.json()).toMatchObject({ authorizationRefusal: 'managed_control_purpose' });
      await unchanged();
      // A Delete root cannot carry a Stop effect, nor a Stop root a Delete.
      expect(
        (
          await admitControl(
            app,
            root,
            executor,
            body,
            'machines.managed.power.set',
          )
        ).statusCode,
      ).not.toBe(200);
      await unchanged();
      const stopRoot = await mint(
        app,
        bearer,
        'machines.managed.power.set',
        executor,
        stopInput(row.id),
      );
      expect(
        (
          await admitControl(
            app,
            stopRoot,
            executor,
            { ...body, requestId: stopRoot.binding.requestId },
            'machines.managed.delete',
          )
        ).statusCode,
      ).not.toBe(200);
      await unchanged();
      // Whoever replays the owner's signed proof with a changed body breaks the signature.
      const otherRow = await managedRow(owner.id);
      const tampered = await app.inject({
        method: 'POST',
        url: admitPath,
        payload: { ...body, input: deleteInput(otherRow.id) },
        headers: signedHeaders(
          root,
          executor,
          'machines.managed.delete',
          admitPath,
          body,
        ),
      });
      expect(tampered.statusCode, tampered.body).not.toBe(200);
      await unchanged(otherRow.id, otherRow);
      // A row that has a controller still requires that controller's proof.
      const controller = await daemon(owner.id);
      const bound = await managedRow(owner.id, controller.machine);
      const boundRoot = await mint(
        app,
        bearer,
        'machines.managed.delete',
        executor,
        deleteInput(bound.id),
      );
      const boundResponse = await admitControl(app, boundRoot, executor, {
        action: 'machines.managed.delete',
        input: deleteInput(bound.id),
        requestId: boundRoot.binding.requestId,
      });
      expect(boundResponse.statusCode, boundResponse.body).toBe(403);
      expect(boundResponse.json()).toMatchObject({ code: 'permission_denied', authorizationRefusal: 'resolved_target' });
      await unchanged(bound.id, bound);
    } finally {
      await app.close();
    }
  });
});
