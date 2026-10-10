import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NpmRegistryProfileIdV1Schema } from '@happier-dev/protocol/rpc/npmRegistryProfiles';
import { ExpectedMarketplaceListingV1Schema } from '@happier-dev/protocol/marketplace/internal';
import { PluginUpdatePolicyV1Schema } from '@happier-dev/protocol/marketplace/pluginUpdatePolicyV1';
import { WorkflowRunStartedByV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { ManagedResourceDispositionV1Schema } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import type { PluginActionExecutionAttempt } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import type { CurrentDaemonPluginCatalogSnapshot } from './currentCatalog';
import type { DaemonPluginCatalogProjection } from './catalogProjection';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { DaemonPluginChangeService } from './changeService';
import type { DaemonPluginDevelopmentControlRequest } from './developmentRoots';

export const PLUGIN_CHANGE_REQUEST_PATH = '/plugins/change/request';
export const PLUGIN_CHANGE_DECISION_PATH = '/plugins/change/decide';
export const PLUGIN_CHANGE_STATUS_PATH = '/plugins/change/status';
export const PLUGIN_CHANGE_LIST_PATH = '/plugins/change/list';
export const PLUGIN_ACTION_EXECUTE_PATH = '/plugins/actions/execute';
export const PLUGIN_CATALOG_READ_PATH = '/plugins/catalog/read';
export const PLUGIN_DEVELOPMENT_CONTROL_PATH = '/plugins/development/control';

const NonEmptyStringSchema = z.string().trim().min(1).max(32_768);
const PluginIdSchema = z.string().trim().min(1).max(256);
const PluginRuntimeOccurrenceIdSchema = z.string().trim().min(1).max(512);
const ArchiveSha256IntegritySchema = z.string().trim().regex(/^sha256-[A-Za-z0-9+/]{43}=$/u);

const PluginChangeRequestSchema = z.union([
  z.object({
    kind: z.literal('installPath'),
    locator: NonEmptyStringSchema,
    development: z.literal(false).optional(),
  }).strict(),
  z.object({
    kind: z.literal('installArchive'),
    locator: NonEmptyStringSchema,
    expectedIntegrity: ArchiveSha256IntegritySchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('installNpm'),
    packageName: NonEmptyStringSchema,
    selector: NonEmptyStringSchema.optional(),
    registryOrigin: NonEmptyStringSchema.optional(),
    registryProfileId: NpmRegistryProfileIdV1Schema.optional(),
    expectedMarketplaceListing: ExpectedMarketplaceListingV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('update'),
    pluginId: PluginIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('setUpdatePolicy'),
    pluginId: PluginIdSchema,
    policy: PluginUpdatePolicyV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('development'),
    pluginId: PluginIdSchema.optional(),
    sourceRootPath: NonEmptyStringSchema,
    changedPaths: z.array(NonEmptyStringSchema).max(4_096).optional(),
    sdkRegistryOrigin: NonEmptyStringSchema.optional(),
  }).strict(),
  ...([
    'enable',
    'rollback',
    'forgetTrust',
  ] as const).map((kind) => (
    z.object({ kind: z.literal(kind), pluginId: PluginIdSchema }).strict()
  )),
  ...(['disable', 'uninstall', 'uninstallAndDeleteData'] as const).map((kind) => (
    z.object({ kind: z.literal(kind), pluginId: PluginIdSchema,
      managedResourceDispositions: z.array(ManagedResourceDispositionV1Schema).optional() }).strict()
  )),
]);

/**
 * The route authenticates the caller and the change service resolves the
 * pending change this answers, so the request carries no caller-described
 * actor, interaction id, or approval timestamp. Keeping every member strict
 * means such a field is rejected here rather than silently ignored.
 */
const PluginChangeDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    pendingChangeId: NonEmptyStringSchema,
    decision: z.literal('installAndTrust'),
    optionalSelections: z.array(z.object({
      accessId: NonEmptyStringSchema,
      selected: z.boolean(),
    }).strict()).max(512).optional(),
  }).strict(),
  z.object({
    pendingChangeId: NonEmptyStringSchema,
    decision: z.literal('cancel'),
  }).strict(),
]);

const PluginChangeStatusRequestSchema = z.object({
  pendingChangeId: NonEmptyStringSchema,
}).strict();

const PluginDevelopmentControlRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('registerWorkspace'),
    projectRoot: NonEmptyStringSchema,
    trust: z.enum(['accept', 'deny']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('registerExplicit'),
    rootPath: NonEmptyStringSchema,
    sdkRegistryOrigin: NonEmptyStringSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('unregisterExplicit'),
    rootPath: NonEmptyStringSchema,
  }).strict(),
  z.object({ kind: z.literal('invalidate'), rootPath: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal('reload'), rootPath: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal('status') }).strict(),
]);

const PluginActionExecuteRequestSchema = z.object({
  actionId: NonEmptyStringSchema,
  input: z.unknown(),
  requiredDangerLevel: z.literal('safe').optional(),
  surface: z.enum(['cli', 'mcp', 'agent']),
  defaultSessionId: NonEmptyStringSchema.optional(),
  startedBy: WorkflowRunStartedByV1Schema.optional(),
  expectedContributorOccurrenceId: PluginRuntimeOccurrenceIdSchema.optional(),
}).strict();

export type PluginActionExecuteRequest = z.infer<typeof PluginActionExecuteRequestSchema>;

