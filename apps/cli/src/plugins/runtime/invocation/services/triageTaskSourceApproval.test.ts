import { describe, expect, it } from 'vitest';
import {
  createActionExecutor,
  ActionsSettingsV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  computeExternalActionRequestEnvelopeDigestV1,
  StrictJsonValueSchema,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import {
  fingerprintPluginAccountActionConfirmation,
  formatQualifiedPluginActionId,
} from '@happier-dev/protocol/plugins/actions/invocation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import {
  executeInternalTaskAction,
  type AccountJsonKvCollectionPort,
} from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { createTriageCreateTaskActionHandler } from '../../../../../../../packages/plugins/triage/src/actions/tasks.js';
import { INTERNAL_TASK_ACTIONS_V1 } from '../../../../../../../packages/plugins/triage/src/internalTasks/contribution.js';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createCommittedContributedActionInvoker } from '../actions/createCommittedContributedActionDeps';
import { executeContributedAction } from '../actions/executeContributedAction';
import { createTargetActionInvocationRegistry } from '../targetActionRegistry';
import { createProductionPluginInvocationServiceOwners } from './production';
import {
  projectContributedActionExecuteResult,
  type InvokeContributedAction,
} from './actions';
import { createTestkitAccountKv } from '../../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support.js';
import { createTestkitCorpusCollections } from '../../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support.js';
import {
  CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
  CORPUS_SESSION_LINKS_COLLECTION_ID,
  CORPUS_USER_MARKS_COLLECTION_ID,
} from '../../../../../../../packages/plugins/triage/src/corpus/collections/ids.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../../../../../../packages/plugins/triage/src/internalTasks/configuration.js';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createPluginReloadController } from '../../reload/controller';
import { createReloadControllerTargetedContributionsService } from './targetedContributions';

/** Real Triage declarations, cold admission and targeted handles; no activation or provider read. */
async function triageContributionRegistry(occurrenceId: PluginRuntimeOccurrenceId, sourceCustody: unknown) {
  const ingested = ingestCanonicalPluginManifest(PLUGIN_MANIFEST, { sourceProvenance: 'localSource',
    manifestAuthority: 'bundled_first_party', enforceEngineCompatibility: false });
  if (!ingested.ok) throw new Error(ingested.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
  const loaded = { pluginId: ingested.manifest.id, pluginRootPath: '@happier-dev/plugins-triage',
    manifestPath: `bundled:${ingested.manifest.id}`, daemonEntryPath: '@happier-dev/plugins-triage', devDaemonEntryPath: null,
    manifest: ingested.manifest, sourceSpec: { kind: 'bundled', locator: '@happier-dev/plugins-triage',
      trustPolicy: 'local_trusted', installPolicy: 'link', resolvedVersion: ingested.manifest.version } } as const;
  const contributes = createResolvedContributionRegistry({
    ...projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'first_party' }),
    occurrenceIdsByPluginId: { [PLUGIN_MANIFEST.id]: occurrenceId },
  });
  return await resolveExecutablePluginRuntimeRegistry({ contributes, pluginIds: [],
    servingPluginOccurrences: new Map([[PLUGIN_MANIFEST.id, { occurrenceId, sourceCustody: sourceCustody as never }]]) });
}

type Scenario = Readonly<{
  label: string;
  /** Explicit Settings choice on the selected source Action. */
  source?: Readonly<{
    approvalRequiredSurfaces?: readonly ('ui' | 'plugin')[];
    disabledSurfaces?: readonly ('ui' | 'plugin')[];
  }>;
  /** A remote source declares a designed confirmation for every write (for example Linear). */
  remoteConfirmation?: true;
  expected: 'created' | 'review' | 'refused';
}>;

const manifest = PluginManifestV2Schema.parse(PLUGIN_MANIFEST);
const declarationOf = (localId: string) =>
  manifest.contributes.actions!.find((action) => action.id === localId)!;
const parentAction = {
  pluginId: PLUGIN_MANIFEST.id,
  localId: 'tasks/create-v1',
};
const sourceAction = {
  pluginId: PLUGIN_MANIFEST.id,
  localId: 'internal/tasks/create-v1',
};
const configured = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured;
const createInput = {
  action: parentAction,
  input: {
    v: 1,
    source: configured.instance.source,
    sourceInstanceId: configured.instance.sourceInstanceId,
    kindId: 'task',
    fields: { title: 'Pressed in Tasks' },
  },
};

