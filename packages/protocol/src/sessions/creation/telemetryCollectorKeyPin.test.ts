import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '../../actions/externalActionApi.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from '../../actions/actionIds.js';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '../../actions/operations/actionIdsV1.js';
import { DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1 } from '../../actions/actionIdsDatabaseV1.js';
import { parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { parseActionExecuteFailure } from '../../actions/actionExecutionResult.js';
import { computeMachineInstallationKeyFingerprintV1 } from '../../machines/identity/installationKeySchemas.js';
import {
  openExternalActionRequesterAccountContextV1,
  openManagedControllerActionCodecV1,
  readExecutorKeyPinFromMachineContentV1,
  sealExternalActionRequesterAccountContextV1,
  sealManagedControllerActionCodecV1,
} from './sessionRequesterBootstrapV1.js';

const collector = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
const substitute = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
const material = {
  type: 'dataKey' as const,
  machineKey: new Uint8Array(32).fill(7),
};
const environmentIds = ['environment-a', 'environment-b'];

function telemetryRoot(accountEncryptionMode: 'plain' | 'e2ee') {
  const target = { kind: 'machine' as const, machineId: 'collector' };
  return ExternalActionExecutionAuthorizationV1Schema.parse({
    v: 1,
    token: 'telemetry-read',
    binding: {
      accountId: 'reader',
      custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home',
      machineId: target.machineId,
      installationId: 'installation',
      accountEncryptionMode,
      actionId: ACTION_INVOKE_ACTION_ID_V1,
      requestId: 'read',
      requestEnvelopeDigest: 'a'.repeat(43),
      target,
      telemetryCollectorCodec: true,
      deploymentReadAdmission: {
        actionId: ACTION_INVOKE_ACTION_ID_V1,
        action: parseQualifiedPluginActionId(
          DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
        ),
        telemetryCollector: { serverId: 'home', environmentIds },
      },
      deploymentTelemetryRead: environmentIds.map((environmentId) => ({
        environmentId,
        revision: 1,
        capabilities: {},
      })),
    },
  });
}
const pinned = (publicKey: Uint8Array, machineId = 'collector') =>
  environmentIds.map((environmentId) => ({
    environmentId,
    collector: {
      machineId,
      installationKeyFingerprint:
        computeMachineInstallationKeyFingerprintV1(publicKey),
    },
  }));
function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return parseActionExecuteFailure(error);
  }
  throw new Error('Expected a typed refusal');
}

