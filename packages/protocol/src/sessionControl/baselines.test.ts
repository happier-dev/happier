import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as protocol from '../index.js';

type EnvelopeSchema = Readonly<{ safeParse: (value: unknown) => { success: boolean; error?: unknown } }>;

const schemasByKind: Record<string, EnvelopeSchema> = {
  auth_status: (protocol as any).AuthStatusEnvelopeSchema,
  server_list: (protocol as any).ServerListEnvelopeSchema,
  server_current: (protocol as any).ServerCurrentEnvelopeSchema,
  server_add: (protocol as any).ServerAddEnvelopeSchema,
  server_use: (protocol as any).ServerUseEnvelopeSchema,
  server_remove: (protocol as any).ServerRemoveEnvelopeSchema,
  server_test: (protocol as any).ServerTestEnvelopeSchema,
  server_set: (protocol as any).ServerSetEnvelopeSchema,
  session_list: (protocol as any).SessionListEnvelopeSchema,
  session_actions_list: (protocol as any).SessionActionsListEnvelopeSchema,
  session_actions_describe: (protocol as any).SessionActionsDescribeEnvelopeSchema,
  session_status: (protocol as any).SessionStatusEnvelopeSchema,
  session_create: (protocol as any).SessionCreateEnvelopeSchema,
  session_send: (protocol as any).SessionSendEnvelopeSchema,
  session_wait: (protocol as any).SessionWaitEnvelopeSchema,
  session_stop: (protocol as any).SessionStopEnvelopeSchema,
  session_history: (protocol as any).SessionHistoryEnvelopeSchema,
  session_run_start: (protocol as any).SessionRunStartEnvelopeSchema,
  session_run_list: (protocol as any).SessionRunListEnvelopeSchema,
  session_run_get: (protocol as any).SessionRunGetEnvelopeSchema,
  session_run_send: (protocol as any).SessionRunSendEnvelopeSchema,
  session_run_stop: (protocol as any).SessionRunStopEnvelopeSchema,
  session_run_action: (protocol as any).SessionRunActionEnvelopeSchema,
  session_run_wait: (protocol as any).SessionRunWaitEnvelopeSchema,
  session_run_stream_start: (protocol as any).SessionRunStreamStartEnvelopeSchema,
  session_run_stream_read: (protocol as any).SessionRunStreamReadEnvelopeSchema,
  session_run_stream_cancel: (protocol as any).SessionRunStreamCancelEnvelopeSchema,
};

describe('session-control JSON baselines', () => {
  it('validates committed baselines against protocol schemas', async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const baselinesDir = resolve(dir, '../../../tests/baselines/session-control');
    const entries = (await readdir(baselinesDir)).filter((p) => p.endsWith('.json')).sort();
    expect(entries.length).toBeGreaterThan(0);

    for (const filename of entries) {
      const raw = await readFile(resolve(baselinesDir, filename), 'utf8');
      const parsed = JSON.parse(raw) as any;
      expect(parsed?.v).toBe(1);
      expect(typeof parsed?.kind).toBe('string');

      if (parsed?.ok === false) {
        const schema = (protocol as any).SessionControlEnvelopeErrorSchema as EnvelopeSchema;
        const res = schema.safeParse(parsed);
        expect(res.success).toBe(true);
        continue;
      }

      const schema = schemasByKind[String(parsed?.kind ?? '')];
      expect(schema).toBeTruthy();
      const res = schema.safeParse(parsed);
      expect(res.success).toBe(true);
    }
  });
});