/** One person's own Tasks press on the Account host, through the real executor, registry, Triage handler and source Action. */
async function pressCreate(
  scenario: Scenario,
  confirm?: (
    review: Readonly<{ reviewDigest: string }>,
  ) => ActionExecutorContext['presentUserConfirmation'],
) {
  const sourceCustody = {
    kind: 'bundled_first_party' as const,
    packagedRuntime: {
      kind: 'source_declaration' as const,
      packageName: '@happier-dev/plugins-triage',
    },
  };
  const occurrenceId = createPluginRuntimeOccurrenceId(PLUGIN_MANIFEST.id);
  const kv = createTestkitAccountKv();
  const corpus = createTestkitCorpusCollections();
  // Account KV and collections model the external storage boundary.
  const storage = {
    account: {
      kv: kv.kv,
      collection: (definition: { id: string }) => {
        if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID)
          return corpus.collections.sourceInstances;
        if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID)
          return corpus.collections.sessionLinks;
        if (definition.id === CORPUS_USER_MARKS_COLLECTION_ID)
          return corpus.collections.userMarks;
        throw new Error(`Unexpected collection ${definition.id}`);
      },
    },
  } as unknown as StorageService;
  // Real targeted-contribution owner over the real Triage registry: the
  // host-issued source handles are the ones production admission checks.
  const contributionRegistry = await triageContributionRegistry(occurrenceId, sourceCustody);
  const reloadController = createPluginReloadController({ resolveRuntimeRegistry: async () => contributionRegistry });
  await (await reloadController.acquireRuntimeRegistry()).release();
  const handlers: Record<string, (input: never, context: never) => Promise<unknown>> = {
    [parentAction.localId]: createTriageCreateTaskActionHandler() as never,
    [sourceAction.localId]: INTERNAL_TASK_ACTIONS_V1['internal/tasks/create-v1'].run as never,
  };
  // Account JSON KV is the persistence boundary; the real todo owner decides the write.
  const rows = new Map<string, { value: unknown; version: number }>();
  const port: AccountJsonKvCollectionPort = {
    read: async (key) =>
      structuredClone(rows.get(key) ?? { value: null, version: -1 }),
    list: async (prefix) =>
      [...rows]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, row]) => ({ key, ...structuredClone(row) })),
    mutate: async (mutations) => {
      const results = mutations.map((mutation) => {
        rows.set(mutation.key, {
          value: structuredClone(mutation.value),
          version: mutation.version + 1,
        });
        return { key: mutation.key, version: mutation.version + 1 };
      });
      return { success: true, results };
    },
  };
  const taskWrites: string[] = [];
  const approvalArtifacts: unknown[] = [];
  let runtime!: ResolvedExecutablePluginRuntimeRegistry;
  const invoke = createCommittedContributedActionInvoker({
    acquireRuntimeRegistryLease: async () => ({
      registry: runtime,
      source: 'ephemeral',
      durableRevision: -1,
      release: async () => {},
    }),
  });
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    invokeContributedAction: invoke,
    internalTaskAction: async ({ actionId, input }) => {
      taskWrites.push(actionId);
      return executeInternalTaskAction({
        actionId,
        input,
        scope: { serverId: 'home', accountId: 'owner' },
        port,
        requireCurrent: () => {},
        createId: () => 'pressed-task',
      });
    },
    approvalsCreate: async (request) => {
      approvalArtifacts.push(request);
      return { artifactId: 'unexpected-approval' };
    },
  });
  const settings = ActionsSettingsV1Schema.parse({
    v: 1,
    actions: scenario.source
      ? { [formatQualifiedPluginActionId(sourceAction)]: scenario.source }
      : {},
  });
  const owners = createProductionPluginInvocationServiceOwners({
    actionExecutor: executor,
    targetedContributions: createReloadControllerTargetedContributionsService({ reloadController }),
    // Mirrors the Account host's in-process plugin-to-plugin invoker
    // (resolveExecutablePluginRuntimeRegistry): the plugin surface and the
    // caller's retained approval context reach the canonical admission owner.
    invokeContributedAction: async (
      request: Parameters<InvokeContributedAction>[0],
    ) => {
      const attempt = await executeContributedAction({
        runtimeRegistry: runtime,
        ...(request.approvalContext
          ? { approvalContext: request.approvalContext }
          : {}),
        ...(request.presentUserIntent
          ? { presentUserIntent: request.presentUserIntent }
          : {}),
        // The Account host's credentialed Ask creates an approval Artifact.
        requestCurrentIntent: async () => {
          approvalArtifacts.push(request.action);
          return { status: 'deferred', artifactId: 'unexpected-approval' };
        },
        actionId: buildQualifiedPluginContributionKey(request.action),
        input: request.input,
        actionsSettings: settings,
        ...(request.admittedTargetedOperation
          ? { admittedTargetedOperation: request.admittedTargetedOperation }
          : {}),
        context: {
          surface: request.surface,
          caller: request.caller,
          ...(request.initiatingActionCaller
            ? { initiatingActionCaller: request.initiatingActionCaller }
            : {}),
          ...(request.beforeHandlerInvocation
            ? { beforeHandlerInvocation: request.beforeHandlerInvocation }
            : {}),
          signal: request.signal,
        },
      });
      return attempt.matched
        ? projectContributedActionExecuteResult(attempt.result)
        : {
            status: 'unavailable',
            code: 'plugin_action_handler_missing',
            message: 'missing',
            actionHandlerInvocation: 'notStarted',
          };
    },
  });
  const declarations = [parentAction, sourceAction].map((ref) => {
    const declaration = declarationOf(ref.localId);
    return ref === sourceAction && scenario.remoteConfirmation
      ? {
          ...declaration,
          dangerLevel: 'writesRemote' as const,
          confirmationWhen: undefined,
        }
      : declaration;
  });
  const targets = createTargetActionInvocationRegistry({ readMachineLocalDatabaseAgentLevel: async () => undefined,
    actions: declarations.map((declaration) => ({
      pluginId: PLUGIN_MANIFEST.id,
      pluginVersion: PLUGIN_MANIFEST.version,
      occurrenceId,
      sourceCustody,
      localId: declaration.id,
      definition: declaration,
      // The real Triage handlers run with the host's own services; only
      // Account storage is the substituted boundary.
      handler: async (value: unknown, context: Readonly<{ services: object }>) =>
        StrictJsonValueSchema.parse(await handlers[declaration.id]!(value as never,
          { invokedAtMs: 0, ...context, services: { ...context.services, storage } } as never)),
    })) as never,
    resolveAuthorizationFacts: (target) => ({
      generation: {
        targetGeneration: target.occurrenceId,
        desiredGeneration: target.occurrenceId,
        appliedGeneration: target.occurrenceId,
      },
      resourceSelections: [],
      scopedGrants: [],
      operatingSystemAuthorization: [],
    }),
    createServices: owners.createServices,
    resolveHostBinding: owners.resolveHostBinding,
    readCurrentPluginOccurrenceId: () => occurrenceId,
  });
  // The executable registry is a host boundary fixture populated from the real declarations.
  runtime = {
    executionRealm: 'account',
    contributes: {
      actionsById: new Map(
        declarations.map((declaration) => [
          `${PLUGIN_MANIFEST.id}/${declaration.id}`,
          {
            pluginId: PLUGIN_MANIFEST.id,
            identity: { pluginId: PLUGIN_MANIFEST.id, localId: declaration.id },
            definition: {
              ...declaration,
              surfaces: Object.fromEntries(
                declaration.surfaces.map((surface) => [surface, true]),
              ),
            },
          } as unknown as ResolvedActionContribution,
        ]),
      ),
    },
    targetActionInvocations: targets,
    readPluginOccurrenceId: () => occurrenceId,
    revalidateAccountExecution: async () => true,
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  const target = { kind: 'machine' as const, machineId: 'account-host' };
  const execute = (
    requestId: string,
    presentUserConfirmation?: ActionExecutorContext['presentUserConfirmation'],
  ) => {
    const envelope = { v: 1 as const, requestId, target, input: createInput };
    // Home's signed binding admits this exact Account press of the outer Tasks Action.
    return executor.execute('action.invoke', createInput, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner',
      serverId: 'home',
      serverIdentityId: 'home',
      actionRequestId: requestId,
      externalActionTarget: target,
      actionsSettings: settings,
      externalActionExecutionAuthorization:
        ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1,
          token: 'home-verified-root',
          binding: {
            accountId: 'owner',
            custodianAccountId: 'owner',
            authentication: { kind: 'account', tokenEpoch: 1 },
            serverIdentityId: 'home',
            machineId: target.machineId,
            installationId: 'installation',
            actionId: 'action.invoke',
            requestId,
            target,
            accountEncryptionMode: 'plain',
            admittedMachineRole: 'manage',
            requestEnvelopeDigest:
              computeExternalActionRequestEnvelopeDigestV1(envelope),
          },
        }),
      signExternalActionApprovalInput: () => 'host-signature',
      ...(presentUserConfirmation ? { presentUserConfirmation } : {}),
    });
  };
  try {
    const first = await execute('tasks-press');
    const second =
      confirm &&
      !first.ok &&
      first.errorCode === 'action_interactive_review_required'
        ? await execute(
            'tasks-press-confirmed',
            confirm(first.details as { reviewDigest: string }),
          )
        : null;
    return { first, second, taskWrites, approvalArtifacts };
  } finally {
    targets.dispose();
    await owners.dispose();
    await reloadController.shutdown();
  }
}

