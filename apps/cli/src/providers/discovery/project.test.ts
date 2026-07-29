import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import type { NormalizedLocalServiceInventorySnapshot } from '@/daemon/local/services/inventory/scanner';
import { projectProviderDiscoveryCandidates } from './project';

const contributionKey = 'happier.provider.ollama/ollama';

function contribution(): ResolvedProviderContribution {
  return {
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: 'happier.provider.ollama',
    identity: { pluginId: 'happier.provider.ollama', localId: 'ollama' },
    definition: ProviderContributionV1Schema.parse({
      v: 1,
      id: 'ollama',
      name: 'Ollama',
      kind: 'local',
      endpointTemplates: [
        {
          id: 'native', protocol: 'ollama-native',
          localUrlCandidates: ['http://127.0.0.1:11434', 'http://localhost:11434'],
          capabilities: {
            streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported',
          },
        },
        {
          id: 'openai', protocol: 'openai-chat',
          localUrlCandidates: ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1'],
          capabilities: {
            streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported',
          },
        },
      ],
      catalog: {
        source: 'probe', manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' }],
      },
      discovery: {
        v: 1,
        listener: {
          executableBasenames: ['ollama', 'ollama.exe'],
          argvMatch: { mode: 'containsAll', tokens: ['serve'] },
          defaultPorts: [11434],
        },
        availabilityProbe: { endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' },
      },
    }),
  };
}

function snapshot(input: Readonly<{
  host?: string;
  addressKind?: 'loopback' | 'wildcard' | 'lan';
  port?: number;
  command?: string;
  attributed?: boolean;
}> = {}): NormalizedLocalServiceInventorySnapshot {
  const host = input.host ?? '127.0.0.1';
  const attributed = input.attributed !== false;
  return {
    v: 1,
    machineId: 'machine-a',
    generatedAt: 100,
    refreshState: 'idle',
    diagnostics: [],
    entries: [{
      id: 'volatile-inventory-id',
      machineId: 'machine-a',
      address: { kind: input.addressKind ?? 'loopback', host, family: host.includes(':') ? 'ipv6' : 'ipv4' },
      port: input.port ?? 11434,
      protocol: 'tcp',
      detectedAt: 100,
      lastSeenAt: 100,
      state: 'listening',
      source: 'detected',
      ...(attributed ? {
        provenance: {
          process: {
            pid: 42, lineagePids: [42], command: input.command ?? '/usr/local/bin/ollama serve', redacted: true,
          },
        },
      } : {}),
      labels: [],
      confidence: attributed ? 'high' : 'medium',
      processOwnershipConfidence: attributed ? 'medium' : 'low',
      workspaceAssociationConfidence: 'low',
      diagnostics: [],
    }],
  };
}

const registry: ProviderContributionRegistryView = {
  providersByContributionKey: new Map([[contributionKey, contribution()]]),
};

describe('projectProviderDiscoveryCandidates', () => {
  it('matches exact executable basename and literal argv tokens on a custom port', () => {
    expect(projectProviderDiscoveryCandidates({ snapshot: snapshot({ port: 22434 }), registry })).toEqual([{
      v: 1,
      machineId: 'machine-a',
      contributionKey,
      providerName: 'Ollama',
      endpointTemplateId: 'native',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/',
      candidateId: expect.stringMatching(/^discovery-candidate:v1:/u),
      evidence: { kind: 'attributed_listener' },
      ownership: 'adopted',
      connection: { status: 'enable_default' },
    }]);
  });

  it('does not let a default port override contradictory process attribution', () => {
    expect(projectProviderDiscoveryCandidates({
      snapshot: snapshot({ command: '/usr/bin/python -m http.server' }), registry,
    })).toEqual([]);
  });

  it('uses default-port evidence only when process attribution is unavailable', () => {
    expect(projectProviderDiscoveryCandidates({ snapshot: snapshot({ attributed: false }), registry })).toMatchObject([
      { evidence: { kind: 'default_port_hint' }, normalizedEndpointUrl: 'http://127.0.0.1:11434/' },
    ]);
  });

  it('turns wildcard provenance into a validated loopback URL and never exports the wildcard', () => {
    expect(projectProviderDiscoveryCandidates({
      snapshot: snapshot({ host: '0.0.0.0', addressKind: 'wildcard', port: 22434 }), registry,
    })[0]?.normalizedEndpointUrl).toBe('http://127.0.0.1:22434/');
  });

  it('deduplicates dual-stack wildcard listeners into one stable pre-connection identity', () => {
    const first = snapshot({ host: '0.0.0.0', addressKind: 'wildcard', port: 22434 }).entries[0]!;
    const second = {
      ...first,
      id: 'second-volatile-inventory-id',
      address: { kind: 'wildcard' as const, host: '::', family: 'ipv6' as const },
    };
    expect(projectProviderDiscoveryCandidates({
      snapshot: { ...snapshot(), entries: [first, second] }, registry,
    })).toHaveLength(1);
  });

  it('binds the opaque candidate identity to the machine, contribution, endpoint template, and URL', () => {
    const first = projectProviderDiscoveryCandidates({
      snapshot: snapshot({ port: 22434 }), registry,
    })[0];
    const repeated = projectProviderDiscoveryCandidates({
      snapshot: snapshot({ port: 22434 }), registry,
    })[0];
    const changed = projectProviderDiscoveryCandidates({
      snapshot: snapshot({ port: 22435 }), registry,
    })[0];

    expect(first?.candidateId).toBe(repeated?.candidateId);
    expect(first?.candidateId).toMatch(/^discovery-candidate:v1:/u);
    expect(changed?.candidateId).not.toBe(first?.candidateId);
  });

  it('preserves a specifically bound private address', () => {
    expect(projectProviderDiscoveryCandidates({
      snapshot: snapshot({ host: '192.168.1.9', addressKind: 'lan', port: 22434 }), registry,
    })[0]?.normalizedEndpointUrl).toBe('http://192.168.1.9:22434/');
  });

  it('reports owned only while the managed registry exposes the live stop capability for the exact inventory run', () => {
    const owned = projectProviderDiscoveryCandidates({
      snapshot: snapshot(), registry,
      managedServices: [{
        inventoryId: 'volatile-inventory-id', phase: 'running', supportedActions: ['stop_managed'],
      }],
    });
    expect(owned[0]?.ownership).toBe('owned');
    const afterHandleLoss = projectProviderDiscoveryCandidates({
      snapshot: snapshot(), registry,
      managedServices: [{
        inventoryId: 'volatile-inventory-id', phase: 'running', supportedActions: [],
      }],
    });
    expect(afterHandleLoss[0]?.ownership).toBe('adopted');
  });

  it('matches an existing connection only by its resolved endpoint', () => {
    const candidates = projectProviderDiscoveryCandidates({
      snapshot: snapshot({ port: 22434 }),
      registry,
      connections: [{
        connectionId: 'pc_other', contributionKey, role: 'default',
        deployment: { kind: 'external' },
        endpoints: [{ endpointTemplateId: 'native', baseUrl: 'http://127.0.0.1:11434/' }],
      }, {
        connectionId: 'pc_exact', contributionKey, role: 'named',
        deployment: { kind: 'external' },
        endpoints: [{ endpointTemplateId: 'native', baseUrl: 'http://127.0.0.1:22434/' }],
      }],
    });
    expect(candidates[0]?.connection).toEqual({ status: 'matched', connectionId: 'pc_exact' });
  });

  it('requires named creation instead of repointing an existing default', () => {
    const candidates = projectProviderDiscoveryCandidates({
      snapshot: snapshot({ port: 22434 }),
      registry,
      connections: [{
        connectionId: 'pc_default', contributionKey, role: 'default',
        deployment: { kind: 'external' },
        endpoints: [{ endpointTemplateId: 'native', baseUrl: 'http://127.0.0.1:11434/' }],
      }],
    });
    expect(candidates[0]?.connection).toEqual({ status: 'requires_named_connection' });
  });

  it('does not let a managed default occupy the external discovery default slot', () => {
    const candidates = projectProviderDiscoveryCandidates({
      snapshot: snapshot({ port: 22434 }),
      registry,
      connections: [{
        connectionId: 'pc_managed', contributionKey, role: 'default',
        deployment: { kind: 'managedLocal' },
        endpoints: [],
      }],
    });

    expect(candidates[0]?.connection).toEqual({ status: 'enable_default' });
  });
});
