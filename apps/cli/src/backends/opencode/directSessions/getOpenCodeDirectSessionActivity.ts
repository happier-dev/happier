import type { DirectSessionsSource } from '@happier-dev/protocol';

import { withOpenCodeDirectClient } from './createOpenCodeDirectClient';
import { isOpenCodeSessionBusy } from './isOpenCodeSessionBusy';
import { parseOpenCodeSessionCandidate } from './parseOpenCodeSessionCandidate';

export async function getOpenCodeDirectSessionActivity(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
}>): Promise<Readonly<{ isBusy: boolean; lastActivityAtMs: number | null }>> {
  return await withOpenCodeDirectClient(params.source, async (client) => {
    const statuses = await client.sessionStatusList().catch(() => ({}));
    const rec = statuses && typeof statuses === 'object' && !Array.isArray(statuses)
      ? (statuses as Record<string, unknown>)[params.remoteSessionId]
      : null;
    const isBusy = isOpenCodeSessionBusy(rec);

    const sessions = await client.sessionList().catch(() => []);
    let lastActivityAtMs: number | null = null;
    for (const raw of sessions) {
      const candidate = parseOpenCodeSessionCandidate(raw);
      if (!candidate) continue;
      if (candidate.remoteSessionId !== params.remoteSessionId) continue;
      const updatedAtMs = Number.isFinite(candidate.updatedAtMs) ? Math.trunc(candidate.updatedAtMs) : null;
      lastActivityAtMs = updatedAtMs != null && updatedAtMs > 0 ? updatedAtMs : null;
      break;
    }

    return { isBusy, lastActivityAtMs };
  });
}
