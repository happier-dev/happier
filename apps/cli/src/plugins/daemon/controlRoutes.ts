import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod/mini';
import { NpmRegistryProfileIdV1Schema } from '@happier-dev/protocol/rpc/npmRegistryProfiles';
import { ExpectedMarketplaceListingV1Schema } from '@happier-dev/protocol/marketplace/internal';
import { PluginUpdatePolicyV1Schema } from '@happier-dev/protocol/marketplace/pluginUpdatePolicyV1';
import { PluginGitInstallSourceSchema } from '@happier-dev/protocol/plugins/source-spec';
import { WorkflowRunStartedByV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { ManagedResourceDispositionV1Schema } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import type { PluginActionExecutionAttempt } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import type { CurrentDaemonPluginCatalogSnapshot } from './currentCatalog';
import { DaemonPluginCatalogReadRequestSchema, type DaemonPluginCatalogReadRequest, type DaemonPluginCatalogProjection } from './catalogProjection';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { DaemonPluginChangeService } from './changeService';
import type { DaemonPluginDevelopmentControlRequest } from './developmentRoots';
import { createDaemonControlRequestLifetime } from '@/daemon/controlRequestLifetime';

export const PLUGIN_CHANGE_REQUEST_PATH = '/plugins/change/request';
export const PLUGIN_CHANGE_DECISION_PATH = '/plugins/change/decide';
export const PLUGIN_CHANGE_STATUS_PATH = '/plugins/change/status';
export const PLUGIN_CHANGE_LIST_PATH = '/plugins/change/list';
export const PLUGIN_ACTION_EXECUTE_PATH = '/plugins/actions/execute';
export const PLUGIN_CATALOG_READ_PATH = '/plugins/catalog/read';
export const PLUGIN_DEVELOPMENT_CONTROL_PATH = '/plugins/development/control';

const NonEmptyStringSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(32_768));
const PluginIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));
const PluginRuntimeOccurrenceIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(512));
const ArchiveSha256IntegritySchema = z.string().check(z.trim(), z.regex(/^sha256-[A-Za-z0-9+/]{43}=$/u));

const PluginChangeRequestSchema = z.union([
  z.strictObject({ kind: z.literal('installGit'), source: PluginGitInstallSourceSchema }),
  z.strictObject({
    kind: z.literal('installMarketplace'),
    sourceId: NonEmptyStringSchema,
    pluginId: PluginIdSchema,
    packageName: z.optional(NonEmptyStringSchema),
    version: z.optional(NonEmptyStringSchema),
  }),
  z.strictObject({
    kind: z.literal('installPath'),
    locator: NonEmptyStringSchema,
    development: z.optional(z.literal(false)),
  }),
  z.strictObject({
    kind: z.literal('installArchive'),
    locator: NonEmptyStringSchema,
    expectedIntegrity: z.optional(ArchiveSha256IntegritySchema),
  }),
  z.strictObject({
    kind: z.literal('installNpm'),
    packageName: NonEmptyStringSchema,
    selector: z.optional(NonEmptyStringSchema),
    registryOrigin: z.optional(NonEmptyStringSchema),
    registryProfileId: z.optional(NpmRegistryProfileIdV1Schema),
    expectedMarketplaceListing: z.optional(ExpectedMarketplaceListingV1Schema),
  }),
  z.strictObject({
    kind: z.literal('update'),
    pluginId: PluginIdSchema,
  }),
  z.strictObject({
    kind: z.literal('setUpdatePolicy'),
    pluginId: PluginIdSchema,
    policy: PluginUpdatePolicyV1Schema,
  }),
  z.strictObject({
    kind: z.literal('development'),
    pluginId: z.optional(PluginIdSchema),
    sourceRootPath: NonEmptyStringSchema,
    changedPaths: z.optional(z.array(NonEmptyStringSchema).check(z.maxLength(4_096))),
    sdkRegistryOrigin: z.optional(NonEmptyStringSchema),
  }),
  ...([
    'enable',
    'rollback',
    'forgetTrust',
  ] as const).map((kind) => (
    z.strictObject({ kind: z.literal(kind), pluginId: PluginIdSchema })
  )),
  ...(['disable', 'uninstall', 'uninstallAndDeleteData'] as const).map((kind) => (
    z.strictObject({ kind: z.literal(kind), pluginId: PluginIdSchema,
      managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)) })
  )),
]);

/**
 * The route authenticates the caller and the change service resolves the
 * pending change this answers, so the request carries no caller-described
 * actor, interaction id, or approval timestamp. Keeping every member strict
 * means such a field is rejected here rather than silently ignored.
 */
const PluginChangeDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    pendingChangeId: NonEmptyStringSchema,
    decision: z.literal('installAndTrust'),
    optionalSelections: z.optional(z.array(z.strictObject({
      accessId: NonEmptyStringSchema,
      selected: z.boolean(),
    })).check(z.maxLength(512))),
  }),
  z.strictObject({
    pendingChangeId: NonEmptyStringSchema,
    decision: z.literal('cancel'),
  }),
]);

const PluginChangeStatusRequestSchema = z.strictObject({
  pendingChangeId: NonEmptyStringSchema,
});

const PluginDevelopmentControlRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('registerWorkspace'),
    projectRoot: NonEmptyStringSchema,
    trust: z.optional(z.enum(['accept', 'deny'])),
  }),
  z.strictObject({
    kind: z.literal('registerExplicit'),
    rootPath: NonEmptyStringSchema,
    sdkRegistryOrigin: z.optional(NonEmptyStringSchema),
  }),
  z.strictObject({
    kind: z.literal('unregisterExplicit'),
    rootPath: NonEmptyStringSchema,
  }),
  z.strictObject({ kind: z.literal('invalidate'), rootPath: NonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('reload'), rootPath: NonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('status') }),
]);

const PluginActionExecuteRequestSchema = z.strictObject({
  actionId: NonEmptyStringSchema,
  input: z.unknown(),
  requiredDangerLevel: z.optional(z.literal('safe')),
  surface: z.enum(['cli', 'mcp', 'agent']),
  defaultSessionId: z.optional(NonEmptyStringSchema),
  // Caller correlation only. This never grants Action authority.
  actionRequestId: z.optional(NonEmptyStringSchema),
  // Descriptive starter and the admitted contributor fence are supplied by the host.
  startedBy: z.optional(WorkflowRunStartedByV1Schema),
  expectedContributorOccurrenceId: z.optional(PluginRuntimeOccurrenceIdSchema),
});

export type PluginActionExecuteRequest = z.infer<typeof PluginActionExecuteRequestSchema>;

export async function executeAppliedDaemonPluginActionWithController(
  request: PluginActionExecuteRequest,
  reloadController: PluginReloadController,
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest
  ) => Promise<TargetActionCurrentIntentResult>,
  signal?: AbortSignal,
): Promise<PluginActionExecutionAttempt> {
  const { executeContributedAction } = await import('@/plugins/runtime/invocation/actions/executeContributedAction');
  const lease = await reloadController.acquireExecutableRuntimeRegistry(signal, { recoverAccountCensus: true });
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
      daemonHoldsApprovalWaiter: true,
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
        ...(signal ? { signal } : {}),
        ...(request.startedBy ? { startedBy: request.startedBy } : {}),
        ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
        ...(request.actionRequestId ? { actionRequestId: request.actionRequestId } : {}),
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
  signal?: AbortSignal,
): Promise<PluginActionExecutionAttempt> {
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  return await executeAppliedDaemonPluginActionWithController(
    request,
    pluginReloadController,
    requestCurrentIntent,
    signal,
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
    executeAction?: (request: PluginActionExecuteRequest, signal: AbortSignal) => Promise<PluginActionExecutionAttempt>;
    requestCurrentIntent?: (
      request: TargetActionCurrentIntentRequest
    ) => Promise<TargetActionCurrentIntentResult>;
    readCatalog?: () => Promise<readonly unknown[]>;
    readCatalogSnapshot?: (request?: DaemonPluginCatalogReadRequest) => Promise<CurrentDaemonPluginCatalogSnapshot>;
    readCatalogProjection?: () => DaemonPluginCatalogProjection;
    recoverFailedAccountCensus?: PluginReloadController['recoverFailedAccountCensus'];
  }>,
): void {
  app.post(PLUGIN_CATALOG_READ_PATH, { preHandler: params.requireAuth }, async (request, reply) => {
    const parsed = DaemonPluginCatalogReadRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return await reply.code(400).send({ kind: 'unavailable', code: 'invalid_plugin_catalog_request' });
    }
    if (!params.readCatalog && !params.readCatalogSnapshot) {
      return await reply.code(503).send({
        kind: 'unavailable',
        code: 'plugin_catalog_runtime_unavailable',
      });
    }
    if (parsed.data.selection !== 'tools') await params.recoverFailedAccountCensus?.();
    if (params.readCatalogSnapshot) {
      // Capture before the asynchronous snapshot: a concurrent invalidation
      // must never label an older leased occurrence with the newer revision.
      const projection = params.readCatalogProjection?.();
      return {
        kind: 'available',
        ...await params.readCatalogSnapshot(parsed.data),
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
    const lifetime = createDaemonControlRequestLifetime(request, reply);
    try {
      return await (params.executeAction
        ? params.executeAction(parsed.data, lifetime.signal)
        : executeAppliedDaemonPluginAction(parsed.data, params.requestCurrentIntent, lifetime.signal));
    } finally {
      lifetime.dispose();
    }
  });
}
