import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('scenarioCatalog: kimi read_known_file auto-approve', () => {
  it('enables yolo auto-approve for execute fallback reads', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const kimi = providers.find((provider) => provider.id === 'kimi');
    expect(kimi).toBeTruthy();
    if (!kimi) throw new Error('Missing provider spec for kimi');

    const scenario = scenarioCatalog.read_known_file(kimi);
    expect(scenario.yolo).toBe(true);
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
  });
});
