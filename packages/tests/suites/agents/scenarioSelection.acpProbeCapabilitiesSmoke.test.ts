import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';
import { resolveScenariosForProvider } from '../../src/testkit/providers/harness';

describe('providers: scenario selection', () => {
  it('allows acp_probe_capabilities to be referenced from smoke tier', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const qwen = providers.find((p) => p.id === 'qwen');
    expect(qwen).toBeTruthy();
    if (!qwen) return;

    const scenarios = resolveScenariosForProvider({ provider: qwen, tier: 'smoke' });
    expect(scenarios.map((s) => s.id)).toContain('acp_probe_capabilities');
  });
});

