import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '../../actions/externalActionApi.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from '../../actions/actionIds.js';
import { DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1 } from '../../actions/actionIdsDatabaseV1.js';
import { parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { parseActionExecuteFailure } from '../../actions/actionExecutionResult.js';
import { computeMachineInstallationKeyFingerprintV1 } from '../../machines/identity/installationKeySchemas.js';
import {
  openManagedControllerActionCodecV1,
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
      errorCode: 'telemetry_collector_key_mismatch',
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
    ).toMatchObject({ errorCode: 'telemetry_collector_key_mismatch' });
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
        errorCode: 'telemetry_collector_key_unbound',
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
