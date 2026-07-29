import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  ProviderCredentialTransportV1Schema,
  createProviderObservationAuthorizationFingerprintV1,
} from '@happier-dev/protocol';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '@happier-dev/plugins-cliproxyapi';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type {
  ManagedProviderRuntimeAdapterInput,
  ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';
import {
  createProviderLaunchResourceScope,
} from '@/providers/lifecycle/resourceScope';
import type {
  ProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';

import { prepareDaemonManagedProviderBinding } from './prepareDaemonManagedProviderBinding';

const connectionId = ProviderConnectionIdSchema.parse('pc_cliproxyapi');
const purposeBinding = {
  purpose: {
    consumer: {
      pluginId: 'happier.provider.cliproxyapi',
      localId: 'cliproxyapi',
    },
    purpose: 'openai-upstream',
  },
  target: {
    kind: 'account',
    account: {
      service: {
        pluginId: 'happier.connected-account.openai',
        localId: 'codex',
      },
      accountId: 'work',
    },
  },
} as const;

function managedAttempt(
  prepare: (input: ManagedProviderRuntimeAdapterInput) => Promise<never>,
): Extract<
  ProviderSpawnAuthorizationAttempt,
  { deployment: { kind: 'managedLocal' } }
> {
  const managed: ResolvedFirstPartyManagedProviderFacet = {
    managedEndpoint: {
      localService: {
        id: 'cliproxyapi',
        launch: {
          kind: 'packaged-runtime-binary',
          directorySegments: ['tools', 'unpacked'],
          executableBaseName: 'happier-cliproxyapi-managed',
          privateConfigPathFlag: '--config',
        },
        launchMode: {
          kind: 'assignAndInject',
          portPolicy: { kind: 'allocated' },
        },
        hostPolicy: { kind: 'loopback' },
        name: { strategy: 'fixed', name: 'CLIProxyAPI' },
        healthCheck: { kind: 'http', path: '/healthz' },
        restart: { kind: 'never' },
        cleanup: { staleAfterMs: 60_000 },
      },
      protocols: ['openai-chat', 'openai-responses', 'anthropic'],
    },
    connectedAccounts: [{
      purpose: purposeBinding.purpose.purpose,
      service: purposeBinding.target.account.service,
      required: true,
    }],
    requestAuthUses: [{
      purpose: purposeBinding.purpose.purpose,
      materialization: {
        kind: 'httpHeaders' as const,
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
    }],
  };
  const contribution: ResolvedProviderContribution = {
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: 'happier.provider.cliproxyapi',
    identity: {
      pluginId: 'happier.provider.cliproxyapi',
      localId: 'cliproxyapi',
    },
    definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
    managed,
    managedRuntimeAdapter: {
      v: 1,
      catalogSource: {
        kind: 'transientModelEndpoint',
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v1.0.0',
      },
      prepare: async (input) => await prepare(input),
      resolveAgentEndpoint: () => 'http://127.0.0.1:45123/v1',
    },
  };
  const purposeBindings = { v: 1 as const, bindings: [purposeBinding] };
  const runtimeCredentialTransport = ProviderCredentialTransportV1Schema.parse({
    id: 'managed-runtime-bearer',
    protocols: ['openai-responses'],
    uses: ['runtime'],
    destination: {
      kind: 'httpHeader',
      name: 'Authorization',
      format: 'bearer',
    },
  });
  const authorization = {
    deployment: {
      kind: 'managedLocal' as const,
      contribution,
      implementation: {
        kind: 'managedLocal' as const,
        implementationIdentity: contribution.identity,
        facet: managed,
        purposeBindings,
      },
    },
    ticket: {
      connectionId,
      connectionRevision: 1,
      machineId: 'machine-a',
      connectionSecurityFingerprint: 'connection-security:v1:managed',
      bindingSecurityFingerprint: 'binding-security:v1:managed',
      grantFingerprint: 'machine-grant:v1:managed',
      selectedSecretBindingId: null,
      selectedSecretRecordFingerprint: null,
    },
    bindingSecurityFingerprint: 'binding-security:v1:managed',
    observationAuthorizationFingerprint:
      createProviderObservationAuthorizationFingerprintV1({
        selectedSecretBindingId: null,
        selectedSecretRecordFingerprint: null,
        credential: null,
      }),
    binding: {
      v: 1 as const,
      agentTargetKey: 'backend:codex',
      selection: {
        connectionId,
        model: { id: 'gpt-5', name: 'GPT-5' },
      },
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      endpoint: {
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses' as const,
        publicHeaders: {},
      },
      runtimeCredentialTransport,
      compatibilityFingerprint: 'compatibility:v1:managed',
    },
    prepared: {
      v: 1 as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'cliproxyapi',
    },
    support: {
      acceptsProtocols: ['openai-responses' as const],
      required: {},
      credentialSupport: {
        supportsNoAuth: false,
        apiKeyTransports: [{
          protocol: 'openai-responses' as const,
          destination: {
            kind: 'httpHeader' as const,
            names: ['authorization'],
            formats: ['bearer' as const],
          },
        }],
      },
      authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: [],
      },
      materialization: 'engineConfig' as const,
      applyPolicy: 'restart_session' as const,
      supportsFreeformModelIds: true,
    },
    adapterVersion: 1,
    credentialReference: { kind: 'none' as const },
    sessionBindingMetadata: {
      v: 1 as const,
      connectionId,
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      connectionRevision: 1,
      model: { id: 'gpt-5', name: 'GPT-5' },
      managedPurposeBindings: purposeBindings,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'cliproxyapi',
      compatibilityFingerprint: 'compatibility:v1:managed',
      bindingSecurityFingerprint: 'binding-security:v1:managed',
      displaySnapshot: {
        providerName: 'CLIProxyAPI',
        connectionName: 'CLIProxyAPI',
        connectionRole: 'default' as const,
        connectionDisplayNameMode: 'automatic' as const,
      },
    },
  };
  return {
    deployment: authorization.deployment,
    authorization,
    isAuthorizationCurrent: () => true,
    revalidateBeforeEffect: async () => ({ ok: true }),
    revalidateBeforeCommit: async () => ({ ok: true }),
    cleanupOnFailure: () => undefined,
    takeCleanupOnExit: () => null,
    materializeManagedEndpoint: async () => {
      throw new Error('not reached');
    },
  };
}

describe('prepareDaemonManagedProviderBinding runtime surface', () => {
  it('prepares a session wrapper for only the selected protocol and disables model listing', async () => {
    const captured: ManagedProviderRuntimeAdapterInput[] = [];
    const attempt = managedAttempt(async (input) => {
      captured.push(input);
      throw new Error('stop after observing adapter input');
    });
    const materializationBaseDir = await mkdtemp(
      join(tmpdir(), 'happier-managed-session-surface-'),
    );
    try {
      await expect(prepareDaemonManagedProviderBinding({
        attempt,
        context: {
          pluginId: 'happier.provider.cliproxyapi',
          contributionId: 'cliproxyapi',
          operationId: 'spawn-operation-a',
          title: 'CLIProxyAPI',
        },
        materializationBaseDir,
        requestAuthHttpPort: 18_765,
        managedLocalServicesEnabled: true,
        localServices: {
          startOwned: vi.fn(),
          readOwnedRun: vi.fn(),
          registerOwnedCleanup: vi.fn(() => true),
          stopOwned: vi.fn(),
        },
        exec: { spawn: vi.fn() },
        requestAuthRegistry: {
          activate: vi.fn(),
          retire: vi.fn(),
        },
        validateRequestAuth: vi.fn(),
        launchResourceScope: createProviderLaunchResourceScope(),
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'provider_materialization_failed' },
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        protocols: ['openai-responses'],
        modelListEnabled: false,
      });
    } finally {
      await rm(materializationBaseDir, { recursive: true, force: true });
    }
  });
});
