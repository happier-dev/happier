import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
  encodePlainArtifactStoredContent,
  ArtifactJsonCreateHttpInputV1Schema,
} from '@happier-dev/protocol';
import { createDeploymentEnvironmentContentArtifactIdV1, projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import {
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
} from '@happier-dev/protocol/actions';
import { auth } from '@/app/auth/auth';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';

/**
 * Watched Compose adoption creates an Environment. Its root spends the same
 * create-preparation admission as Create, bound from its reviewed destination.
 */
describe('adopt create preparation admission', () => {
  const serverId = `srv_${'d'.repeat(32)}`;
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-adopt-preparation-',
      initEncrypt: true,
      initAuth: true,
      env: { HAPPIER_SERVER_IDENTITY_ID: serverId },
    });
  }, 180_000);
  afterAll(async () => {
    await harness?.close();
  });

  async function fixture() {
    const actor = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const stranger = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    await makeShareEligibleForTest(stranger.id, actor.id);
    const destination = await inTx((tx) =>
      createProjectSourceInTx(tx, actor.id, {
        serverId,
        requestKey: crypto.randomUUID(),
        name: 'Adopted project',
        audience: [],
      }),
    );
    const foreign = await inTx((tx) =>
      createProjectSourceInTx(tx, stranger.id, {
        serverId,
        requestKey: crypto.randomUUID(),
        name: 'Foreign project',
        audience: [
          {
            principal: { kind: 'account', accountId: actor.id },
            level: 'view',
          },
        ],
      }),
    );
    if (!destination.ok || !foreign.ok)
      throw new Error('Expected Source fixtures');
    const key = nacl.sign.keyPair();
    const machine = await db.machine.create({
      data: {
        id: crypto.randomUUID(),
        accountId: actor.id,
        metadata: encodePlainMachineStoredContent({
          host: 'Adopt host',
          platform: 'linux',
          happyCliVersion: 'test',
          homeDir: '/tmp',
          happyHomeDir: '/tmp/happier',
        }),
        dataEncryptionKey: privacyKit.decodeBase64(
          MACHINE_PLAIN_DATA_KEY_MARKER,
        ),
        installationId: crypto.randomUUID(),
        installationPublicKey: key.publicKey,
      },
    });
    const adoptInput = (projectSourceId: string) => ({
      serverId,
      machineId: machine.id,
      serviceId: 'compose:web',
      expectedGeneration: 'generation-1',
      requestKey: crypto.randomUUID(),
      profiles: [],
      mode: 'apply' as const,
      reviewedDigest: `sha256:${'a'.repeat(64)}`,
      bindingsConfirmed: true as const,
      bindings: [],
      destination: {
        projectSourceId,
        name: 'Adopted web',
        protection: 'nonProduction' as const,
        purpose: 'standard' as const,
        deployerMode: 'managers' as const,
      },
    });
    const mint = async (actionId: string, input: Record<string, unknown>) => {
      const envelope = {
        v: 1 as const,
        requestId: crypto.randomUUID(),
        target: { kind: 'machine' as const, machineId: machine.id },
        input,
      };
      return auth.mintExternalActionExecutionAuthorization(
        {
          serverIdentityId: serverId,
          accountId: actor.id,
          authentication: { kind: 'account', tokenEpoch: actor.tokenEpoch },
          actionId,
          requestId: envelope.requestId,
          target: envelope.target,
          machineId: machine.id,
          requestEnvelopeDigest:
            computeExternalActionRequestEnvelopeDigestV1(envelope),
          deploymentPreparationAdmission:
            projectDeploymentPreparationAdmissionV1(actionId, input),
        },
        { input },
      );
    };
    const headers = (
      root: Awaited<ReturnType<typeof mint>>,
      effectActionId: string,
      method: string,
      path: string,
      body?: unknown,
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
          installationId: machine.installationId!,
          requestId: root.binding.requestId,
          method,
          path,
          ...(body === undefined ? {} : { body }),
          privateKey: key.secretKey,
        }),
    });
    return {
      actor,
      stranger,
      destination: destination.source,
      foreign: foreign.source,
      machine,
      adoptInput,
      mint,
      headers,
    };
  }

  it('binds create preparation from the reviewed destination and spends it on the native lookup and content writes', async () => {
    const f = await fixture();
    const input = f.adoptInput(f.destination.id);
    const root = await f.mint('machines.services.adopt', input);
    expect(root.binding.deploymentPreparationAdmission).toMatchObject({
      operation: 'create',
      mode: 'apply',
      source: { id: f.destination.id },
      requestKey: input.requestKey,
    });
    const owner = { kind: 'account' as const, accountId: f.actor.id };
    await withAuthenticatedTestApp(
      (app) => {
        registerDeploymentRoutes(app);
        artifactsRoutes(app);
        projectSourceRoutes(app);
      },
      async (app) => {
        const send = (
          effectActionId: string,
          method: 'GET' | 'POST',
          url: string,
          payload?: Record<string, unknown>,
          signedRoot = root,
        ) =>
          app.inject({
            method,
            url,
            ...(payload === undefined ? {} : { payload }),
            headers: f.headers(
              signedRoot,
              effectActionId,
              method,
              url,
              payload,
            ),
          });
        // The daemon's create preparation signs each request with its root.
        const defaults = await send(
          'machines.services.adopt',
          'GET',
          `/v1/projects/${encodeURIComponent(f.destination.id)}/deployment-defaults?serverId=${encodeURIComponent(serverId)}`,
        );
        expect.soft(defaults.statusCode, defaults.body).toBe(200);
        const listBody = {
          serverId,
          scope: owner,
          selection: {
            source: { kind: 'host', id: 'own-server' },
            targetKind: 'ownServer',
          },
        };
        const listed = await send(
          'machines.services.adopt',
          'POST',
          '/v1/deployments/targets/list',
          listBody,
        );
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json()).toEqual({
          ok: true,
          items: [],
          nextCursor: null,
          coverage: 'complete',
        });
        const content = ArtifactJsonCreateHttpInputV1Schema.parse({
          id: crypto.randomUUID(),
          kind: 'v1:other:deployment-environment.v1',
          header: encodePlainArtifactStoredContent({
            kind: 'deployment-environment.v1',
            title: 'Adopted web',
          }),
          body: encodePlainArtifactStoredContent({ body: '{}' }),
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        });
        const created = await send(
          'machines.services.adopt',
          'POST',
          '/v1/artifacts',
          content,
        );
        expect.soft(created.statusCode, created.body).toBe(200);
        // Create preparation publishes its one create-only candidate and reads it back (J52, #130).
        const candidate = { ...content, id: createDeploymentEnvironmentContentArtifactIdV1({ ...root.binding,
          actionId: DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 }) };
        const published = await send('machines.services.adopt', 'POST', '/v1/artifacts', candidate);
        expect(published.statusCode, published.body).toBe(200);
        const readBack = await send('machines.services.adopt', 'GET', `/v1/artifacts/${candidate.id}`);
        expect(readBack.statusCode, readBack.body).toBe(200);
        // No other Artifact rides on that admission, even one this root published.
        expect((await send('machines.services.adopt', 'GET', `/v1/artifacts/${content.id}`)).statusCode).toBe(401);

        // The admission is the destination owner's inventory, not another readable scope.
        const strangerScope = await send(
          'machines.services.adopt',
          'POST',
          '/v1/deployments/targets/list',
          { ...listBody, scope: { kind: 'account', accountId: f.stranger.id } },
        );
        expect.soft(strangerScope.statusCode).toBe(401);
        // The Environment row itself is written only by the reviewed create child.
        const storage = await send(
          'machines.services.adopt',
          'POST',
          '/v1/deployments/environments',
          {
            serverId,
            projectSourceId: f.destination.id,
            requestKey: input.requestKey,
            name: 'Adopted web',
            protection: 'nonProduction',
            purpose: 'standard',
            deployerMode: 'managers',
            controllerMachineId: f.machine.id,
            contentArtifactId: content.id,
            contentHeaderVersion: 1,
            contentBodyVersion: 1,
          },
        );
        expect.soft(storage.statusCode, storage.body).toBe(401);

        // Another Machine-service root carries no create admission.
        const unwatch = await f.mint('machines.services.unwatch', {
          serverId,
          machineId: f.machine.id,
          serviceId: 'compose:web',
        });
        expect(unwatch.binding.deploymentPreparationAdmission).toBeUndefined();
        const other = await send(
          'machines.services.unwatch',
          'POST',
          '/v1/deployments/targets/list',
          listBody,
          unwatch,
        );
        expect.soft(other.statusCode).toBe(401);
      },
      { authentication: 'real' },
    );
  });

  it('refuses to issue adopt create authority into a destination the requester cannot manage', async () => {
    const f = await fixture();
    await expect(
      f.mint('machines.services.adopt', f.adoptInput(f.foreign.id)),
    ).rejects.toMatchObject({ code: 'credential_scope_denied' });
  });

  it('issues no create admission for the review step', async () => {
    const f = await fixture();
    const review = await f.mint('machines.services.adopt', {
      serverId,
      machineId: f.machine.id,
      serviceId: 'compose:web',
      expectedGeneration: 'generation-1',
      requestKey: crypto.randomUUID(),
      profiles: [],
      mode: 'review',
    });
    expect(review.binding.deploymentPreparationAdmission).toBeUndefined();
  });
});