describe('Environment-pinned collector key at the codec sealing owner', () => {
  it('seals an E2EE reader request to the collector key its Environment content pins', () => {
    const authorization = telemetryRoot('e2ee');
    const sealed = sealManagedControllerActionCodecV1({
      authorization,
      material,
      installationPublicKey: collector.publicKey,
      collectorKeyPins: pinned(collector.publicKey),
      randomBytes: tweetnacl.randomBytes,
    });
    expect(
      openManagedControllerActionCodecV1({
        authorization: sealed,
        machineId: 'collector',
        installationId: 'installation',
        serverIdentityId: 'home',
        installationPrivateKey: collector.secretKey,
      }),
    ).toEqual(material);
  });

  it('refuses a Home-substituted key and never falls back to it', () => {
    const authorization = telemetryRoot('e2ee');
    expect(
      refusal(() =>
        sealManagedControllerActionCodecV1({
          authorization,
          material,
          installationPublicKey: substitute.publicKey,
          collectorKeyPins: pinned(collector.publicKey),
          randomBytes: tweetnacl.randomBytes,
        }),
      ),
    ).toMatchObject({
      errorCode: 'installation_key_mismatch',
      details: { environmentIds },
    });
    // A pin for another Machine is not this collector's pin.
    expect(
      refusal(() =>
        sealManagedControllerActionCodecV1({
          authorization,
          material,
          installationPublicKey: collector.publicKey,
          collectorKeyPins: pinned(collector.publicKey, 'previous-collector'),
          randomBytes: tweetnacl.randomBytes,
        }),
      ),
    ).toMatchObject({ errorCode: 'installation_key_mismatch' });
  });

  it('refuses an E2EE read whose Environment has no bound key, naming the setup recovery', () => {
    const authorization = telemetryRoot('e2ee');
    const partly = [
      pinned(collector.publicKey)[0]!,
      { environmentId: environmentIds[1]! },
    ];
    for (const collectorKeyPins of [undefined, partly]) {
      expect(
        refusal(() =>
          sealManagedControllerActionCodecV1({
            authorization,
            material,
            installationPublicKey: collector.publicKey,
            ...(collectorKeyPins ? { collectorKeyPins } : {}),
            randomBytes: tweetnacl.randomBytes,
          }),
        ),
      ).toMatchObject({
        errorCode: 'installation_key_unbound',
        details: {
          environmentIds: collectorKeyPins
            ? [environmentIds[1]]
            : environmentIds,
          recovery: 'telemetry_setup',
        },
      });
    }
  });

  it('leaves plain-mode readers on the existing path without Environment pins', () => {
    const authorization = telemetryRoot('plain');
    const sealed = sealManagedControllerActionCodecV1({
      authorization,
      material,
      installationPublicKey: collector.publicKey,
      randomBytes: tweetnacl.randomBytes,
    });
    expect(
      openManagedControllerActionCodecV1({
        authorization: sealed,
        machineId: 'collector',
        installationId: 'installation',
        serverIdentityId: 'home',
        installationPrivateKey: collector.secretKey,
      }),
    ).toEqual(material);
  });
});

function operationRoot(accountEncryptionMode: 'plain' | 'e2ee') {
  const target = { kind: 'machine' as const, machineId: 'executor' };
  return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'operation-read', binding: {
    accountId: 'reader', custodianAccountId: 'reader', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'home', machineId: target.machineId, installationId: 'installation', accountEncryptionMode,
    actionId: ACTION_OPERATION_GET_ACTION_ID_V1, requestId: 'read-operation', requestEnvelopeDigest: 'a'.repeat(43), target,
    requesterOperationRead: true,
  } });
}
const executorPin = (publicKey: Uint8Array, machineId = 'executor') => ({ machineId,
  installationKeyFingerprint: computeMachineInstallationKeyFingerprintV1(publicKey) });

describe('executor key read from E2EE Machine content at the codec sealing owner', () => {
  it('seals an operation read to the key the executor published in its own content', () => {
    const authorization = operationRoot('e2ee');
    const sealed = sealManagedControllerActionCodecV1({ authorization, material, installationPublicKey: collector.publicKey,
      executorKeyPin: executorPin(collector.publicKey), randomBytes: tweetnacl.randomBytes });
    expect(openManagedControllerActionCodecV1({ authorization: sealed, machineId: 'executor', installationId: 'installation',
      serverIdentityId: 'home', installationPrivateKey: collector.secretKey })).toEqual(material);
  });

  it('refuses a substituted key, or readable content that publishes no key, with the same refusals', () => {
    const authorization = operationRoot('e2ee');
    expect(refusal(() => sealManagedControllerActionCodecV1({ authorization, material, installationPublicKey: substitute.publicKey,
      executorKeyPin: executorPin(collector.publicKey), randomBytes: tweetnacl.randomBytes })))
      .toMatchObject({ errorCode: 'installation_key_mismatch', details: { machineId: 'executor' } });
    expect(refusal(() => sealManagedControllerActionCodecV1({ authorization, material, installationPublicKey: collector.publicKey,
      executorKeyPin: null, randomBytes: tweetnacl.randomBytes })))
      .toMatchObject({ errorCode: 'installation_key_unbound', details: { machineId: 'executor', recovery: 'restart_daemon' } });
  });

  it('keeps the Home-delivered key when the reader cannot open the executor content, and for plain readers', () => {
    for (const authorization of [operationRoot('e2ee'), operationRoot('plain')]) {
      const sealed = sealManagedControllerActionCodecV1({ authorization, material, installationPublicKey: collector.publicKey,
        randomBytes: tweetnacl.randomBytes });
      expect(openManagedControllerActionCodecV1({ authorization: sealed, machineId: 'executor', installationId: 'installation',
        serverIdentityId: 'home', installationPrivateKey: collector.secretKey })).toEqual(material);
    }
  });
});

