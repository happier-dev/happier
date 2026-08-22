import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode/manifest';

import { materializeConfiguredExternalSessionSourceCandidates } from './configuredSourceMaterializer';

function readOpenCodeContribution() {
  const ingested = ingestPluginManifestV2(OPENCODE_PLUGIN_MANIFEST);
  if (!ingested.ok) throw new Error('OpenCode plugin manifest must be valid');
  const contribution = ingested.manifest.contributes.agents.find(
    (candidate) => candidate.id === 'opencode',
  );
  if (!contribution) throw new Error('OpenCode plugin manifest must declare its Agent contribution');
  return contribution;
}

describe('OpenCode configured external-session source materialization', () => {
  it('marks the declared default as host-managed before provider operations bind', () => {
    const contribution = readOpenCodeContribution();

    const candidates = materializeConfiguredExternalSessionSourceCandidates({
      agents: [{
        id: 'opencode',
        richDefinition: {
          provenance: 'first_party',
          definition: contribution,
        },
      }],
      account: { connectedServicesV2: [] },
    });

    expect(candidates).toEqual([{
      agentId: 'opencode',
      source: {
        kind: 'opencodeServer',
        managedEndpoint: true,
      },
    }]);
  });

  it('admits the user-configured server as an attach source bound to the active server', () => {
    const contribution = readOpenCodeContribution();
    const materialize = (agentSettings: Readonly<Record<string, unknown>>) =>
      materializeConfiguredExternalSessionSourceCandidates({
        agents: [{
          id: 'opencode',
          richDefinition: { provenance: 'first_party', definition: contribution },
        }],
        account: { connectedServicesV2: [] },
        agentSettings,
        activeServerId: 'cloud',
      });
    const managed = {
      agentId: 'opencode',
      source: { kind: 'opencodeServer', managedEndpoint: true },
    };

    // An admitted server URL REPLACES the managed default. Every configured
    // source becomes a supervised attach target, so leaving the default in place
    // makes Happier start and health-check its own `opencode serve` alongside the
    // server the operator explicitly named.
    expect(materialize({
      opencodeServerBaseUrl: 'http://127.0.0.1:9999',
      opencodeServerBaseUrlByServerIdV1: { cloud: 'http://127.0.0.1:4096' },
    })).toEqual([
      { agentId: 'opencode', source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' } },
    ]);
    expect(materialize({ opencodeServerBaseUrlByServerIdV1: { other: 'http://127.0.0.1:4096' } })).toEqual([managed]);
    // Plain HTTP is loopback-only; an off-box endpoint stays inert and cannot
    // replace the declaration's ordinary managed source.
    expect(materialize({ opencodeServerBaseUrl: 'http://10.0.0.7:4096' })).toEqual([
      managed,
    ]);
    // HTTPS is transport-authenticated and may address the user's remote host.
    expect(materialize({ opencodeServerBaseUrl: 'https://10.0.0.7:4096' })).toEqual([
      { agentId: 'opencode', source: { kind: 'opencodeServer', baseUrl: 'https://10.0.0.7:4096/' } },
    ]);
    // A reverse-proxy prefix is routing authority. Query and fragment are not:
    // the managed-service owner later binds any password to the endpoint origin.
    expect(materialize({
      opencodeServerBaseUrl: 'https://opencode.example.test/reverse/proxy?ignored=1#ignored',
    })).toEqual([
      {
        agentId: 'opencode',
        source: { kind: 'opencodeServer', baseUrl: 'https://opencode.example.test/reverse/proxy' },
      },
    ]);
    // A credential in the URL still materializes nothing: the password belongs
    // in its own setting and travels as a header.
    expect(materialize({ opencodeServerBaseUrl: 'http://user:secret@127.0.0.1:4096' })).toEqual([managed]);
    expect(materialize({ opencodeServerBaseUrl: 'https://opencode:secret@example.com' })).toEqual([managed]);
  });
});