export async function executeAppliedDaemonPluginActionWithController(
  request: PluginActionExecuteRequest,
  reloadController: PluginReloadController,
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest
  ) => Promise<TargetActionCurrentIntentResult>,
): Promise<PluginActionExecutionAttempt> {
  const { executeContributedAction } = await import('@/plugins/runtime/invocation/actions/executeContributedAction');
  const lease = reloadController.tryAcquireRuntimeRegistry();
  if (!lease) {
    return {
      matched: true,
      result: {
        ok: false,
        errorCode: 'plugin_action_runtime_unavailable',
        error: 'The applied daemon plugin runtime is unavailable',
      },
    };
  }
  try {
    return await executeContributedAction({
      runtimeRegistry: lease.registry,
      actionId: request.actionId,
      input: request.input,
      ...(request.requiredDangerLevel ? { requiredDangerLevel: request.requiredDangerLevel } : {}),
      ...(request.expectedContributorOccurrenceId === undefined
        ? {}
        : {
            expectedContributorOccurrenceId:
              request.expectedContributorOccurrenceId,
          }),
      ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
      context: {
        surface: request.surface,
        ...(request.startedBy ? { startedBy: request.startedBy } : {}),
        ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
      },
    });
  } finally {
    await lease.release();
  }
}

async function executeAppliedDaemonPluginAction(
  request: PluginActionExecuteRequest,
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest
  ) => Promise<TargetActionCurrentIntentResult>,
): Promise<PluginActionExecutionAttempt> {
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  return await executeAppliedDaemonPluginActionWithController(
    request,
    pluginReloadController,
    requestCurrentIntent,
  );
}

type RequireDaemonControlAuth = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void> | void;

export function registerDaemonPluginChangeRoutes(
  app: FastifyInstance,
  params: Readonly<{
    service: DaemonPluginChangeService;
    requireAuth: RequireDaemonControlAuth;
    executeAction?: (request: PluginActionExecuteRequest) => Promise<PluginActionExecutionAttempt>;
    requestCurrentIntent?: (
      request: TargetActionCurrentIntentRequest
    ) => Promise<TargetActionCurrentIntentResult>;
    readCatalog?: () => Promise<readonly unknown[]>;
    readCatalogSnapshot?: () => Promise<CurrentDaemonPluginCatalogSnapshot>;
    readCatalogProjection?: () => DaemonPluginCatalogProjection;
  }>,
): void {
  app.post(PLUGIN_CATALOG_READ_PATH, { preHandler: params.requireAuth }, async (_request, reply) => {
    if (!params.readCatalog && !params.readCatalogSnapshot) {
      return await reply.code(503).send({
        kind: 'unavailable',
        code: 'plugin_catalog_runtime_unavailable',
      });
    }
    if (params.readCatalogSnapshot) {
      // Capture before the asynchronous snapshot: a concurrent invalidation
      // must never label an older leased occurrence with the newer revision.
      const projection = params.readCatalogProjection?.();
      return {
        kind: 'available',
        ...await params.readCatalogSnapshot(),
        ...(projection ? { projection } : {}),
      };
    }
    return {
      kind: 'available',
      plugins: await params.readCatalog!(),
    };
  });

  app.post(PLUGIN_CHANGE_REQUEST_PATH, { preHandler: params.requireAuth }, async (request, reply) => {
    const parsed = PluginChangeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(400).send({ kind: 'failed', code: 'invalid_plugin_change_request' });
    }
    return await params.service.requestPluginChange(parsed.data);
  });

  app.post(PLUGIN_CHANGE_DECISION_PATH, { preHandler: params.requireAuth }, async (request, reply) => {
    const parsed = PluginChangeDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(400).send({ kind: 'failed', code: 'invalid_plugin_change_decision' });
    }
    return await params.service.decidePluginChange(parsed.data);
  });

  app.post(PLUGIN_CHANGE_STATUS_PATH, { preHandler: params.requireAuth }, async (request, reply) => {
    const parsed = PluginChangeStatusRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(400).send({ kind: 'failed', code: 'invalid_plugin_change_status_request' });
    }
    return await params.service.statusPluginChange(parsed.data);
  });

  // Enumeration takes no request body: the outstanding decisions are the
  // daemon's own state, and a caller that had to name one already has the
  // by-id status route. This is the read that makes a change some other client
  // (an Agent's Action call, a terminal) prepared visible to a present user.
  app.post(PLUGIN_CHANGE_LIST_PATH, { preHandler: params.requireAuth }, async () => {
    return await params.service.listPendingPluginChanges();
  });

  app.post(PLUGIN_DEVELOPMENT_CONTROL_PATH, { preHandler: params.requireAuth }, async (request, reply) => {
    const parsed = PluginDevelopmentControlRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(400).send({
        kind: 'failed',
        code: 'invalid_plugin_development_control_request',
      });
    }
    if (!params.service.controlPluginDevelopment) {
      return await reply.code(503).send({
        kind: 'failed',
        code: 'plugin_development_runtime_unavailable',
      });
    }
    return await params.service.controlPluginDevelopment(
      parsed.data as DaemonPluginDevelopmentControlRequest,
    );
  });

  app.post(PLUGIN_ACTION_EXECUTE_PATH, { preHandler: params.requireAuth }, async (request, reply) => {
    const parsed = PluginActionExecuteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(400).send({
        matched: true,
        result: {
          ok: false,
          errorCode: 'invalid_plugin_action_request',
          error: 'Invalid plugin action request',
        },
      });
    }
    return await (params.executeAction
      ? params.executeAction(parsed.data)
      : executeAppliedDaemonPluginAction(parsed.data, params.requestCurrentIntent));
  });
}
