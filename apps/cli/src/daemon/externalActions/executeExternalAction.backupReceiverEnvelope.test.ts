import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';

it.each(['names a receiver', 'names no receiver'] as const)(
  'retains the original envelope for a Backup configure root only when its review %s', async scenario => {
    const actionId = 'deployments.backups.configure';
    const target = { kind: 'machine', machineId: 'source' } as const;
    const authentication = { kind: 'account', tokenEpoch: 1 } as const;
    const account = { accountId: 'person', authentication, authority: 'present_user' } as const;
    const rootInput = { serverId: 'srv_home', environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
      ...(scenario === 'names a receiver' ? { destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver',
        expectedInstallationId: 'receiver-installation', receiverInputs: {} } } : {}),
      configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
        config: { path: '/private/repository' }, credentialBindings: [],
        sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
        ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
    const envelope = { v: 1 as const, requestId: 'backup-configure', target, input: rootInput };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-root', binding: {
      accountId: account.accountId, authentication, actionId, requestId: envelope.requestId, target, environmentId: 'environment',
      serverIdentityId: 'srv_home', machineId: target.machineId, custodianAccountId: account.accountId,
      installationId: 'installation', admittedMachineRole: 'manage', accountEncryptionMode: 'plain',
      deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, rootInput),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const contexts: ActionExecutorContext[] = [];
    // The native Backup effect is the boundary; this records the context the executor receives.
    const executor = { execute: async (_id: string, _input: unknown, context: ActionExecutorContext) => {
      contexts.push(context);
      return { ok: false as const, errorCode: 'fixture_stop', error: 'fixture_stop' };
    } };
    await executeExternalAction({ actionId, envelope, principal: account,
      currentMachineId: target.machineId, currentAccountId: account.accountId, currentInstallationId: 'installation',
      currentServerId: 'srv_home', executionAuthorization: authorization, executor,
      verifyExecutionAuthorization: async () => true,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }),
    });
    expect(contexts).toHaveLength(1);
    // Only a root whose review names the receiver carries its envelope to that receiver's Setup children.
    expect(contexts[0]?.originalActionEnvelope).toEqual(scenario === 'names a receiver' ? envelope : undefined);
  });
