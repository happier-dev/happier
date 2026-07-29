import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

type PlainTranscriptRow = Readonly<{
  seq: number;
  createdAt: number;
  content: {
    t: 'plain';
    v: unknown;
  };
}>;

function createPlainSessionRow(sessionId: string, seq: number) {
  return {
    id: sessionId,
    seq,
    createdAt: 1,
    updatedAt: 2,
    active: false,
    activeAt: 0,
    archivedAt: null,
    encryptionMode: 'plain',
    metadata: JSON.stringify({ flavor: 'voice', path: '/tmp' }),
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    pendingCount: 0,
    pendingVersion: 0,
    dataEncryptionKey: null,
    share: null,
  };
}

function createVoiceTurnRow(params: Readonly<{
  seq: number;
  createdAt: number;
  role: 'user' | 'agent';
  transcriptText: unknown;
  turnRole: 'user' | 'assistant';
  epoch?: number;
}>): PlainTranscriptRow {
  return {
    seq: params.seq,
    createdAt: params.createdAt,
    content: {
      t: 'plain',
      v: {
        role: params.role,
        content: params.transcriptText,
        meta: {
          happier: {
            kind: 'voice_agent_turn.v1',
            payload: {
              v: 1,
              epoch: params.epoch ?? 7,
              role: params.turnRole,
              voiceAgentId: 'voice-agent-1',
              ts: params.createdAt,
            },
          },
        },
      },
    },
  };
}

function createLegacySynopsisRow(params: Readonly<{
  seq: number;
  synopsis: string;
  updatedAtMs: number;
}>): PlainTranscriptRow {
  return {
    seq: params.seq,
    createdAt: params.updatedAtMs,
    content: {
      t: 'plain',
      v: {
        role: 'agent',
        content: { type: 'text', text: '[memory]' },
        meta: {
          happier: {
            kind: 'session_synopsis.v1',
            payload: {
              v: 1,
              seqTo: params.seq,
              updatedAtMs: params.updatedAtMs,
              synopsis: params.synopsis,
            },
          },
        },
      },
    },
  };
}

describe('hydrateVoiceReplayDialogFromTranscript (integration)', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR']);
    happyHomeDir = await createTempDir('happier-cli-voice-replay-hydrate-');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;

    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
    }
    envScope.restore();

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  async function serveAndHydrate(params: Readonly<{
    sessionId: string;
    rows: readonly PlainTranscriptRow[];
    systemRecordStatus?: number;
    systemRecordSynopsis?: string | null;
    onSystemRecordRequest?: () => void;
  }>) {
    const sessionRow = createPlainSessionRow(params.sessionId, params.rows.length);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${params.sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session: sessionRow }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${params.sessionId}/system-records/latest`) {
        params.onSystemRecordRequest?.();
        res.statusCode = params.systemRecordStatus ?? 200;
        res.setHeader('content-type', 'application/json');
        if (res.statusCode !== 200) {
          res.end(JSON.stringify({ error: 'optional synopsis unavailable' }));
          return;
        }
        res.end(JSON.stringify({
          record: params.systemRecordSynopsis
            ? {
                id: 'rec_voice_synopsis',
                sessionId: params.sessionId,
                namespace: 'memory',
                kind: 'synopsis.v1',
                localId: 'memory:synopsis:v1:voice',
                content: {
                  t: 'plain',
                  v: {
                    v: 1,
                    seqTo: 999,
                    updatedAtMs: 9999,
                    synopsis: params.systemRecordSynopsis,
                  },
                },
                createdAt: '2026-05-19T00:00:00.000Z',
                updatedAt: '2026-05-19T00:00:00.000Z',
              }
            : null,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${params.sessionId}/messages`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: params.rows }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve voice replay hydrate server address');

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const { hydrateVoiceReplayDialogFromTranscript } = await import('./hydrateVoiceReplayDialogFromTranscript');
    return hydrateVoiceReplayDialogFromTranscript({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      previousSessionId: params.sessionId,
      transcriptEpoch: 7,
      limit: 50,
    });
  }

  it('prefers the latest memory synopsis system record over legacy transcript synopsis artifacts', async () => {
    const result = await serveAndHydrate({
      sessionId: 'sess_voice_synopsis_system_record',
      systemRecordSynopsis: 'SYSTEM_RECORD_SYNOPSIS',
      rows: [
        createVoiceTurnRow({
          seq: 1,
          createdAt: 1000,
          role: 'user',
          transcriptText: { type: 'text', text: 'old user turn' },
          turnRole: 'user',
        }),
        createLegacySynopsisRow({
          seq: 2,
          synopsis: 'LEGACY_TRANSCRIPT_SYNOPSIS',
          updatedAtMs: 5000,
        }),
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.synopsisText).toBe('SYSTEM_RECORD_SYNOPSIS');
  });

  it('falls back to transcript synopsis when optional memory synopsis lookup is unauthorized', async () => {
    let systemRecordRequests = 0;

    const result = await serveAndHydrate({
      sessionId: 'sess_voice_synopsis_unauthorized',
      systemRecordStatus: 401,
      onSystemRecordRequest: () => {
        systemRecordRequests += 1;
      },
      rows: [
        createVoiceTurnRow({
          seq: 1,
          createdAt: 1000,
          role: 'user',
          transcriptText: { type: 'text', text: 'old user turn' },
          turnRole: 'user',
        }),
        createLegacySynopsisRow({
          seq: 2,
          synopsis: 'TRANSCRIPT_SYNOPSIS_FALLBACK',
          updatedAtMs: 5000,
        }),
      ],
    });

    expect(systemRecordRequests).toBe(1);
    expect(result).not.toBeNull();
    expect(result?.synopsisText).toBe('TRANSCRIPT_SYNOPSIS_FALLBACK');
  });

  it('hydrates ACP assistant voice turns through the semantic transcript extractor', async () => {
    const result = await serveAndHydrate({
      sessionId: 'sess_voice_acp_assistant',
      systemRecordSynopsis: null,
      rows: [
        createVoiceTurnRow({
          seq: 1,
          createdAt: 1000,
          role: 'agent',
          transcriptText: {
            type: 'acp',
            agentId: 'codex',
            data: {
              type: 'agent_message',
              message: 'ACP assistant voice turn',
            },
          },
          turnRole: 'assistant',
        }),
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.dialog).toEqual([
      {
        role: 'Assistant',
        createdAt: 1000,
        text: 'ACP assistant voice turn',
      },
    ]);
  });
});
