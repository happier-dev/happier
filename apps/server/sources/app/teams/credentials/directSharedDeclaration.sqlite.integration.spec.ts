import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { PROJECT_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import {
  createReleaseLessDeclarationV1,
  mergeReleaseLessDeclarationV2,
} from '@/app/plugins/availability/currentDeclaration';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { createTeamDirectActionMaterialFixture } from './directActionMaterial.testkit';
import { registerTeamCredentialResourceRoutes } from './registerTeamCredentialResourceRoutes';

/** A plugin with a finite Action and a Project system tool that both use the shared service. */
const manifest = PluginManifestV2Schema.parse({
  schemaVersion: 2,
  id: 'example.cloud',
  version: '1.0.0',
  displayName: 'Cloud',
  engines: { happier: '^0.3.0' },
  runtime: { apiVersion: 1 },
  hostAccess: {
    required: [
      {
        id: 'cloud-api',
        capability: 'connectedAccounts',
        reason: 'Provision Machines',
        scope: { serviceRefs: ['cloud'], operations: ['use'] },
      },
    ],
    optional: [],
  },
  contributes: {
    actions: [
      {
        id: 'options',
        title: 'Options',
        scopes: ['machine'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['cloud-api'],
        inputSchema: { type: 'object' },
        resultSchema: { type: 'object' },
      },
    ],
    systemTools: [
      {
        id: 'cli',
        title: 'Cloud CLI',
        executableNames: ['cloud'],
        connectedAccountLaunch: {
          purpose: 'cloud.cli',
          service: 'cloud',
          environmentKey: 'CLOUD_TOKEN',
        },
      },
    ],
  },
});

type Verified = Readonly<{
  admission: NonNullable<
    FastifyRequest['externalActionActionMaterialAdmission']
  >;
  binding: FastifyRequest['externalActionExecutionAuthorizationBinding'];
}>;

describe('finite Team Direct material on a shared Machine (SQLite route integration)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'team-direct-shared-machine-',
      initEncrypt: true,
      env: {
        HAPPIER_FEATURE_TEAMS__ENABLED: '1',
        HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      },
    });
  }, 120_000);
  afterAll(async () => {
    await harness?.close();
  });

  /**
   * Machine owner M runs the plugin; Team custodian C shares Direct access
   * with member R. R has enabled the plugin but holds no declaration of its own.
   */
  async function sharedMachine(kind: 'action' | 'project_tool') {
    const fixture = await createTeamDirectActionMaterialFixture({
      manifest,
      ...(kind === 'project_tool'
        ? { actionId: 'cli', purposeId: 'cloud.cli' }
        : {}),
    });
    const owner = await db.account.create({
      data: { encryptionMode: 'plain', publicKey: null },
    });
    const installationId = crypto.randomUUID();
    await db.machine.update({
      where: { id: fixture.machine.id },
      data: { accountId: owner.id, installationId },
    });
    const recipientIntent = {
      accountId_pluginId: {
        accountId: fixture.recipient.id,
        pluginId: manifest.id,
      },
    };
    // As on QA: the member enabled the plugin, but no Machine of theirs declared it.
    await db.accountPluginIntent.delete({ where: recipientIntent });
    await db.accountPluginIntent.create({
      data: {
        accountId: fixture.recipient.id,
        pluginId: manifest.id,
        enabled: true,
        writableCollections: [],
        desiredVersion: null,
      },
    });
    const declaration = createReleaseLessDeclarationV1(manifest);
    const forInstallation = (machineId: string, id: string) =>
      mergeReleaseLessDeclarationV2({
        stored: null,
        declaration,
        publisher: { machineId, installationId: id },
      }).stored;
    await db.accountPluginIntent.create({
      data: {
        accountId: owner.id,
        pluginId: manifest.id,
        enabled: true,
        writableCollections: [],
        desiredVersion: null,
        releaseLessDeclaration: forInstallation(
          fixture.machine.id,
          installationId,
        ),
      },
    });
    const rootActionId =
      kind === 'project_tool'
        ? PROJECT_PREPARE_ACTION_ID_V1
        : fixture.consumer.actionId;
    const consumer = { ...fixture.consumer, actionId: rootActionId };
    const recipient = await db.account.findUniqueOrThrow({
      where: { id: fixture.recipient.id },
    });
    const binding = (
      input: Readonly<{ custodianAccountId: string; installationId: string }>,
    ) =>
      ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1,
        token: 'fixture-direct-material',
        binding: {
          serverIdentityId: 'home',
          accountId: recipient.id,
          custodianAccountId: input.custodianAccountId,
          authentication: { kind: 'account', tokenEpoch: recipient.tokenEpoch },
          accountEncryptionMode: 'plain',
          machineId: fixture.machine.id,
          installationId: input.installationId,
          actionId: rootActionId,
          requestId: consumer.operationId,
          target: { kind: 'machine', machineId: fixture.machine.id },
          requestEnvelopeDigest: 'a'.repeat(43),
        },
      }).binding;
    const verified: Verified = {
      admission: {
        teamId: fixture.team.id,
        resourceId: fixture.resource.id,
        consumer,
        rootActionId,
        machineId: fixture.machine.id,
      },
      binding: binding({ custodianAccountId: owner.id, installationId }),
    };
    return {
      fixture,
      owner,
      installationId,
      consumer,
      verified,
      binding,
      forInstallation,
    };
  }

  async function withRoute<T>(
    run: (
      open: (verified: Verified | null, consumer?: unknown) => Promise<string>,
    ) => Promise<T>,
  ) {
    const app = createAuthenticatedTestApp();
    let current: Verified | null = null;
    // Authentication is the HTTP boundary: these are the verifier's outputs for a signed Machine request.
    app.addHook('preHandler', async (request: FastifyRequest) => {
      if (!current) return;
      request.externalActionExecutionAuthorized = true;
      request.externalActionInputConstraints = { models: null, permissionModes: null };
      request.externalActionActionMaterialAdmission = current.admission;
      request.externalActionExecutionAuthorizationBinding = current.binding;
    });
    registerTeamCredentialResourceRoutes(app);
    await app.ready();
    try {
      return await run(async (verified, consumer) => {
        current = verified;
        const { fixture } = state!;
        const body = {
          resourceId: fixture.resource.id,
          consumer: consumer ?? state!.consumer,
          slot: { kind: 'connected_service_purpose', purpose: fixture.purpose },
          disclosedMember: fixture.sourceAccount,
        };
        const response = await app.inject({
          method: 'POST',
          url: `/v2/teams/${fixture.team.id}/credential-resources/${fixture.resource.id}/direct-material`,
          headers: { 'x-test-user-id': state!.requesterAccountId },
          payload: body,
        });
        const json = response.json();
        if (response.statusCode === 404) return `404 ${json.error}`;
        expect(response.statusCode, response.body).toBe(200);
        return json.status === 'ready' ? 'ready' : json.reason;
      });
    } finally {
      await app.close();
    }
  }
  let state:
    | (Awaited<ReturnType<typeof sharedMachine>> & {
        requesterAccountId: string;
      })
    | null = null;
  const notFound = '404 plugin_declaration_not_found';

  /** The same plugin, with its finite Action and system tool pointing at another service. */
  const otherService = {
    ...manifest,
    hostAccess: {
      ...manifest.hostAccess,
      required: manifest.hostAccess.required.map((access) => ({
        ...access,
        scope: { ...access.scope, serviceRefs: ['other-service'] },
      })),
    },
    contributes: {
      ...manifest.contributes,
      systemTools: manifest.contributes.systemTools.map((tool) => ({
        ...tool,
        connectedAccountLaunch: { ...tool.connectedAccountLaunch!, service: 'other-service' },
      })),
    },
  } as typeof manifest;

  it.each(['action', 'project_tool'] as const)(
    "admits a member's %s from the Machine owner's installed declaration",
    async (kind) => {
      state = { ...(await sharedMachine(kind)), requesterAccountId: '' };
      state.requesterAccountId = state.fixture.recipient.id;
      const { verified, binding, owner, installationId, fixture, consumer } = state;
      const ownerIntent = {
        accountId_pluginId: { accountId: owner.id, pluginId: manifest.id },
      };
      const setOwnerDeclaration = async (data: Parameters<typeof db.accountPluginIntent.update>[0]['data']) =>
        await db.accountPluginIntent.update({ where: ownerIntent, data });
      await withRoute(async (open) => {
        await expect(open(verified)).resolves.toBe('ready');
        // Missing proof binding fails closed.
        await expect(open({ ...verified, binding: undefined })).resolves.toBe('access_removed');
        // Another installation of the same Machine, or another Machine, has no declaration of its own.
        await expect(
          open({ ...verified, binding: binding({ custodianAccountId: owner.id, installationId: crypto.randomUUID() }) }),
        ).resolves.toBe(notFound);
        await expect(
          open({ ...verified, admission: { ...verified.admission, machineId: crypto.randomUUID() } }),
        ).resolves.toBe(notFound);
        // A current installation declaration that does not admit this use is a mismatch, not a missing declaration.
        await expect(open(verified, { ...consumer, pluginVersion: '0.9.0' })).resolves.toBe('access_removed');
        await expect(
          open({ ...verified, admission: { ...verified.admission, rootActionId: 'machines.read' } }),
        ).resolves.toBe('access_removed');
        await setOwnerDeclaration({
          releaseLessDeclaration: mergeReleaseLessDeclarationV2({
            stored: null,
            declaration: createReleaseLessDeclarationV1(otherService),
            publisher: { machineId: fixture.machine.id, installationId },
          }).stored,
        });
        await expect(open(verified)).resolves.toBe('access_removed');
        // The requester's own declaration never stands in for the executing installation's.
        await db.accountPluginIntent.update({
          where: { accountId_pluginId: { accountId: fixture.recipient.id, pluginId: manifest.id } },
          data: { releaseLessDeclaration: createReleaseLessDeclarationV1(manifest) },
        });
        await setOwnerDeclaration({ enabled: false });
        await expect(open(verified)).resolves.toBe(notFound);
        await setOwnerDeclaration({
          enabled: true,
          releaseLessDeclaration: state!.forInstallation(fixture.machine.id, crypto.randomUUID()),
        });
        await expect(open(verified)).resolves.toBe(notFound);
        await setOwnerDeclaration({
          releaseLessDeclaration: state!.forInstallation(fixture.machine.id, installationId),
        });
        await expect(open(verified)).resolves.toBe('ready');
        // An unentitled requester learns nothing about the owner's declaration.
        await db.teamCredentialResource.update({
          where: { id: fixture.resource.id },
          data: { memberGrants: { deleteMany: {} } },
        });
        await expect(open(verified)).resolves.toBe('access_removed');
        await setOwnerDeclaration({ enabled: false });
        await expect(open(verified)).resolves.toBe('access_removed');
      });
    },
  );

  it("refuses a requester outside the Team even on the declaring owner's Machine", async () => {
    state = { ...(await sharedMachine('action')), requesterAccountId: '' };
    state.requesterAccountId = state.fixture.recipient.id;
    await db.teamMembership.delete({
      where: { id: state.fixture.membership.id },
    });
    await withRoute(async (open) => {
      await expect(open(state!.verified)).resolves.toBe('access_removed');
      await db.accountPluginIntent.update({
        where: { accountId_pluginId: { accountId: state!.owner.id, pluginId: manifest.id } },
        data: { enabled: false },
      });
      await expect(open(state!.verified)).resolves.toBe('access_removed');
    });
  });

  it("keeps the requester's own Machine admitted through its own installed declaration", async () => {
    state = { ...(await sharedMachine('action')), requesterAccountId: '' };
    const { fixture, installationId, binding } = state;
    state.requesterAccountId = fixture.recipient.id;
    await db.machine.update({
      where: { id: fixture.machine.id },
      data: { accountId: fixture.recipient.id },
    });
    await db.accountPluginIntent.update({
      where: {
        accountId_pluginId: {
          accountId: fixture.recipient.id,
          pluginId: manifest.id,
        },
      },
      data: {
        releaseLessDeclaration: state.forInstallation(
          fixture.machine.id,
          installationId,
        ),
      },
    });
    await withRoute(async (open) => {
      await expect(
        open({
          ...state!.verified,
          binding: binding({
            custodianAccountId: fixture.recipient.id,
            installationId,
          }),
        }),
      ).resolves.toBe('ready');
    });
  });
});
