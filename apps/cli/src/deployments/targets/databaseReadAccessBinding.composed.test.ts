import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
  DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
  DEPLOYMENT_DATABASE_READ_ACCESS_BINDINGS_CHILD_ROLE_V1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import {
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
  DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
} from '@happier-dev/deployment-protocol';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import {
  DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1,
  DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1,
} from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import {
  createHostReviewedChildPortV1,
  invokeHostReviewedChildV1,
  readHostAdmittedReviewedParentV1,
} from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import {
  normalizeStrictJsonValue,
  StrictJsonValueSchema,
} from '@happier-dev/protocol/json/strictJsonValue';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { createSavedSecretResourceInTx } from '../../../../server/sources/app/account/savedSecrets/savedSecretResourceService';
import { syncEnvironmentSecretGrantsInTx } from '../../../../server/sources/app/deployments/environmentSecretGrantRepository';
import * as installationStore from '@/daemon/identity/store';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import {
  installationBoundary,
  readS0ControllerCredentials,
  readS0Installation,
} from '../deploymentDaemonIngress.composed.testkit';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { sealMachineSecretGrant } from '../secrets/machineSecretGrant';
import { createOwnServerDeploymentRuntimeForHost } from './ownServer/ownServerDeploymentHostRuntime';

afterEach(() => vi.restoreAllMocks());

// The fixtures share the server process's canonical Home identity cache.
const serverId = `srv_${randomUUID().replaceAll('-', '')}`;

