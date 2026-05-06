/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession } from './types';
import { SPAWN_SESSION_ERROR_CODES, SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { mergeSpawnSessionOptions, SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { parseSessionContinueWithReplayRpcParamsCompatIngress } from '@happier-dev/protocol';
import {
  SshTunnelEnsureRequestSchema,
  SshTunnelProbeRequestSchema,
  SshTunnelReleaseRequestSchema,
  SshTunnelStopRequestSchema,
} from '@happier-dev/protocol';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { toSshTunnelErrorResponse, type SshTunnelSupervisor } from '@/daemon/ssh/tunnels';

const DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY = 'HAPPIER_DAEMON_CONTROL_BODY_LIMIT_BYTES';

function safeTokenEquals(provided: string, expected: string): boolean {
  const hashA = createHash('sha256').update(provided).digest();
  const hashB = createHash('sha256').update(expected).digest();
  return timingSafeEqual(hashA, hashB);
}

function resolveDaemonControlBodyLimitBytes(): number {
  const raw = String(process.env[DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY] ?? '').trim();
  if (!raw) return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;
  }

  return Math.max(1024 * 1024, Math.min(parsed, 64 * 1024 * 1024));
}

function sendBadRequest(reply: FastifyReply, body: Readonly<{
  success: false;
  error: string;
  errorCode?: string;
}>): void {
  void reply.code(400).send(body);
}

export function createDaemonControlApp({
  getChildren,
  machineId,
  stopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  onHappySessionWebhook,
  controlToken,
  sshTunnels,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
  sshTunnels?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
}): FastifyInstance {
  void machineId;
  const normalizedControlToken = controlToken.trim();
  if (!normalizedControlToken) {
    throw new Error('Daemon control token is required');
  }

  const app = fastify({
    logger: false, // We use our own logger
    bodyLimit: resolveDaemonControlBodyLimitBytes(),
  });

  // Set up Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();

  const authSchema401 = z.object({
    success: z.literal(false),
    error: z.string(),
  });

  const requireAuth = async (request: { headers: Record<string, unknown> }, reply: any): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (!provided || !safeTokenEquals(provided, normalizedControlToken)) {
      reply.code(401);
      return reply.send({ success: false as const, error: 'Unauthorized' });
    }
  };

  typed.post('/ping', {
    schema: {
      response: {
        200: z.object({ status: z.literal('ok') }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    return { status: 'ok' as const };
  });

  // Session reports itself after creation
  typed.post('/session-started', {
    schema: {
      body: z.object({
        sessionId: z.string(),
        metadata: z.any() // Metadata type from API
      }),
      response: {
        200: z.object({
          status: z.literal('ok')
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId, metadata } = request.body;

    logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
    onHappySessionWebhook(sessionId, metadata);

    return { status: 'ok' as const };
  });

  // List all tracked sessions
  typed.post('/list', {
    schema: {
      response: {
        200: z.object({
          children: z.array(z.object({
            startedBy: z.string(),
            happySessionId: z.string(),
            pid: z.number()
          }))
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    const children = getChildren();
    logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
    return { 
      children: children
        .filter(child => child.happySessionId !== undefined)
        .map(child => ({
          startedBy: child.startedBy,
          happySessionId: child.happySessionId!,
          pid: child.pid
        }))
    }
  });

  typed.post('/ssh-tunnels/ensure', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelEnsureRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      return { ok: true as const, lease: await sshTunnels.ensureTunnel(parsed.data) };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  typed.post('/ssh-tunnels/list', {
    schema: {
      response: {
        200: z.unknown(),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (_request, reply) => {
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    return { ok: true as const, tunnels: await sshTunnels.listTunnels() };
  });

  typed.post('/ssh-tunnels/probe', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelProbeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      return { ok: true as const, health: await sshTunnels.probeTunnel(parsed.data.tunnelKey) };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  typed.post('/ssh-tunnels/release', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelReleaseRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      await sshTunnels.releaseTunnel(parsed.data.leaseId);
      return { ok: true as const };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  typed.post('/ssh-tunnels/stop', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.unknown(),
        400: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
        401: authSchema401,
        503: z.object({ ok: z.literal(false), errorCode: z.string(), error: z.string() }).passthrough(),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!sshTunnels) {
      reply.code(503);
      return { ok: false as const, errorCode: 'ssh_tunnel_unavailable', error: 'ssh_tunnel_unavailable' };
    }
    const parsed = SshTunnelStopRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false as const, errorCode: 'ssh_tunnel_invalid_request', error: 'ssh_tunnel_invalid_request' };
    }
    try {
      await sshTunnels.stopTunnel(parsed.data.tunnelKey);
      return { ok: true as const };
    } catch (error) {
      const response = toSshTunnelErrorResponse(error);
      if (response) {
        reply.code(503);
        return response;
      }
      throw error;
    }
  });

  // Stop specific session
  typed.post('/stop-session', {
    schema: {
      body: z.object({
        sessionId: z.string()
      }),
      response: {
        200: z.object({
          success: z.boolean()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId } = request.body;

    logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
    const success = await stopSession(sessionId);
    return { success };
  });

  // Spawn new session
      typed.post('/spawn-session', {
        schema: {
          body: z.unknown(),
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional()
        }),
        400: z.object({
          success: z.boolean(),
          error: z.string(),
          errorCode: z.string().optional(),
        }),
        401: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional()
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
        })
      }
    },
    preHandler: requireAuth,
      }, async (request, reply) => {
        const parsedRequest = SpawnDaemonSessionRequestSchema.safeParse(request.body);
        if (!parsedRequest.success) {
          sendBadRequest(reply, {
            success: false,
            error: 'Invalid params',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          });
          return;
        }

        const requestBody = parsedRequest.data;
        const { directory, sessionId, existingSessionId } = requestBody;

    logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
        let result: SpawnSessionResult;
        try {
          const normalizedExistingSessionId = typeof existingSessionId === 'string' && existingSessionId.trim().length > 0
            ? existingSessionId.trim()
            : undefined;
          result = await spawnSession(
            mergeSpawnSessionOptions(
              requestBody,
              normalizedExistingSessionId ? { existingSessionId: normalizedExistingSessionId } : {},
              normalizedExistingSessionId ? { omit: ['sessionId'] } : {},
            ) as SpawnSessionOptions,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reply.code(500);
          return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      };
    }

    switch (result.type) {
      case 'success':
        // Check if sessionId exists, if not return error
        if (!result.sessionId) {
          reply.code(500);
          return {
            success: false,
            error: 'Failed to spawn session: no session ID returned'
          };
        }
        return {
          success: true,
          sessionId: result.sessionId,
          approvedNewDirectoryCreation: true
        };
      
      case 'requestToApproveDirectoryCreation':
        reply.code(409); // Conflict - user input needed
        return { 
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory
        };
      
      case 'error':
        reply.code(500);
        return { 
          success: false,
          error: result.errorMessage,
          errorCode: result.errorCode,
        };
    }
  });

  typed.post('/continue-with-replay', {
    schema: {
      body: z.unknown(),
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional(),
        }),
        400: z.object({
          success: z.boolean(),
          error: z.string(),
          errorCode: z.string().optional(),
        }),
        401: authSchema401,
        403: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional(),
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const parsedRequest = parseSessionContinueWithReplayRpcParamsCompatIngress(request.body);
    if (!parsedRequest.success) {
      sendBadRequest(reply, {
        success: false,
        error: 'Invalid params',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      });
      return;
    }
    const requestBody = parsedRequest.data;

    const resolvedBackend = getSessionHostBridge().resolveContinueWithReplayBackendTarget({
      backendTarget: requestBody.backendTarget,
    });
    if (!resolvedBackend.ok) {
      sendBadRequest(reply, {
        success: false,
        error: resolvedBackend.errorMessage,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      });
      return;
    }

    let result: SpawnSessionResult;
    try {
      result = await continueSessionWithReplay(
        {
          directory: requestBody.directory,
          backendTarget: resolvedBackend.backendTargetV2,
          approvedNewDirectoryCreation: requestBody.approvedNewDirectoryCreation,
          permissionMode: requestBody.permissionMode,
          permissionModeUpdatedAt: requestBody.permissionModeUpdatedAt,
          modelId: requestBody.modelId,
          modelUpdatedAt: requestBody.modelUpdatedAt,
          replay: requestBody.replay,
        },
        { spawnSession },
      );
    } catch (error) {
      const authStatus = readAuthenticationStatus(error);
      if (authStatus) {
        reply.code(authStatus);
        return {
          success: false,
          error: 'not_authenticated',
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      reply.code(500);
      return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      };
    }

    switch (result.type) {
      case 'success':
        if (!result.sessionId) {
          reply.code(500);
          return { success: false, error: 'Failed to spawn session: no session ID returned' };
        }
        return { success: true, sessionId: result.sessionId, approvedNewDirectoryCreation: true };
      case 'requestToApproveDirectoryCreation':
        reply.code(409);
        return {
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory,
        };
      case 'error':
        reply.code(result.errorCode === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST ? 400 : 500);
        return { success: false, error: result.errorMessage, errorCode: result.errorCode };
    }
  });

  // Stop daemon
  typed.post('/stop', {
    schema: {
      body: z
        .object({
          stopSessions: z.boolean().optional(),
        })
        .nullish(),
      response: {
        200: z.object({
          status: z.string()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const stopSessions = request.body?.stopSessions === true;
    logger.debug('[CONTROL SERVER] Stop daemon request received', { stopSessions });

    // Give time for response to arrive
    setTimeout(() => {
      logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
      const runBeforeShutdown = async (): Promise<void> => {
        if (!beforeShutdown) return;
        try {
          await beforeShutdown();
        } catch (error) {
          logger.debug('[CONTROL SERVER] beforeShutdown hook failed (best-effort)', error);
        }
      };

      void (async () => {
        try {
          if (stopSessions) {
            const children = getChildren();
            logger.debug(`[CONTROL SERVER] stopSessions requested: stopping ${children.length} tracked sessions`);
            for (const child of children) {
              const sessionId = typeof child.happySessionId === 'string' ? child.happySessionId.trim() : '';
              const fallbackSessionId =
                Number.isFinite(child.pid) && child.pid > 1 ? `PID-${Math.trunc(child.pid)}` : '';
              const id = sessionId || fallbackSessionId;
              if (!id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await stopSession(id);
              } catch (error) {
                logger.debug(`[CONTROL SERVER] Failed to stop session ${id}`, error);
              }
            }
          }
          await runBeforeShutdown();
        } catch (error) {
          logger.debug('[CONTROL SERVER] stopSessions failed', error);
        } finally {
          requestShutdown();
        }
      })();
    }, 50);

    return { status: 'stopping' };
  });

  return app;
}

export function startDaemonControlServer({
  getChildren,
  machineId,
  stopSession,
  spawnSession,
  requestShutdown,
  beforeShutdown,
  onHappySessionWebhook,
  controlToken,
  sshTunnels,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
  sshTunnels?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = createDaemonControlApp({
      getChildren,
      machineId,
      stopSession,
      spawnSession,
      requestShutdown,
      beforeShutdown,
      onHappySessionWebhook,
      controlToken,
      sshTunnels,
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
