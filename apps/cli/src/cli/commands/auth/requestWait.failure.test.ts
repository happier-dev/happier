import { afterEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import { createHappierJsonExecutorFromTextRunner, runRemoteHomeEnrollmentFlow } from '@happier-dev/cli-common/systemTasks';
import { readRemoteEnrollmentCommandFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { ActionOperationFailureV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { handleAuthCliCommand } from '../auth';
// Load the real lazy command graphs before the per-test lifecycle.
import './request';
import './wait';
import './enrollRemote';
import '@/auth/remoteTerminalEnrollment';

const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_failure_home', revision: 1,
  canonicalServerUrl: 'https://failure-home.example.test',
  endpoints: [{ kind: 'https' as const, url: 'https://failure-home.example.test' }] };
const homeTarget = { kind: 'descriptor' as const, descriptor, authority: 'trusted_enrollment' as const };

describe('guest auth failure through CLI and enrollment settlement', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  afterEach(() => { env.restore(); reloadConfiguration(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each((['buffered', 'streaming'] as const).flatMap(processIO =>
    (['features-http', 'request-http', 'tls', 'network', 'request-tls', 'request-network'] as const).map(failure => ({ processIO, failure }))))(
    'retains $failure over $processIO enrollment', async ({ processIO, failure }) => {
      await withTempDir('happier-auth-failure-', async homeDir => {
        env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
        reloadConfiguration();
        // HTTP, native process pipes and exit are the only mocked boundaries.
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
          if (failure === 'tls' || failure === 'network') throw new TypeError('private-url-and-token', {
            cause: Object.assign(new Error('private-certificate-details'), { code: failure === 'tls' ? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' : 'ECONNREFUSED' }),
          });
          return failure === 'features-http' ? new Response('private-response-body', { status: 503 })
            : Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } } });
        }));
        vi.spyOn(axios, 'post').mockRejectedValue(new AxiosError('private-request-body',
          failure === 'request-tls' ? 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' : failure === 'request-network' ? 'ECONNREFUSED' : 'ERR_BAD_RESPONSE', undefined, undefined,
          failure === 'request-tls' || failure === 'request-network' ? undefined
            : { data: { token: 'private-token' }, status: 502, statusText: 'private-status', headers: {}, config: { headers: new AxiosHeaders() } }));
        vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(JSON.stringify(homeTarget)); });
        const chunks: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
          chunks.push(String(chunk)); (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(); return true;
        });
        vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
        await expect(handleAuthCliCommand({ args: ['auth', processIO === 'buffered' ? 'request' : 'enroll-remote',
          ...(processIO === 'buffered' ? ['--json', '--remote-enrollment'] : ['--json-lines']), '--home-target-stdin'],
          rawArgv: [], terminalRuntime: null })).rejects.toThrow('test_exit');
        const envelope = JSON.parse(chunks.join(''));
        const status = failure === 'features-http' ? 503 : failure === 'request-http' ? 502 : undefined;
        expect(envelope.error).toMatchObject(status ? { category: 'http_error', status }
          : { category: failure.endsWith('tls') ? 'tls_error' : 'network_error',
            ...(!failure.startsWith('request-') ? { carrierFailure: { attemptedCarrier: 'https' } } : {}) });
        const result: unknown = await runRemoteHomeEnrollmentFlow({ processIO, homeTargetInput: homeTarget,
          executor: createHappierJsonExecutorFromTextRunner(async (_args, options) => {
            options?.onStdoutChunk?.(chunks.join('')); return { status: 1, stdout: chunks.join(''), stderr: 'private-stderr' };
          }), approvePairingRequest: async () => { throw new Error('Unexpected approval'); },
        }).catch((error: unknown) => error);
        if (!(result instanceof Error) || !('code' in result)) throw result;
        const settled = readRemoteEnrollmentCommandFailure(result.code, result.message);
        expect(settled?.message).toBe(result.message);
        expect(settled?.message).toContain(status ? `HTTP ${status}` : `${processIO === 'streaming' ? 'guestAuthCategory' : 'category'} ${failure.endsWith('tls') ? 'tls_error' : 'network_error'}`);
        expect(ActionOperationFailureV1Schema.parse({ errorCode: settled?.code, error: settled?.message }).error).toBe(result.message);
        expect(JSON.stringify({ envelope, settled })).not.toMatch(/private-|failure-home|srv_failure_home/);
      });
  });
});