describe('Tasks press reaches the selected source Action through its own approval policy', () => {
  it.each<Scenario>([
    {
      label: 'Happier source writes are direct by declaration',
      expected: 'created',
    },
    {
      label: 'an explicit Contextual UI Ask on the source asks',
      source: { approvalRequiredSurfaces: ['ui'] },
      expected: 'review',
    },
    {
      label: 'an explicit Trusted plugins Ask on the source asks',
      source: { approvalRequiredSurfaces: ['plugin'] },
      expected: 'review',
    },
    {
      label: 'a remote source with a designed confirmation asks',
      remoteConfirmation: true,
      expected: 'review',
    },
    {
      label: 'Contextual UI Off on the source refuses',
      source: { disabledSurfaces: ['ui'] },
      expected: 'refused',
    },
    {
      label: 'Trusted plugins Off on the source refuses',
      source: { disabledSurfaces: ['plugin'] },
      expected: 'refused',
    },
  ])('$label', async (scenario) => {
    const { first, taskWrites, approvalArtifacts } =
      await pressCreate(scenario);
    // Neither path creates a self-approval Artifact for the person's own press.
    expect(approvalArtifacts).toEqual([]);
    if (scenario.expected === 'created') {
      expect(first, JSON.stringify(first)).toMatchObject({
        ok: true,
        result: { kind: 'applied' },
      });
      expect(taskWrites).toEqual(['tasks.internal.create']);
      return;
    }
    expect(taskWrites).toEqual([]);
    if (scenario.expected === 'review') {
      // The originating UI presents this review and re-presses bound to its digest.
      expect(first, JSON.stringify(first)).toMatchObject({
        ok: false,
        errorCode: 'action_interactive_review_required',
        details: {
          review: { preview: expect.any(Object) },
          reviewDigest: expect.any(String),
        },
      });
      return;
    }
    expect(JSON.stringify(first)).toContain('plugin_action_unavailable');
  });

  it('creates the task once after the person confirms the carried review', async () => {
    const { first, second, taskWrites, approvalArtifacts } = await pressCreate(
      {
        label: 'Ask then confirm',
        source: { approvalRequiredSurfaces: ['ui'] },
        expected: 'review',
      },
      (review) => ({
        actionId: 'action.invoke',
        requestId: 'tasks-press-confirmed',
        accountId: 'owner',
        serverId: 'home',
        target: { kind: 'machine', machineId: 'account-host' },
        reviewDigest: review.reviewDigest,
        inputDigest: fingerprintPluginAccountActionConfirmation({
          input: createInput,
          pluginId: PLUGIN_MANIFEST.id,
        })!,
      }),
    );
    expect(first).toMatchObject({
      ok: false,
      errorCode: 'action_interactive_review_required',
    });
    expect(second, JSON.stringify(second)).toMatchObject({
      ok: true,
      result: { kind: 'applied' },
    });
    expect(taskWrites).toEqual(['tasks.internal.create']);
    expect(approvalArtifacts).toEqual([]);
  });
});
