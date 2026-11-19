import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionMessageV1 } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { LlmTaskRunnerChoiceV1Schema } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { ExecutionRunWaitResultSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';

import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { respondTranscriptMessagesQueryRejection } from '@/testkit/transcript/transcriptMessagesRouteContract';
import { reloadConfiguration } from '@/configuration';

import { buildBoundedActivationBrief } from '../agentTransition/buildSessionAgentTransitionActivationBrief';
import { buildReplaySeededSpawnRecipe } from './buildReplaySeededSpawnRecipe';
import { resolveReplaySeedDraft } from './resolveReplaySeedDraft';
import { runReplaySummaryForDialog } from './summary/runReplaySummaryForDialog';

const SESSION_ID = 'sess_empty_source';
const CREDENTIALS = {
  token: 't',
  encryption: null,
};

type SourceMode = 'empty' | 'failed' | 'unreadable' | 'malformed_text' | 'whitespace' | 'dialog';

function respondAccountEncryptionCurrentness(url: URL, res: import('node:http').ServerResponse): boolean {
  if (url.pathname !== '/v1/account/encryption/currentness') return false;
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    mode: 'plain',
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
  }));
  return true;
}

function replayRows(mode: SourceMode): readonly SessionMessageV1[] {
  const contentFor = (text: string): SessionMessageV1['content'] => ({
    t: 'plain',
    v: { role: 'user', content: { type: 'text', text } },
  });
  switch (mode) {
    case 'empty':
    case 'failed':
      return [];
    case 'unreadable':
      return [{ id: 'message-7', seq: 7, createdAt: 7, content: { t: 'plain', v: null } }];
    case 'malformed_text':
      return [{ id: 'message-7', seq: 7, createdAt: 7, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 42 } } } }];
    case 'whitespace':
      return [{ id: 'message-7', seq: 7, createdAt: 7, content: contentFor('   ') }];
    case 'dialog':
      return [{ id: 'message-7', seq: 7, createdAt: 7, content: contentFor('hello there') }];
  }
}

describe('resolveReplaySeedDraft — empty source vs failed retrieval', () => {
  let server: Server | null = null;
  let happyHomeDir = '';
  let sourceMode: SourceMode = 'empty';
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED']);

  beforeEach(async () => {
    sourceMode = 'empty';
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED']);
    happyHomeDir = await createTempDir('happier-cli-replay-empty-source-');
    const session = {
      id: SESSION_ID,
      seq: 7,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'claude', path: '/workspace' }),
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (respondAccountEncryptionCurrentness(url, res)) return;
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${SESSION_ID}/system-records/latest`) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ record: null }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${SESSION_ID}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
        if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
        if (sourceMode === 'failed') {
          res.statusCode = 503;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: replayRows(sourceMode), hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve server address');
    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_HOME_DIR: happyHomeDir,
    });
    reloadConfiguration();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (happyHomeDir) await removeTempDir(happyHomeDir);
    envScope.restore();
    reloadConfiguration();
  });

  async function resolve(maxSeedChars = 4_000) {
    return await resolveReplaySeedDraft({
      credentials: CREDENTIALS,
      cwd: '/workspace',
      source: { kind: 'fork_chain', previousSessionId: SESSION_ID, upToSeqInclusive: 7 },
      strategy: 'recent_messages',
      recentMessagesCount: 8,
      maxSeedChars,
      candidateLimit: 8,
    });
  }

  it('reports a source with no dialog distinctly from a failed retrieval', async () => {
    expect((await resolve()).status).toBe('no_source_dialog');
    sourceMode = 'failed';
    expect((await resolve()).status).toBe('unavailable');
  });

  it('reports an empty dialog with an unreadable transcript row as unavailable', async () => {
    sourceMode = 'unreadable';
    expect((await resolve()).status).toBe('unavailable');
    sourceMode = 'malformed_text';
    expect((await resolve()).status).toBe('unavailable');
  });

  it('reports rows that yield no usable prompt text as an empty source', async () => {
    sourceMode = 'whitespace';
    expect((await resolve()).status).toBe('no_source_dialog');
  });

  it('reports unavailable context when the selected total cannot fit a nonempty source and its reservation', async () => {
    const budgetBelowFrame = 64;
    sourceMode = 'dialog';
    expect((await resolve(budgetBelowFrame)).status).toBe('unavailable');
    expect((await resolve()).status).toBe('seeded');
    sourceMode = 'empty';
    expect((await resolve(budgetBelowFrame)).status).toBe('no_source_dialog');
  });

  it.each(['start', 'terminal'] as const)('projects a %s tool-policy refusal to the Replay spawn result', async phase => {
    sourceMode = 'dialog';
    envScope.patch({ HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: '1' });
    const refusal = 'Native Muse cannot enforce the selected tool filter or policy.';
    const fixtureSecret = 'private-replay-fixture-token';
    const diagnostic = refusal + ' Authorization: Bearer ' + fixtureSecret;
    const identity = { runId: 'summary-run', callId: 'summary-call', sidechainId: 'summary-call' };
    const calls: string[] = [];
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunStart: async (_sessionId, request) => {
        calls.push('start');
        expect(request.permissionMode).toBe('no_tools');
        return phase === 'start' ? { ok: false, errorCode: 'unsupported', error: diagnostic } : identity;
      },
      executionRunWait: async () => {
        calls.push('terminal');
        return ExecutionRunWaitResultSchema.parse({
          ok: true, status: 'failed', result: { run: {
            ...identity, status: 'failed', intent: 'task', permissionMode: 'no_tools',
            backendTarget: { kind: 'builtInAgent', agentId: 'muse' },
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            startedAtMs: 1, finishedAtMs: 2, error: { code: 'unsupported', message: diagnostic },
          } },
        });
      },
    });
    const result = await buildReplaySeededSpawnRecipe({
      credentials: CREDENTIALS,
      cwd: '/workspace',
      source: { sourceSessionId: SESSION_ID, forkPoint: { type: 'seq', upToSeqInclusive: 7 } },
      maxSeedChars: 4_000,
      candidateLimit: 8,
      agentHintAgentId: 'claude',
      summaryRunner: LlmTaskRunnerChoiceV1Schema.parse({
        v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null, modelId: 'default' },
        permissionMode: 'no_tools',
      }),
      deps: { runReplaySummaryForDialog: input => runReplaySummaryForDialog({
        ...input, deps: { executeStart: (request, context) => executor.execute('execution.run.start', request, context) },
      }) },
    });
    expect(calls).toEqual(phase === 'start' ? ['start'] : ['start', 'terminal']);
    expect(result).toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining(refusal),
      errorDetail: { kind: 'launch_error', code: 'unsupported' },
    });
    expect(JSON.stringify(result)).not.toContain(fixtureSecret);
  });

  it('composes the real activation brief as available with no seed for an empty Session', async () => {
    await expect(buildBoundedActivationBrief({
      credentials: CREDENTIALS,
      sessionId: SESSION_ID,
      transcriptHeadSeqInclusive: 7,
      sourceMetadata: { path: '/workspace' },
      departingAgentCurrentView: null,
      sourceAgentId: 'claude',
      targetAgentId: 'codex',
    })).resolves.toEqual({ status: 'available', seed: null });
  });

  it('still carries a seed when the source has dialog', async () => {
    sourceMode = 'dialog';
    const resolved = await resolve();
    expect(resolved.status).toBe('seeded');
    if (resolved.status !== 'seeded') return;
    expect(resolved.seedDraft).toContain('hello there');
    expect(resolved.sourceCutoffSeqInclusive).toBe(7);
  });
});
