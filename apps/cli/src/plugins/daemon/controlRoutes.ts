import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import semver from 'semver';
import { z } from 'zod';
import { NpmRegistryProfileIdV1Schema } from '@happier-dev/protocol/rpc';

import type { PluginActionExecutionAttempt } from '@/plugins/projection/actions/execute';
import type { CurrentDaemonPluginCatalogSnapshot } from './currentCatalog';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { DaemonPluginChangeService } from './changeService';

export const PLUGIN_CHANGE_REQUEST_PATH = '/plugins/change/request';
export const PLUGIN_CHANGE_DECISION_PATH = '/plugins/change/decide';
export const PLUGIN_CHANGE_STATUS_PATH = '/plugins/change/status';
export const PLUGIN_CHANGE_LIST_PATH = '/plugins/change/list';
export const PLUGIN_ACTION_EXECUTE_PATH = '/plugins/actions/execute';
export const PLUGIN_CATALOG_READ_PATH = '/plugins/catalog/read';

const NonEmptyStringSchema = z.string().trim().min(1).max(32_768);
const PluginIdSchema = z.string().trim().min(1).max(256);
const ImmutableGenerationIdSchema = z.string().trim().min(1).max(512);
const ExplicitCliTrustFlagProvenanceSchema = z.object({
  kind: z.literal('explicitCliTrustFlag'),
  command: z.literal('plugins install'),
  flag: z.literal('--trust'),
  source: z.object({
    kind: z.literal('path'),
    locator: NonEmptyStringSchema,
  }).strict(),
  pluginId: PluginIdSchema.optional(),
}).strict();
const AuthenticatedUserInteractionSchema = z.object({
  kind: z.literal('authenticatedLocalUser'),
  interactionId: NonEmptyStringSchema,
  occurredAtMs: z.number().int().nonnegative().safe(),
  provenance: ExplicitCliTrustFlagProvenanceSchema.optional(),
}).strict();
const CredentialFreeHttpsUrlSchema = z.string().trim().max(2_048).url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
}, 'Expected a credential-free HTTPS URL');
const ExpectedMarketplaceListingBaseShape = {
  pluginId: PluginIdSchema,
  publisher: z.object({
    id: z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u),
    displayName: z.string().trim().min(1).max(512),
  }).strict(),
  packageName: z.string().trim().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
  registryOrigin: CredentialFreeHttpsUrlSchema,
  registryProfileId: NpmRegistryProfileIdV1Schema.optional(),
  version: z.string().trim().min(1).max(128)
    .refine((value) => semver.valid(value) === value, 'Expected an exact canonical npm semver version'),
  integrity: z.string().trim().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u),
  manifestDigest: z.string().trim().regex(/^sha256:[a-f0-9]{64}$/u),
} as const;
const ExpectedMarketplaceListingSchema = z.union([z.object({
  source: z.object({
    id: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    kind: z.literal('curated'),
    sourceUrl: CredentialFreeHttpsUrlSchema,
  }).strict(),
  ...ExpectedMarketplaceListingBaseShape,
  review: z.object({
    status: z.literal('approved'),
    reviewedAt: z.string().datetime(),
    reason: z.string().trim().min(1).max(1_024).nullable().optional(),
  }).strict(),
  updatePolicy: z.enum(['automatic', 'manual', 'pinned']),
}).strict(), z.object({
  source: z.object({
    id: z.literal('marketplace:community-npm'),
    kind: z.literal('community-npm'),
    sourceUrl: CredentialFreeHttpsUrlSchema,
  }).strict(),
  ...ExpectedMarketplaceListingBaseShape,
  registryProfileId: z.undefined().optional(),
  review: z.object({
    status: z.literal('unreviewed'),
    reviewedAt: z.null(),
  }).strict(),
  updatePolicy: z.enum(['manual', 'pinned']),
}).strict()]);

const ArchiveSha256IntegritySchema = z.string().trim().regex(/^sha256-[A-Za-z0-9+/]{43}=$/u);

const PluginChangeRequestSchema = z.union([
  z.object({
    kind: z.literal('installPath'),
    locator: NonEmptyStringSchema,
    development: z.boolean(),
    sdkRegistryOrigin: NonEmptyStringSchema.optional(),
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
    expectedMarketplaceListing: ExpectedMarketplaceListingSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('update'),
    pluginId: PluginIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('development'),
    pluginId: PluginIdSchema.optional(),
    sourceRootPath: NonEmptyStringSchema,
    changedPaths: z.array(NonEmptyStringSchema).max(4_096).optional(),
    sdkRegistryOrigin: NonEmptyStringSchema.optional(),
  }).strict(),
  ...(['enable', 'disable', 'rollback', 'forgetTrust'] as const).map((kind) => (
    z.object({ kind: z.literal(kind), pluginId: PluginIdSchema }).strict()
  )),
  z.object({ kind: z.literal('uninstall'), pluginId: PluginIdSchema }).strict(),
  z.object({
    kind: z.literal('uninstall'),
    pluginId: PluginIdSchema,
    allowAlreadyAbsent: z.literal(true),
    actorEvidence: AuthenticatedUserInteractionSchema,
  }).strict(),
]);

const PluginChangeDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    pendingChangeId: NonEmptyStringSchema,
    decision: z.literal('trustSourceRoot'),
    actorEvidence: AuthenticatedUserInteractionSchema,
  }).strict(),
  z.object({
    pendingChangeId: NonEmptyStringSchema,
    decision: z.literal('installAndTrust'),
    actorEvidence: AuthenticatedUserInteractionSchema,
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

const PluginActionExecuteRequestSchema = z.object({
  actionId: NonEmptyStringSchema,
  input: z.unknown(),
  surface: z.enum(['cli', 'mcp', 'agent']),
  defaultSessionId: NonEmptyStringSchema.optional(),
  expectedContributorImmutableGenerationId: ImmutableGenerationIdSchema.optional(),
}).strict();

export type PluginActionExecuteRequest = z.infer<typeof PluginActionExecuteRequestSchema>;

export async function executeAppliedDaemonPluginActionWithController(
  request: PluginActionExecuteRequest,
  reloadController: PluginReloadController,
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest
  ) => Promise<TargetActionCurrentIntentResult>,
): Promise<PluginActionExecutionAttempt> {
  const { executePluginActionIfAvailable } = await import('@/plugins/projection/actions/execute');
  const lease = reloadController.tryAcquireRuntimeRegistry?.() ?? null;
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
    return await executePluginActionIfAvailable({
      runtimeRegistry: lease.registry,
      actionId: request.actionId,
      input: request.input,
      ...(request.expectedContributorImmutableGenerationId === undefined
        ? {}
        : {
            expectedContributorImmutableGenerationId:
              request.expectedContributorImmutableGenerationId,
          }),
      ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
      context: {
        surface: request.surface,
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
      return {
        kind: 'available',
        ...await params.readCatalogSnapshot(),
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
