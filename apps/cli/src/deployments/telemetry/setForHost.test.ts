import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { computeMachineInstallationKeyFingerprintV1 } from '@happier-dev/protocol/machines/identity/installationKeySchemas';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createEnvironmentTelemetrySetForHost } from './setForHost';

const rowKey = tweetnacl.sign.keyPair().publicKey;
const contentKey = tweetnacl.sign.keyPair().publicKey;

// The host ports are the Home read and Machine content decode boundary; the writer and its
// reviewed-child payload stay real. The collector already has a secret, so nothing else is written.
function run(
  machine: Readonly<{
    encryptionMode: 'plain' | 'e2ee';
    metadataKey?: Uint8Array;
  }>,
) {
  const detail = createDeploymentEnvironmentDetailV1();
  detail.environment.telemetryMachineId = 'collector';
  detail.content = DeploymentEnvironmentContentV1Schema.parse({
    ...detail.content,
    bindings: [
      {
        ...createDeploymentVariableBindingV1({
          phase: 'runtime',
          name: 'OTEL_EXPORTER_OTLP_HEADERS',
          source: {
            kind: 'secret',
            ref: 'happier:shared-secret:v1:resource-id',
            resourceRevision: 37,
          },
        }),
        managedBy: 'telemetry',
        valueFormat: 'otelAuthorizationHeader',
      },
    ],
  });
  const invoked: unknown[] = [];
  const set = createEnvironmentTelemetrySetForHost({
    credentials: {
      token: 't',
      encryption: null,
      credentialProvenance: 'stored_session',
    } as never,
    serverId: 'home',
    serverHttpBaseUrl: 'https://home.test',
    readEnvironment: async () => ({
      environment: detail.environment,
      content: detail.content,
      targetLinks: detail.targetLinks.map((link) => link.targetLink),
    }),
    readProject: async () => ({ name: 'Project' }),
    readMachine: async () => ({
      encryptionMode: machine.encryptionMode,
      installationPublicKey: Buffer.from(rowKey).toString('base64'),
      metadata: {
        rolesV1: { active: ['happier.telemetry/telemetry'] },
        ...(machine.metadataKey
          ? {
              installationPublicKey: Buffer.from(machine.metadataKey).toString(
                'base64url',
              ),
            }
          : {}),
      },
    }),
  });
  const context = {
    hostReviewedChild: {
      invoke: async (request: { input: unknown }) => {
        invoked.push(request.input);
        return {
          ok: true,
          result: {
            ok: true,
            environmentId: detail.environment.id,
            revision: detail.environment.revision + 1,
          },
        };
      },
    },
  } as unknown as ActionExecutorContext; // Only the reviewed-child port is read on this path.
  const result = set(
    {
      serverId: 'home',
      environmentId: detail.environment.id,
      expectedRevision: detail.environment.revision,
      collector: { machineId: 'collector' },
    },
    context,
  );
  return { result, invoked };
}
const pinOf = (key: Uint8Array) => ({
  machineId: 'collector',
  installationKeyFingerprint: computeMachineInstallationKeyFingerprintV1(key),
});

describe('telemetry collector pin source', () => {
  it('pins the key the collector publishes in its E2EE content, not the Home row key', async () => {
    const { result, invoked } = run({
      encryptionMode: 'e2ee',
      metadataKey: contentKey,
    });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(invoked).toEqual([
      expect.objectContaining({ telemetryCollector: pinOf(contentKey) }),
    ]);
  });

  it('refuses an E2EE collector whose content publishes no key, writing nothing', async () => {
    const { result, invoked } = run({ encryptionMode: 'e2ee' });
    await expect(result).resolves.toMatchObject({
      ok: false,
      errorCode: 'installation_key_unbound',
      details: { machineId: 'collector', recovery: 'restart_daemon' },
    });
    expect(invoked).toEqual([]);
  });

  it('keeps the Home row key for plain collector content', async () => {
    const { result, invoked } = run({
      encryptionMode: 'plain',
      metadataKey: contentKey,
    });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(invoked).toEqual([
      expect.objectContaining({ telemetryCollector: pinOf(rowKey) }),
    ]);
  });
});
