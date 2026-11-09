import { describe, expect, it } from 'vitest';
import { CANONICAL_AGENTS_CORE } from '@happier-dev/agents';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Muse selected-Agent admission', () => {
  it('admits the authored Muse manifest with its network disclosure through the canonical manifest boundary', () => {
    const ingestion = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(ingestion.ok, JSON.stringify(ingestion)).toBe(true);
    if (!ingestion.ok) throw new Error('Muse manifest admission failed');
    expect(ingestion.manifest.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'muse-account-network', capability: 'network',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://auth.meta.com' },
        { kind: 'fixedOrigin', origin: 'https://api.meta.ai' },
      ], methods: ['POST'] },
    }));
  });
  it('offers Muse with a reachable custom Session runtime in the host catalog', () => {
    const muse = Object.values(CANONICAL_AGENTS_CORE).find(agent => agent.id === 'muse');
    expect(muse, 'selected Muse must exist before the host can admit a Session').toBeDefined();
    expect(muse?.id).toBe('muse');
  });
});
