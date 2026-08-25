import { describe, expect, it } from 'vitest';

import { PluginInstallReviewPrincipalDigestSchema } from '../plugins/permissions/grants.js';
import {
  DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
  DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema,
  DaemonVoiceClientRawCredentialMaterializeRequestV1Schema,
  DaemonVoiceClientRawCredentialMaterializeResponseV1Schema,
} from './voiceCredentials.js';

const contribution = { pluginId: 'acme.voice', localId: 'browser' } as const;

describe('daemon Voice raw credential authorization wire', () => {
  it('preserves the legacy raw-materialization shape while carrying an optional host callback receipt', () => {
    const cacheIdentity = {
      pluginId: contribution.pluginId,
      contributionId: contribution.localId,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      hostAppVersion: '2.0.0',
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.0.0',
      reactNativeVersion: '0.83.4',
      platform: 'web' as const,
      channel: 'internal' as const,
      nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
      projectionGeneration: 12,
    };
    const request = {
      cacheIdentity,
      phase: 'connection' as const,
      request: {
        kind: 'httpHeaders' as const,
        origin: 'https://voice.example.test',
        headerNames: ['authorization'],
      },
    };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';

    expect(DaemonVoiceClientRawCredentialMaterializeRequestV1Schema.parse(request))
      .toEqual(request);
    expect(DaemonVoiceClientRawCredentialMaterializeRequestV1Schema.parse({
      ...request,
      expectedCredentialRevision: revision,
    })).toMatchObject({ expectedCredentialRevision: revision });
    expect(DaemonVoiceClientRawCredentialMaterializeRequestV1Schema.safeParse({
      ...request,
      expectedCredentialRevision: 'not-a-revision',
    }).success).toBe(false);

    const success = {
      ok: true as const,
      materialization: {
        kind: 'httpHeaders' as const,
        headers: { authorization: 'Bearer host-only' },
      },
    };
    expect(DaemonVoiceClientRawCredentialMaterializeResponseV1Schema.parse(success))
      .toEqual(success);
    expect(DaemonVoiceClientRawCredentialMaterializeResponseV1Schema.parse({
      ...success,
      credentialRevision: revision,
    })).toMatchObject({ credentialRevision: revision });
  });

  it('accepts only the qualified contribution from callers and returns exact review facts', () => {
    expect(DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema.parse({ contribution }))
      .toEqual({ contribution });
    expect(DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema.safeParse({
      contribution,
      subject: { kind: 'general' },
    }).success).toBe(false);

    const parsed = DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({
      ok: true,
      authorization: {
        pluginId: contribution.pluginId,
        capability: 'credentials.materialize.raw',
        targetScope: { kind: 'account' },
        subject: {
          kind: 'credential_access_disclosure',
          contribution,
          credentialSlotId: 'api_key',
          purpose: 'voice.browser',
          accessDeclarationDigest: 'b'.repeat(64),
          selectedAuthorityDigest: 'c'.repeat(64),
          selectedRawAccessDigest: 'd'.repeat(64),
          installedGenerationId: 'generation-1',
          installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
        },
        authoritySource: {
          kind: 'machine_installation',
          machineId: 'machine-a',
          installationId: 'installation-a',
        },
        disclosures: [{
          sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
          realm: 'web',
          phase: 'connection',
          materialization: 'httpHeaders',
          origin: 'https://voice.example.test',
          destination: 'authorization',
        }],
      },
      review: {
        plugin: { id: contribution.pluginId, name: 'Acme Voice', version: '2.0.0' },
        package: { identity: '@acme/voice' },
        distribution: {
          kind: 'npm',
          packageName: '@acme/voice',
          registryOrigin: 'https://registry.npmjs.org',
        },
        publisher: { status: 'unverified', id: 'acme', displayName: 'Acme' },
        packageSignature: { status: 'verified', keyId: 'acme-key' },
        contribution: { identity: contribution, name: 'Browser Voice' },
        credentialSlot: { id: 'api_key', name: 'API key', purpose: 'voice.browser' },
      },
    });
    expect(parsed.ok && parsed.authorization.disclosures[0]?.destination).toBe('authorization');
    expect(DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.safeParse({
      ...parsed,
      review: parsed.ok ? {
        ...parsed.review,
        distribution: {
          kind: 'archive',
          locator: 'https://example.test/private.tgz?token=secret',
        },
      } : undefined,
    }).success).toBe(false);
  });
});
