/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { resolveCatalogAgentIdForCliSubcommand } from '@/backends/catalog';
import { TrackedSession } from './types';
import { SPAWN_SESSION_ERROR_CODES, SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { mergeSpawnSessionOptions, SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';

function safeTokenEquals(provided: string, expected: string): boolean {
  const hashA = createHash('sha256').update(provided).digest();
  const hashB = createHash('sha256').update(expected).digest();
  return timingSafeEqual(hashA, hashB);
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
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
}): FastifyInstance {
  void machineId;
  const normalizedControlToken = controlToken.trim();
  if (!normalizedControlToken) {
    throw new Error('Daemon control token is required');
  }

  const app = fastify({
    logger: false // We use our own logger
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
          body: SpawnDaemonSessionRequestSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional()
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
        const { directory, sessionId, existingSessionId } = request.body;

    logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
        let result: SpawnSessionResult;
        try {
          const normalizedExistingSessionId = typeof existingSessionId === 'string' && existingSessionId.trim().length > 0
            ? existingSessionId.trim()
            : undefined;
          result = await spawnSession(
            mergeSpawnSessionOptions(
              request.body,
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
      body: z.object({
        directory: z.string(),
        agent: z.string(),
        approvedNewDirectoryCreation: z.boolean().optional(),
        permissionMode: z.string().optional(),
        permissionModeUpdatedAt: z.number().optional(),
        modelId: z.string().optional(),
        modelUpdatedAt: z.number().optional(),
        replay: z.object({
          previousSessionId: z.string(),
          strategy: z.string().optional(),
          recentMessagesCount: z.number().optional(),
          maxSeedChars: z.number().optional(),
          seedMode: z.string().optional(),
        }),
      }),
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
    const agentId = resolveCatalogAgentIdForCliSubcommand(request.body.agent);
    if (!agentId) {
      reply.code(400);
      return {
        success: false,
        error: 'Unknown agent id',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      };
    }

    let result: SpawnSessionResult;
    try {
      result = await continueSessionWithReplay(
        {
          directory: request.body.directory,
          agentId,
          approvedNewDirectoryCreation: request.body.approvedNewDirectoryCreation,
          permissionMode: request.body.permissionMode,
          permissionModeUpdatedAt: request.body.permissionModeUpdatedAt,
          modelId: request.body.modelId,
          modelUpdatedAt: request.body.modelUpdatedAt,
          replay: request.body.replay,
        },
        { spawnSession },
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
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
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