describe('executor pin from opened Machine content', () => {
  it('pins only E2EE content and reports E2EE content without a key as unbound', () => {
    const key = Buffer.from(collector.publicKey).toString('base64url');
    expect(readExecutorKeyPinFromMachineContentV1({ machineId: 'executor', contentMode: 'e2ee', installationPublicKey: key }))
      .toEqual(executorPin(collector.publicKey));
    expect(readExecutorKeyPinFromMachineContentV1({ machineId: 'executor', contentMode: 'e2ee' })).toBeNull();
    expect(readExecutorKeyPinFromMachineContentV1({ machineId: 'executor', contentMode: 'plain', installationPublicKey: key })).toBeUndefined();
  });
});

function credentialRoot(accountEncryptionMode: 'plain' | 'e2ee') {
  const target = { kind: 'machine' as const, machineId: 'executor' };
  return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'credential-seal', binding: {
    accountId: 'reader', custodianAccountId: 'reader', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'home', machineId: target.machineId, installationId: 'installation', accountEncryptionMode,
    actionId: ACTION_INVOKE_ACTION_ID_V1, requestId: 'credential-seal', requestEnvelopeDigest: 'a'.repeat(43), target,
  } });
}
const credentialsFor = (mode: 'plain' | 'e2ee') => mode === 'e2ee'
  ? { token: 'requester-token', secret: Buffer.alloc(32, 9).toString('base64') } : { token: 'requester-token' };

describe('every installation seal of an E2EE Account checks the executor key its Machine content pins', () => {
  const seal = (mode: 'plain' | 'e2ee', installationPublicKey: Uint8Array, executorKeyPin?: ReturnType<typeof executorPin> | null) =>
    sealExternalActionRequesterAccountContextV1({ authorization: credentialRoot(mode), credentials: credentialsFor(mode),
      purpose: { kind: 'external_action' }, installationPublicKey, randomBytes: tweetnacl.randomBytes,
      ...(executorKeyPin === undefined ? {} : { executorKeyPin }) });
  const open = (authorization: ReturnType<typeof seal>) => openExternalActionRequesterAccountContextV1({ authorization,
    purpose: { kind: 'external_action' }, machineId: 'executor', installationId: 'installation', serverIdentityId: 'home',
    installationPrivateKey: collector.secretKey });

  it('refuses requester credentials sealed to a Home-substituted key and seals to the pinned key', () => {
    expect(refusal(() => seal('e2ee', substitute.publicKey, executorPin(collector.publicKey))))
      .toMatchObject({ errorCode: 'installation_key_mismatch', details: { machineId: 'executor' } });
    expect(refusal(() => seal('e2ee', collector.publicKey, null)))
      .toMatchObject({ errorCode: 'installation_key_unbound', details: { machineId: 'executor', recovery: 'restart_daemon' } });
    expect(refusal(() => seal('e2ee', collector.publicKey, executorPin(collector.publicKey, 'other-machine'))))
      .toMatchObject({ errorCode: 'installation_key_mismatch' });
    expect(open(seal('e2ee', collector.publicKey, executorPin(collector.publicKey)))).toMatchObject({ token: 'requester-token' });
  });

  it('keeps plain Accounts on the delivered key', () => {
    expect(open(seal('plain', collector.publicKey, executorPin(substitute.publicKey)))).toEqual({ token: 'requester-token' });
  });
});
