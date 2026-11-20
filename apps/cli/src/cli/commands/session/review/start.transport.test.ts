import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ExternalActionRequestEnvelopeV1Schema, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { reloadConfiguration } from '@/configuration';
import { handleSessionCommand } from '../handleSessionCommand';

const sessionId = 'c123456789012345678901234';
const credentials = {
  token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
  encryption: null,
  credentialProvenance: 'api_token',
} as const;
const reviewRound = { reviewId: 'review-integration', roundOrdinal: 1 };
const selectedRun = { key: 'step-1-reviewer-1', ok: true, result: { runId: 'run-integration' } } as const;

describe('happier session review start (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_ACTIONS_SETTINGS_V1'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let requests: ExternalActionRequestEnvelope[] = [];
  let includeSelectedReceipt = true;
  let boundaryError: unknown;

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-review-start-');
    requests = [];
    includeSelectedReceipt = true;
    boundaryError = undefined;
    // API-token commands use the public Action boundary. The old Session socket
    // imitation predated Review admission and did not model this live transport.
    server = createServer((request, response) => {
      void (async () => {
        expect(request.method).toBe('POST');
        expect(new URL(request.url ?? '/', 'http://fixture.test').pathname).toBe('/v1/actions/review.start');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        requests.push(envelope);
        ReviewStartInputSchema.parse(envelope.input);
        const execution = { ok: true, result: { intent: 'review', sessionId, reviewRound,
          results: includeSelectedReceipt ? [selectedRun] : [] } };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ v: 1, actionId: 'review.start', requestId: envelope.requestId, execution }));
      })().catch(error => {
        boundaryError = error;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture_boundary_failure' }));
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');
    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = process.env.HAPPIER_SERVER_URL;
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    reloadConfiguration();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = null;
    if (happyHomeDir) await removeTempDir(happyHomeDir);
    happyHomeDir = '';
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    reloadConfiguration();
    expect(boundaryError).toBeUndefined();
  });

  async function start(extra: string[] = []) {
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['review', 'start', sessionId, '--engines', 'coderabbit',
        '--instructions', 'Review.', ...extra, '--json'], { readCredentialsFn: async () => credentials });
      return output.json();
    } finally {
      output.restore();
    }
  }

  it('returns the direct Review round and selected Run receipt through the public Action transport', async () => {
    expect(await start()).toMatchObject({ ok: true, kind: 'session_review_start', data: {
      sessionId, reviewRound, results: [selectedRun],
    } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ target: { kind: 'session', sessionId }, input: {
      reviewers: [{ kind: 'engine', engineId: 'coderabbit' }], instructions: 'Review.',
    } });
  });

  it('reports an unknown outcome when the public Action omits the selected Run receipt', async () => {
    includeSelectedReceipt = false;
    expect(await start()).toMatchObject({ ok: false, kind: 'session_review_start', error: { code: 'action_outcome_unknown' } });
    expect(requests).toHaveLength(1);
  });

  it('rejects unknown engine-specific flags before dispatch', async () => {
    expect(await start(['--coderabbit-config', '.coderabbit.yml'])).toMatchObject({
      ok: false, error: { code: 'invalid_arguments' },
    });
    expect(requests).toHaveLength(0);
  });
});
