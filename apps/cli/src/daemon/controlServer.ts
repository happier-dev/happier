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
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { TrackedSession } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

function safeTokenEquals(provided: string, expected: string): boolean {
  const hashA = createHash('sha256').update(provided).digest();
  const hashB = createHash('sha256').update(expected).digest();
  return timingSafeEqual(hashA, hashB);
}

function isCatalogAgentId(value: unknown): value is CatalogAgentId {
  return typeof value === 'string' && (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

export function createDaemonControlApp({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  controlToken,
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
}): FastifyInstance {
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
      body: z.object({
        directory: z.string(),
        sessionId: z.string().optional(),
        agent: z.enum(['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'pi']).optional(),
        terminal: z.object({
          mode: z.enum(['plain', 'tmux']).optional(),
          tmux: z.object({
            sessionName: z.string().optional(),
            isolated: z.boolean().optional(),
            tmpDir: z.union([z.string(), z.null()]).optional(),
          }).optional(),
        }).optional(),
        environmentVariables: z.record(z.string()).optional(),
      }),
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
    const { directory, sessionId, agent: rawAgent, terminal, environmentVariables } = request.body;
    const agent = isCatalogAgentId(rawAgent) ? rawAgent : undefined;

    logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
    const result = await spawnSession({ directory, sessionId, agent, terminal, environmentVariables });

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

  // Stop daemon
  typed.post('/stop', {
    schema: {
      response: {
        200: z.object({
          status: z.string()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    logger.debug('[CONTROL SERVER] Stop daemon request received');

    // Give time for response to arrive
    setTimeout(() => {
      logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
      requestShutdown();
    }, 50);

    return { status: 'stopping' };
  });

  return app;
}

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  controlToken,
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => void;
  controlToken: string;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = createDaemonControlApp({
      getChildren,
      stopSession,
      spawnSession,
      requestShutdown,
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
