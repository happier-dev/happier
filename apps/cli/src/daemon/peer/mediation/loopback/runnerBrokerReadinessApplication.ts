import fastify, { type FastifyInstance } from 'fastify';
import axios from 'axios';
import { doesRunnerBrokerReadinessResponseMatchRequestV1, RunnerBrokerReadinessResponseV1Schema } from '@happier-dev/protocol/teams/credentials/readinessV1';
import { RunnerBrokerReadinessRequestV1Schema } from '@happier-dev/protocol/ephemeralRunner/brokerReadinessRequestV1';
import type { RunnerBrokerReadinessRequestV1, RunnerBrokerReadinessResponseV1 } from '@happier-dev/protocol/teams';

const RUNNER_BROKER_READINESS_BODY_LIMIT_BYTES = 64 * 1024;

export type RunnerBrokerReadinessAuthorizer = (
  request: RunnerBrokerReadinessRequestV1,
  signal: AbortSignal,
) => Promise<RunnerBrokerReadinessResponseV1>;

export type RunnerBrokerReadinessLocalCurrentnessCheck = (
  input: Readonly<{
    selection: RunnerBrokerReadinessResponseV1['credentialSelectionBinding'];
    modelId: RunnerBrokerReadinessRequestV1['modelId'];
  }>,
  signal: AbortSignal,
) => Promise<'available' | 'source_unavailable' | 'update_required'>;

export function registerRunnerBrokerReadinessApplication(
  app: FastifyInstance,
  dependencies: Readonly<{
    authorize: RunnerBrokerReadinessAuthorizer;
    checkLocalCurrentness?: RunnerBrokerReadinessLocalCurrentnessCheck;
  }>,
): void {
  app.post('/readiness', async (request, reply) => {
    const parsed = RunnerBrokerReadinessRequestV1Schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send();
    const abort = new AbortController();
    const onClose = () => abort.abort(new Error('runner_broker_readiness_client_closed'));
    request.raw.once('aborted', onClose);
    if (request.raw.aborted) onClose();
    try {
      let response = RunnerBrokerReadinessResponseV1Schema.parse(
        await dependencies.authorize(parsed.data, abort.signal),
      );
      abort.signal.throwIfAborted();
      if (!doesRunnerBrokerReadinessResponseMatchRequestV1(parsed.data, response)) {
        return reply.code(403).send();
      }
      if (response.readiness.kind === 'available' && dependencies.checkLocalCurrentness) {
        const currentness = await dependencies.checkLocalCurrentness(
          {
            selection: response.credentialSelectionBinding,
            modelId: parsed.data.modelId,
          },
          abort.signal,
        );
        if (currentness !== 'available') response = { ...response, readiness: { kind: currentness } };
      }
      abort.signal.throwIfAborted();
      return reply.code(200).send(response);
    } catch (error) {
      const homeStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
      const status = homeStatus !== undefined
        && homeStatus >= 400
        && homeStatus < 500
        && homeStatus !== 429
        ? 403
        : 503;
      return reply.code(status).send();
    } finally {
      request.raw.off('aborted', onClose);
    }
  });
}

export function createRunnerBrokerReadinessApplicationLifecycle(input: Readonly<{
  authorize: RunnerBrokerReadinessAuthorizer;
  checkLocalCurrentness?: RunnerBrokerReadinessLocalCurrentnessCheck;
}>): Readonly<{ ensureListening(): Promise<number>; stop(): Promise<void> }> {
  let app: FastifyInstance | null = null;
  let listening: Promise<number> | null = null;
  return Object.freeze({
    ensureListening: async () => {
      if (listening) return await listening;
      const next = fastify({ logger: false, bodyLimit: RUNNER_BROKER_READINESS_BODY_LIMIT_BYTES });
      registerRunnerBrokerReadinessApplication(next, input);
      app = next;
      listening = next.listen({ host: '127.0.0.1', port: 0 }).then(() => {
        const address = next.server.address();
        if (!address || typeof address === 'string') throw new Error('runner_broker_readiness_listen_failed');
        return address.port;
      });
      try {
        return await listening;
      } catch (error) {
        listening = null;
        app = null;
        await next.close().catch(() => undefined);
        throw error;
      }
    },
    stop: async () => {
      const active = app;
      app = null;
      listening = null;
      await active?.close();
    },
  });
}
