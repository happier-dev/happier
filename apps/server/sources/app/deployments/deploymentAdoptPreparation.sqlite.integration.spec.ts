import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
  encodePlainArtifactStoredContent,
  ArtifactJsonCreateHttpInputV1Schema,
  DeploymentEnvironmentCreateResultV1Schema,
} from '@happier-dev/protocol';
import { createDeploymentEnvironmentContentArtifactIdV1, projectDeploymentPreparationAdmissionV1,
  EXTERNAL_ACTION_REVIEWED_CHILD_HEADER, type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { encodeReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
} from '@happier-dev/protocol/actions';
import { auth } from '@/app/auth/auth';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { readDeploymentCreateHttpPurposeInTx } from '@/app/deployments/deploymentPreparationAuthorization';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentBindingsSetStorageInputV1Schema } from '@happier-dev/protocol/deployments/deploymentStorageInputsV1';
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
        installationPublicKey: new Uint8Array(key.publicKey),
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
    const mint = async (actionId: string, input: JsonValue) => {
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
      reviewedChild?: ReviewedActionChildHttpProofV1,
    ) => ({
      [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
      [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
      [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]:
        encodeExternalActionResolvedTargetV1(root.binding.target),
      ...(reviewedChild ? { [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild) } : {}),
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
          ...(reviewedChild ? { reviewedChild } : {}),
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

  it('opens only the destination owner\'s own-server links on this Machine when checking for an existing adoption', async () => {
    const f = await fixture();
    const root = await f.mint('machines.services.adopt', f.adoptInput(f.destination.id));
    // Two Environments run on the same Machine: one under the adopt destination's owner, one under another
    // person's Project that the requester can merely view. Adopt's idempotency check lists the owner's
    // own-server links and opens each one on this Machine to compare its native origin (J52, #130/#132).
    const runtimeLink = async (ownerAccountId: string, projectSourceId: string) => {
      const created = await createArtifact({ actorUserId: ownerAccountId, artifactId: crypto.randomUUID(),
        kind: 'v1:other:deployment-target-link.v1',
        header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Runtime' })),
        body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
      if (!created.ok) throw new Error(created.error);
      const content = { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
      const environment = await db.deploymentEnvironment.create({ data: { projectSourceId, createdByAccountId: ownerAccountId,
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: f.machine.id, ...content } });
      const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id, createdByAccountId: ownerAccountId,
        role: 'runtime', state: 'deployed', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
        machines: { create: [{ machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'active' }] },
        ...content } });
      await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
      return link.contentArtifactId;
    };
    const own = await runtimeLink(f.actor.id, f.destination.id);
    const other = await runtimeLink(f.stranger.id, f.foreign.id);
    await withAuthenticatedTestApp((app) => { artifactsRoutes(app); }, async (app) => {
      const read = (artifactId: string) => app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`,
        headers: f.headers(root, 'machines.services.adopt', 'GET', `/v1/artifacts/${artifactId}`) });
      const ownRead = await read(own);
      expect(ownRead.statusCode, ownRead.body).toBe(200);
      const otherRead = await read(other);
      expect(otherRead.statusCode, otherRead.body).toBe(401);
      expect(otherRead.json()).toMatchObject({ authorizationRefusal: 'deployment_preparation' });
    }, { authentication: 'real' });
  });

  it('admits the adopted host allocation lookup and refuses another Machine or Home (J52)', async () => {
    const f = await fixture();
    const root = await f.mint('machines.services.adopt', f.adoptInput(f.destination.id));
    const path = managedMachineActionEndpointPathV1('machines.managed.list');
    const other = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.stranger.id,
      metadata: '{}', installationId: crypto.randomUUID() } });
    await withAuthenticatedTestApp(registerManagedMachineRoutes, async app => {
      const send = (body: Record<string, unknown>, effect = 'machines.managed.list', signedRoot = root) => app.inject({
        method: 'POST', url: path, payload: body,
        headers: f.headers(signedRoot, effect, 'POST', path, body),
      });
      const body = { homeId: serverId, enrolledMachineId: f.machine.id };
      const own = await send(body);
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json()).toMatchObject({ machines: [] });
      for (const invalid of [{ ...body, enrolledMachineId: other.id }, { ...body, homeId: 'another-home' }, { homeId: serverId }]) {
        const denied = await send(invalid);
        expect(denied.statusCode, denied.body).toBe(401);
      }
      expect((await send(body, 'machines.managed.get')).statusCode).toBe(401);
      const unwatch = await f.mint('machines.services.unwatch', {
        serverId, machineId: f.machine.id, serviceId: 'compose:web',
      });
      expect((await send(body, 'machines.managed.list', unwatch)).statusCode).toBe(401);
    }, { authentication: 'real' });
  });

  it('spends adopt preparation on its exact reviewed Create and conditional bindings children (J52)', async () => {
    const f = await fixture();
    const bindings = [{ purpose: 'variable' as const, name: 'PUBLIC_URL', phase: 'runtime' as const,
      source: { kind: 'value' as const, value: 'https://example.test' } }];
    const input = { ...f.adoptInput(f.destination.id), bindings };
    const root = await f.mint('machines.services.adopt', input);
    const content = await createArtifact({ actorUserId: f.actor.id, artifactId: crypto.randomUUID(),
      kind: 'v1:other:deployment-environment.v1',
      header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Adopted' })),
      body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({
        body: JSON.stringify({ ...createDeploymentEnvironmentDetailV1().content, bindings: [] }),
      })),
      dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!content.ok) throw new Error(content.error);
    const linkContent = await createArtifact({ actorUserId: f.actor.id, artifactId: crypto.randomUUID(),
      kind: 'v1:other:deployment-target-link.v1',
      header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Adopted' })),
      body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
      dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!linkContent.ok) throw new Error(linkContent.error);
    const prepared = { serverId, projectSourceId: f.destination.id, requestKey: input.requestKey,
      protection: input.destination.protection, purpose: input.destination.purpose, deployerMode: input.destination.deployerMode,
      controllerMachineId: f.machine.id, contentArtifactId: content.artifact.id,
      contentHeaderVersion: content.artifact.headerVersion, contentBodyVersion: content.artifact.bodyVersion,
      firstTargetLink: { machines: [{ machineId: f.machine.id, installationId: f.machine.installationId! }],
        contentArtifactId: linkContent.artifact.id,
        contentHeaderVersion: linkContent.artifact.headerVersion, contentBodyVersion: linkContent.artifact.bodyVersion } };
    const createChild = { actionId: 'deployments.environments.create', role: 'adopt-environment',
      inputDigest: computeActionInputApprovalDigestV1('deployments.environments.create', prepared) };
    const path = '/v1/deployments/environments';
    let createdEnvironment: Extract<ReturnType<typeof DeploymentEnvironmentCreateResultV1Schema.parse>, { ok: true }> | undefined;
    await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
      const send = (body: typeof prepared, child?: ReviewedActionChildHttpProofV1, effect = 'deployments.environments.create') => app.inject({
        method: 'POST', url: path, payload: body,
        headers: f.headers(root, effect, 'POST', path, body, child),
      });
      // Only the exact reviewed Create child may allocate the Environment under this root.
      expect((await send(prepared, undefined, 'machines.services.adopt')).statusCode).toBe(401);
      const created = await send(prepared, createChild);
      expect.soft(created.statusCode, created.body).toBe(200);
      if (created.statusCode === 200) {
        const parsed = DeploymentEnvironmentCreateResultV1Schema.parse(created.json());
        if (parsed.ok) createdEnvironment = parsed;
      }
      const changed = await send({ ...prepared, requestKey: crypto.randomUUID() }, createChild);
      expect(changed.statusCode, changed.body).toBe(401);
      const wrongRole = await send(prepared, { ...createChild, role: 'other-create' });
      expect(wrongRole.statusCode, wrongRole.body).toBe(401);
    }, { authentication: 'real' });

    // Continue from the allocation actually persisted by the signed HTTP child.
    const environment = createdEnvironment;
    if (!environment) throw new Error('Expected signed reviewed Create to allocate the Environment');
    const authored = { serverId, environmentId: environment.environmentId,
      expectedRevision: environment.revision, set: bindings, remove: [] };
    const bindingChild = { actionId: 'deployments.bindings.set', role: 'adopt-bindings',
      inputDigest: computeActionInputApprovalDigestV1('deployments.bindings.set', authored) };
    const body = DeploymentBindingsSetStorageInputV1Schema.parse({ serverId, environmentId: environment.environmentId,
      expectedRevision: environment.revision, contentArtifactId: content.artifact.id,
      contentHeaderVersion: content.artifact.headerVersion, contentBodyVersion: content.artifact.bodyVersion,
      referencedSavedSecretRevisions: [], grants: [] });
    const bindingsPath = `/v1/deployments/environments/${environment.environmentId}/bindings`;
    const purpose = (payload: typeof body, reviewedChild: ReviewedActionChildHttpProofV1 = bindingChild) => inTx(tx =>
      readDeploymentCreateHttpPurposeInTx(tx, root.binding, 'deployments.bindings.set', {
        method: 'POST', path: bindingsPath, body: payload, routeInput: payload, reviewedChild,
      }));
    expect.soft(await purpose(body)).toMatchObject({ child: { environmentId: environment.environmentId } });
    expect(await purpose({ ...body, environmentId: crypto.randomUUID() })).toBeNull();
    expect(await purpose(body, { ...bindingChild, role: 'other-bindings' })).toBeNull();
    const foreignContent = await createArtifact({ actorUserId: f.actor.id, artifactId: crypto.randomUUID(),
      kind: 'v1:other:deployment-environment.v1',
      header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Other Environment' })),
      body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({
        body: JSON.stringify({ ...createDeploymentEnvironmentDetailV1().content, bindings: [] }),
      })), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!foreignContent.ok) throw new Error(foreignContent.error);
    const { firstTargetLink: _firstTargetLink, ...foreignPrepared } = prepared;
    const foreignEnvironment = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.actor.id,
      { ...foreignPrepared, requestKey: crypto.randomUUID(), contentArtifactId: foreignContent.artifact.id,
        contentHeaderVersion: foreignContent.artifact.headerVersion, contentBodyVersion: foreignContent.artifact.bodyVersion }));
    if (!foreignEnvironment.ok) throw new Error(foreignEnvironment.error);
    await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
      const read = (path: string) => app.inject({ method: 'GET', url: path,
        headers: f.headers(root, 'deployments.bindings.set', 'GET', path, undefined, bindingChild) });
      const own = await read(`/v1/deployments/environments/${environment.environmentId}?serverId=${serverId}`);
      expect.soft(own.statusCode, own.body).toBe(200);
      const artifact = await read(`/v1/artifacts/${content.artifact.id}`);
      expect.soft(artifact.statusCode, artifact.body).toBe(200);
      const foreign = await read(`/v1/deployments/environments/${foreignEnvironment.environmentId}?serverId=${serverId}`);
      expect(foreign.statusCode, foreign.body).toBe(401);
    }, { authentication: 'real' });
  });

  it('refuses to issue adopt create authority into a destination the requester cannot manage', async () => {
    const f = await fixture();
    await expect(
      f.mint('machines.services.adopt', f.adoptInput(f.foreign.id)),
    ).rejects.toMatchObject({ code: 'source_access_denied' });
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
