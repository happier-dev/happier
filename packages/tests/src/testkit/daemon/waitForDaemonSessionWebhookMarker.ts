import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { waitFor } from '../timing';

type DaemonSessionMarkerLike = Readonly<{
  happySessionId?: unknown;
  metadata?: Readonly<{
    machineId?: unknown;
    lifecycleState?: unknown;
  }> | null;
}>;

export async function waitForDaemonSessionWebhookMarker(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  machineId: string;
  timeoutMs?: number;
  intervalMs?: number;
}>): Promise<void> {
  const markerDir = join(params.happyHomeDir, 'tmp', 'daemon-sessions');
  await waitFor(async () => {
    let entries: string[] = [];
    try {
      entries = await readdir(markerDir);
    } catch {
      return false;
    }

    for (const name of entries) {
      if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;

      let parsed: DaemonSessionMarkerLike | null = null;
      try {
        parsed = JSON.parse(await readFile(join(markerDir, name), 'utf8')) as DaemonSessionMarkerLike;
      } catch {
        continue;
      }

      const sessionId = typeof parsed.happySessionId === 'string' ? parsed.happySessionId.trim() : '';
      const machineId = typeof parsed.metadata?.machineId === 'string' ? parsed.metadata.machineId.trim() : '';
      const lifecycleState = typeof parsed.metadata?.lifecycleState === 'string' ? parsed.metadata.lifecycleState.trim() : '';
      if (sessionId !== params.sessionId || machineId !== params.machineId) continue;
      if (lifecycleState.length === 0 || lifecycleState === 'running') {
        return true;
      }
    }

    return false;
  }, {
    timeoutMs: params.timeoutMs ?? 30_000,
    intervalMs: params.intervalMs ?? 100,
    context: `daemon session webhook marker for ${params.sessionId}`,
  });
}
