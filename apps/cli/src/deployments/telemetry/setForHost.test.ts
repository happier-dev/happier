import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { computeMachineInstallationKeyFingerprintV1 } from '@happier-dev/protocol/machines/identity/installationKeySchemas';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createEnvironmentTelemetrySetForHost } from './setForHost';
import { accountSettingsParse } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';

const rowKey = tweetnacl.sign.keyPair().publicKey;
const contentKey = tweetnacl.sign.keyPair().publicKey;
const selectedDomain = { domainId: 'collector-domain', environmentId: 'collector-environment', targetLinkId: 'collector-target' };
const collectorApp = { environmentId: selectedDomain.environmentId, targetLinkId: selectedDomain.targetLinkId,
  deploymentId: 'collector-deployment', controller: { machineId: 'collector-host', installationId: 'collector-installation' } };
const documentRef = { contentArtifactId: 'collector-domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
const origin = { placement: { serverId: 'home', accountId: 'owner', ...selectedDomain, ...collectorApp.controller,
  actionOperationId: 'domain-operation', requestId: 'domain-request', nativeServer: 'private' },
  content: documentRef, desired: true, listener: 'privateOrigin' as const,
  telemetryCollector: { machineId: 'collector', deploymentId: collectorApp.deploymentId } };

// The host ports are the Home read and Machine content decode boundary; the writer and its
// reviewed-child payload stay real. The collector already has a secret, so nothing else is written.
function run(
  machine: Readonly<{
    encryptionMode: 'plain' | 'e2ee';
    metadataKey?: Uint8Array;
  }>,
  extraBindings: readonly ReturnType<typeof createDeploymentVariableBindingV1>[] = [],
  vercel?: {
    selected?: true;
    publiclyServed?: true;
    rotateOn?: Pick<Parameters<typeof createEnvironmentTelemetrySetForHost>[0], 'credentials' | 'serverHttpBaseUrl' | 'savedSecretOperationContext'>;
  },
) {
  const detail = createDeploymentEnvironmentDetailV1();
  detail.environment.telemetryMachineId = 'collector';
  if (vercel) {
    detail.environment.runtimeTargetLinkId = 'vercel-link';
    detail.targetLinks = [{ targetLink: createDeploymentTargetLinkHeaderV1({ id: 'vercel-link',
      environmentId: detail.environment.id, targetKind: 'vercel', machines: [], members: [],
      source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.vercel', localId: 'runtime' } } }) }];
  }
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
      ...extraBindings,
    ],
  });
  const invoked: unknown[] = [];
  const domainReads: string[] = [];
  const set = createEnvironmentTelemetrySetForHost({
    credentials: {
      token: 't',
      encryption: null,
      credentialProvenance: 'stored_session',
    } as never,
    serverId: 'home',
    serverHttpBaseUrl: 'https://home.test',
    ...vercel?.rotateOn,
    readEnvironment: async () => ({
      environment: detail.environment,
      content: detail.content,
      targetLinks: detail.targetLinks.map((link) => link.targetLink),
    }),
    readProject: async () => ({ name: 'Project' }),
    readMachine: async () => ({
      encryptionMode: machine.encryptionMode,
      ...(vercel ? { deploymentApp: collectorApp } : {}),
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
    ...(vercel ? { publicCollectorDomain: {
      async get({ domainId, environmentId }: Pick<typeof selectedDomain, 'domainId' | 'environmentId'>) {
        domainReads.push(domainId);
        expect({ domainId, environmentId }).toEqual({ domainId: selectedDomain.domainId, environmentId: selectedDomain.environmentId });
        const placements = vercel.publiclyServed
          ? [origin, { ...origin, listener: 'public', placement: { ...origin.placement, nativeServer: 'https' } }] : [origin];
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: domainId, environmentId, targetLinkId: selectedDomain.targetLinkId,
          state: 'active', revision: 1, ...documentRef, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, placements });
        return { ok: true as const, environmentId, domain, revision: domain.revision };
      },
      async open(artifactId: string) {
        expect(artifactId).toBe(documentRef.contentArtifactId);
        return { artifactId, header: { kind: 'deployment-domain.v1' as const, title: 'Collector' },
          body: JSON.stringify({ hostname: 'collector.example.test', target: { kind: 'telemetry' } }),
          revision: { headerVersion: 1, bodyVersion: 1 } };
      },
    } } : {}),
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
      ...(vercel?.rotateOn ? { rotate: true as const } : { collector: { machineId: 'collector' } }),
      ...(vercel?.selected ? { publicCollectorDomain: selectedDomain } : {}),
    },
    context,
  );
  return { result, invoked, domainReads };
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

it('keeps a deliberate Environment sampler while updating the collector bindings', async () => {
  const sampler = createDeploymentVariableBindingV1({
    phase: 'runtime', name: 'OTEL_TRACES_SAMPLER',
    source: { kind: 'value', value: 'parentbased_traceidratio' },
  });
  const { result, invoked } = run({ encryptionMode: 'plain' }, [{ ...sampler, managedBy: 'telemetry' }]);
  await expect(result).resolves.toMatchObject({ ok: true });
  expect(invoked).toEqual([expect.objectContaining({ remove: [] })]);
});

describe('Vercel collector exporter', () => {
  it('projects the exact public Domain through the reviewed bindings child', async () => {
    const { result, invoked } = run({ encryptionMode: 'plain' }, [], { selected: true, publiclyServed: true });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(invoked).toEqual([expect.objectContaining({ set: expect.arrayContaining([
      expect.objectContaining({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', managedBy: 'telemetry',
        source: { kind: 'value', value: 'https://collector.example.test/' } }),
      expect.objectContaining({ name: 'OTEL_EXPORTER_OTLP_HEADERS', valueFormat: 'otelAuthorizationHeader',
        source: expect.objectContaining({ kind: 'secret' }) }),
    ]) })]);
  });

  it('rotates the existing collector token while keeping its chosen endpoint', async () => {
    const fixture = await createSavedSecretsCliHttpFixture();
    try {
      const credentials = await fixture.deps.readCredentialsFn?.();
      if (!credentials) throw new Error('Missing fixture credentials');
      const endpoint = { ...createDeploymentVariableBindingV1({
        phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
        source: { kind: 'value', value: 'https://collector.example.test/' },
      }), managedBy: 'telemetry' as const };
      const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({
        credentials, serverHttpBaseUrl: fixture.origin, isCurrent: async () => true,
        snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 7, loadedAtMs: 1,
          scopeKey: fixture.inHome(() => resolveAccountSettingsScopeKey(credentials)), settingsSecretsReadKeys: [] },
      });
      const { result, invoked, domainReads } = fixture.inHome(() => run({ encryptionMode: 'plain' }, [endpoint], {
        rotateOn: { credentials, serverHttpBaseUrl: fixture.origin, savedSecretOperationContext },
      }));
      const outcome = await result;
      expect('errorCode' in outcome ? outcome.errorCode : outcome.ok).toBe(true);
      expect(domainReads).toEqual([]);
      expect(fixture.writes).toMatchObject([{ resourceId: 'resource-id', expectedRevision: 37 }]);
      expect(invoked).toEqual([expect.objectContaining({ set: expect.arrayContaining([
        expect.objectContaining({ name: endpoint.name, source: endpoint.source }),
        expect.objectContaining({ name: 'OTEL_EXPORTER_OTLP_HEADERS',
          source: { kind: 'secret', ref: 'happier:shared-secret:v1:resource-id', resourceRevision: 38 } }),
      ]) })]);
    } finally { await fixture.close(); }
  });

  it('requires a person-selected Domain and rejects a private-only Domain before writing', async () => {
    const missing = run({ encryptionMode: 'plain' }, [], {});
    await expect(missing.result).resolves.toMatchObject({ ok: false, errorCode: 'collector_public_domain_required' });
    expect(missing.invoked).toEqual([]);
    const privateOnly = run({ encryptionMode: 'plain' }, [], { selected: true });
    await expect(privateOnly.result).resolves.toMatchObject({ ok: false, errorCode: 'collector_route_unavailable',
      details: { state: 'private_only' } });
    expect(privateOnly.invoked).toEqual([]);
  });
});
