import { describe, expect, it } from 'vitest';

import { createCapabilitiesService } from '@/capabilities/service';
import { capabilities } from './extraCapabilities';

/** The capability id released 0.2.21 clients detect and prewarm for every Agy new session. */
const RETIRED_DEP_ID = 'dep.agy-acp-server';

describe('retired Agy ACP server capability', () => {
  const service = createCapabilitiesService({ capabilities: [...capabilities], checklists: {} as never, buildContext: async () => ({}) as never });

  it('tells released clients there is nothing to install, without any download', async () => {
    const detected = await service.detect({ requests: [{ id: RETIRED_DEP_ID }] });
    expect(detected.results[RETIRED_DEP_ID]).toMatchObject({ ok: true, data: { installed: true } });
    expect((detected.results[RETIRED_DEP_ID] as { data: Record<string, unknown> }).data).not.toHaveProperty('latestVersionCheck');
    for (const method of ['install', 'upgrade']) {
      await expect(service.invoke({ id: RETIRED_DEP_ID, method })).resolves.toMatchObject({ ok: true });
    }
  });
});
