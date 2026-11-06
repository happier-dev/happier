import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StopSessionRequestSource } from '@happier-dev/protocol';

import { configuration } from '@/configuration';

export type TerminalHostKillAuditRecord = Readonly<{
  actor: string;
  reason: string;
  sessionId: string | null;
  runnerPid: number | null;
  zellijName: string | null;
  signal: string;
  callSite: string;
  observedAt?: number;
  requestSource?: StopSessionRequestSource | null;
  requestTransport?: string;
}>;

export function recordTerminalHostKillAudit(record: TerminalHostKillAuditRecord): void {
  const dir = join(configuration.logsDir, 'terminal-host-kill-audit');
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, 'audit.jsonl'),
    `${JSON.stringify({
      ...record,
      observedAt: record.observedAt ?? Date.now(),
    })}\n`,
    'utf8',
  );
}