// #216 shape: a Railway app Environment with provider Variables and a reviewed writer login already
// sealed to the controller. Read setup's reviewed binding child adds the limited login in the same
// Apply (or Attach). Home, its signed route and admission, the Artifact store and the daemon's
// bindings writer stay real; only the Railway runtime is a database row.
it.each([
  ['plain', 'attach'],
  ['e2ee', 'attach'],
  ['plain', 'apply'],
  ['e2ee', 'apply'],
] as const)(
  'binds the read login from the reviewed %s read setup child (%s) next to a Railway runtime and its writer',
  async (mode, setup) => {
    const home = await createDeploymentSocketHome({
      encryptionMode: mode,
      serverId,
      ...(mode === 'e2ee'
        ? {
            prepareMachineContent: (
              key: Uint8Array,
              metadata: Readonly<Record<string, unknown>>,
            ) =>
              createMachineContentCodec({
                encryptionMode: 'e2ee',
                encryptionKey: key,
                encryptionVariant: 'dataKey',
              }).encodeStored(metadata),
          }
        : {}),
    });
    const lifetime = new AbortController();
    try {
      vi.spyOn(
        installationStore,
        'readInstallationIdentityIfExistsSync',
      ).mockImplementation(
        () => installationBoundary.getStore() ?? readS0Installation(home),
      );
      const credentials = readS0ControllerCredentials(home);
      const artifacts = createCredentialedAccountArtifactStore(credentials);
      const content = async (
        kind:
          | typeof DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1
          | typeof DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
        body: unknown,
      ) => {
        if (mode === 'plain')
          return home.createContentArtifact(
            { body: JSON.stringify(body) },
            kind,
          );
        const created = await runWithServerHttpBaseUrl(home.baseUrl, () =>
          artifacts.create({
            header: { kind, title: 'Railway app' },
            body: JSON.stringify(body),
          }),
        );
        return {
          contentArtifactId: created.artifactId,
          contentHeaderVersion: created.revision.headerVersion,
          contentBodyVersion: created.revision.bodyVersion,
        };
      };
      const sourceResponse = await fetch(
        `${home.baseUrl}/v1/projects/sources`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${home.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            serverId,
            requestKey: randomUUID(),
            name: 'Railway app',
            audience: [],
          }),
        },
      );
      const source = ProjectSourcesCreateOutputV1Schema.parse(
        await sourceResponse.json(),
      );
      if (!source.ok) throw new Error(source.error);
      const base = createDeploymentEnvironmentDetailV1().content;
      const environment = await db.deploymentEnvironment.create({
        data: {
          projectSourceId: source.source.id,
          createdByAccountId: home.accountId,
          protection: 'nonProduction',
          purpose: 'standard',
          deployerMode: 'managers',
          dataEditorMode: 'managers',
          controllerMachineId: home.machineId,
          ...(await content(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, {
            ...base,
            bindings: [],
          })),
        },
      });
      const link = async (
        role: 'runtime' | 'data',
        pluginId: string,
        localId: string,
        targetKind: string,
      ) =>
        db.deploymentTargetLink.create({
          data: {
            environmentId: environment.id,
            createdByAccountId: home.accountId,
            role,
            state: role === 'runtime' ? 'provisioned' : 'configured',
            sourceKind: 'plugin',
            pluginId,
            contributionLocalId: localId,
            targetKind,
            ...(await content(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {})),
          },
        });
      const runtime = await link(
        'runtime',
        'happier.deploy.railway',
        'runtime',
        'railway',
      );
      const postgres = await link(
        'data',
        'happier.deploy.railway-data',
        'postgresql',
        'railway-postgresql',
      );
      const mysql = await link(
        'data',
        'happier.deploy.railway-data',
        'mysql',
        'railway-mysql',
      );
      const saveSecret = async (value: string) => {
        const resourceId = randomUUID();
        const resourceDataKey = nacl.randomBytes(32);
        const secret = {
          v: 1 as const,
          kind: 'password' as const,
          name: 'railway login',
          value,
        };
        expect(
          await inTx((tx) =>
            createSavedSecretResourceInTx(tx, {
              accountId: home.accountId,
              resourceId,
              displayName: secret.name,
              kind: secret.kind,
              encryptionMode: mode,
              storedContent:
                mode === 'plain'
                  ? sealSavedSecretResourceStoredContentV1({
                      resourceId,
                      mode,
                      content: secret,
                    })
                  : sealSavedSecretResourceStoredContentV1({
                      resourceId,
                      mode,
                      content: secret,
                      resourceDataKey,
                      randomBytes: nacl.randomBytes,
                    }),
              ...(mode === 'e2ee' && home.encryption
                ? {
                    keyEnvelopes: [
                      {
                        recipientAccountId: home.accountId,
                        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(home.encryption.publicKey),
                        encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({
                          dataKey: resourceDataKey,
                          recipientPublicKey: home.encryption.publicKey,
                          randomBytes: nacl.randomBytes,
                        }),
                      },
                    ],
                  }
                : {}),
            }),
          ),
        ).toMatchObject({ ok: true });
        return {
          ref: formatSharedSavedSecretRefV1(resourceId),
          resourceRevision: 1,
          grant: sealMachineSecretGrant({
            subject: {
              v: 1,
              kind: 'secret',
              environmentId: environment.id,
              machineId: home.machineId,
              installationId: home.installationId,
              resourceId,
              resourceRevision: 1,
            },
            installationPublicKey: home.keys.publicKey,
            content: { kind: 'secret', value },
          }),
        };
      };
      // The incumbent writers on both managed Links, sealed to the controller, beside a provider Variable.
      const writers = await Promise.all(
        [postgres, mysql].map(async (target) => {
          const saved = await saveSecret(
            `postgresql://writer:${randomUUID()}@proxy.railway.test:5432/railway`,
          );
          return {
            saved,
            binding: {
              purpose: 'dataRole',
              targetLinkId: target.id,
              role: 'write',
              source: { kind: 'secret', ref: saved.ref, resourceRevision: 1 },
            } as const,
          };
        }),
      );
      const providerVariable = {
        purpose: 'variable',
        phase: 'runtime',
        name: 'ORDERS_REGION',
        source: { kind: 'value', value: 'eu-west' },
      } as const;
      const incumbent = [
        providerVariable,
        ...writers.map((writer) => writer.binding),
      ];
      await db.deploymentEnvironment.update({
        where: { id: environment.id },
        data: {
          runtimeTargetLinkId: runtime.id,
          revision: 8,
          ...(await content(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, {
            ...base,
            bindings: incumbent,
          })),
          referencedSavedSecretRevisions:
            captureDeploymentBindingSavedSecretRevisionsV1(incumbent),
        },
      });
      expect(
        await inTx((tx) =>
          syncEnvironmentSecretGrantsInTx(tx, {
            environmentId: environment.id,
            grants: writers.map((writer) => writer.saved.grant),
          }),
        ),
      ).not.toBeNull();
      const reader = await saveSecret(
        `postgresql://happier_ro:${randomUUID()}@proxy.railway.test:5432/railway`,
      );

      // The person's signed read setup root, admitted once by Home (setup's canManage and the exact Link).
      const databaseTarget = {
        kind: 'managed_deployment',
        environment: {
          serverId,
          environmentId: environment.id,
          projectSourceId: source.source.id,
        },
        targetLinkId: postgres.id,
        contribution: {
          pluginId: 'happier.deploy.railway-data',
          contributionId: 'postgresql',
        },
        platformProjectId: 'project',
        branchId: 'branch',
        database: 'railway',
      };
      const rootAction =
        setup === 'attach'
          ? DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1
          : DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1;
      const rootInput =
        setup === 'attach'
          ? {
              target: databaseTarget,
              savedSecretRef: reader.ref,
              resourceRevision: 1,
            }
          : {
              target: databaseTarget,
              mode: 'apply',
              role: 'happier_ro_fixture',
              statements: ['CREATE ROLE "happier_ro_fixture"'],
            };
      const target = { kind: 'machine' as const, machineId: home.machineId };
      const invocation = {
        action: parseQualifiedPluginActionId(rootAction)!,
        input: StrictJsonValueSchema.parse(rootInput),
      };
      const envelope = {
        v: 1 as const,
        requestId: randomUUID(),
        target,
        input: invocation,
      };
      const account = await db.account.findUniqueOrThrow({
        where: { id: home.accountId },
        select: { tokenEpoch: true },
      });
      const minted = await auth.mintExternalActionExecutionAuthorization(
        {
          accountId: home.accountId,
          serverIdentityId: serverId,
          authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
          actionId: ACTION_INVOKE_ACTION_ID_V1,
          machineId: home.machineId,
          target,
          requestId: envelope.requestId,
          requestEnvelopeDigest:
            computeExternalActionRequestEnvelopeDigestV1(envelope),
          deploymentReadAdmission: projectDeploymentReadAdmissionV1(
            ACTION_INVOKE_ACTION_ID_V1,
            invocation,
          ),
        },
        { input: invocation },
      );
      const requester = await admitRequesterAccountActionContext({
        credentials,
        serverId,
        serverIdentityId: serverId,
        serverHttpBaseUrl: home.baseUrl,
        isCurrent: async () => true,
        authorization: { v: 1, ...minted },
      });
      if (!requester)
        throw new Error('The signed read setup root must admit its requester');
      const authorization =
        await projectExternalActionRequesterHttpAuthorization({
          authorization: requester.authorization,
          serverId,
          serverIdentityId: serverId,
          serverHttpBaseUrl: home.baseUrl,
          target,
          installationId: home.installationId,
          privateKey: home.keys.secretKey,
          rootAdmitted: true,
        });
      if (!authorization)
        throw new Error('The root requester HTTP custody must be projected');
      const rootContext = {
        externalActionExecutionAuthorization: authorization,
        runtimeAccountId: home.accountId,
        externalActionTarget: target,
        surface: 'api' as const,
        actionCaller: { kind: 'host' as const },
        signal: lifetime.signal,
      };
      const context = {
        ...rootContext,
        hostReviewedChild: createHostReviewedChildPortV1({
          actionId: ACTION_INVOKE_ACTION_ID_V1,
          input: invocation,
          context: rootContext,
          reviewAdmitted: true,
        }),
      };

      const requesterIdentity = selectHostRequesterExecutionIdentity({
        hostHomeServerIdentityId: serverId,
        hostAccountAutomation: {
          accountId: home.accountId,
          custodianAccountId: home.accountId,
          machineId: home.machineId,
          installationId: home.installationId,
        },
      });
      const host = {
        credentials,
        serverId,
        serverHttpBaseUrl: home.baseUrl,
        machineId: home.machineId,
      };
      const daemon = createDaemonDeploymentActionDeps({
        ...host,
        resolveRequesterIdentity: async () => requesterIdentity,
        runtime: createOwnServerDeploymentRuntimeForHost({
          ...host,
          resolveRequesterIdentity: async () => requesterIdentity,
          acquirePluginRuntimeRegistryLease: () =>
            pluginReloadController.acquireRuntimeRegistry(),
          signal: lifetime.signal,
        }),
      });
      // The same child the Workbench host issues after verifying or saving the login.
      const parent = readHostAdmittedReviewedParentV1(
        context.hostReviewedChild,
      );
      if (!parent)
        throw new Error('The admitted read setup parent must be readable');
      const settled = await runWithServerHttpBaseUrl(home.baseUrl, () =>
        invokeHostReviewedChildV1({
          parent,
          context,
          environmentId: environment.id,
          child: {
            action: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
            role: DEPLOYMENT_DATABASE_READ_ACCESS_BINDINGS_CHILD_ROLE_V1,
            input: normalizeStrictJsonValue({
              serverId,
              environmentId: environment.id,
              expectedRevision: 8,
              set: [
                {
                  purpose: 'dataRole',
                  targetLinkId: postgres.id,
                  role: 'readOnlyPassword',
                  source: {
                    kind: 'secret',
                    ref: reader.ref,
                    resourceRevision: 1,
                  },
                },
              ],
              remove: [],
            }),
          },
          execute: async (value, childContext) => {
            const result = await daemon.deploymentAction!(
              DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
              value as Parameters<
                NonNullable<typeof daemon.deploymentAction>
              >[1],
              childContext,
            );
            return 'errorCode' in result
              ? result
              : { ok: true as const, result };
          },
        }),
      );
      expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true });
      if (!settled.ok) return;
      expect(
        DeploymentBindingsSetResultV1Schema.parse(settled.result),
        JSON.stringify(settled.result),
      ).toMatchObject({ ok: true, revision: 9 });
      const stored = await db.deploymentEnvironment.findUniqueOrThrow({
        where: { id: environment.id },
      });
      expect(stored.referencedSavedSecretRevisions).toEqual(
        captureDeploymentBindingSavedSecretRevisionsV1([
          ...incumbent,
          {
            purpose: 'dataRole',
            targetLinkId: postgres.id,
            role: 'readOnlyPassword',
            source: { kind: 'secret', ref: reader.ref, resourceRevision: 1 },
          },
        ]),
      );
      // The controller alone receives the limited login, beside the writers' existing seals.
      expect(
        await db.machineSecretGrant.count({
          where: { environmentId: environment.id, machineId: home.machineId },
        }),
      ).toBe(3);
    } finally {
      lifetime.abort();
      await home.close();
    }
  },
  120_000,
);
