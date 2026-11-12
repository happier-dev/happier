import type { AgentPreflightSessionControlsContributionV1, AgentSessionModelsSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';

import { probeOpenCodePreflightCatalogs, resolveOpenCodePreflightProbeVariant, withOpenCodePreflightServer } from './catalogs.js';
import { buildOpenCodeModesFromAgents } from './modes.js';
import type { OpenCodeServerClient } from '../runtime/server/openCodeServerClient.js';
import { resolveOpenCodeBackendMode } from '../runtime/mode.js';
import { OPENCODE_CHILD_LAUNCH_ENV_KEYS } from '../runtime/server/spawnSpec.js';
import { isOpenCodeModelSelectable } from '../models/eligibility.js';
import { buildOpenCodeThinkingModelOptionsFromVariants } from '../config/thinking.js';
import { asRecord, normalizeString } from '../runtime/server/openCodeParsing.js';
import { prepareOpenCodeQualifiedConnectedAccounts } from '../auth/services/qualifiedPurposeLaunch.js';
import {
  OPEN_CODE_STABLE_SYSTEM_TOOL_ID,
  OPEN_CODE_SYSTEM_TOOL_ID,
  OPEN_CODE_V2_SYSTEM_TOOL_ID,
  resolveOpenCodeSystemToolId,
} from '../systemTool.js';

export type OpenCodePreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  modelOptions?: NonNullable<ReturnType<typeof buildOpenCodeThinkingModelOptionsFromVariants>>;
}>;

function modelSupportsReasoningVariants(record: Readonly<Record<string, unknown>>): boolean {
  const variants = record.variants;
  if (Array.isArray(variants)) return variants.length > 0;
  return asRecord(record.capabilities)?.reasoning === true;
}

function readContextWindowTokens(record: Readonly<Record<string, unknown>>): number | undefined {
  const value = asRecord(record.limit)?.context;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function buildOpenCodePreflightModels(
  blocks: readonly Readonly<{ fullId: string; record: Readonly<Record<string, unknown>> }>[],
  nowMs: number,
): readonly OpenCodePreflightModel[] | null {
  const models = blocks
    .map((block): OpenCodePreflightModel | null => {
      const providerId = block.fullId.slice(0, block.fullId.indexOf('/'));
      if (!isOpenCodeModelSelectable({ providerID: providerId, modelID: block.fullId.slice(providerId.length + 1), modelRecord: block.record, nowMs })) return null;
      const name = normalizeString(block.record.name) || block.fullId;
      const description = normalizeString(block.record.family) || normalizeString(block.record.providerID);
      const contextWindowTokens = readContextWindowTokens(block.record);
      const modelOptions = modelSupportsReasoningVariants(block.record)
        ? buildOpenCodeThinkingModelOptionsFromVariants(block.record.variants, null)
        : null;
      return {
        id: block.fullId,
        name,
        ...(description ? { description } : {}),
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        ...(modelOptions ? { modelOptions } : {}),
      };
    })
    .filter((model): model is OpenCodePreflightModel => model !== null);

  return models;
}

/** Both preflight and bound Sessions consume the native server's provider inventory. */
export function buildOpenCodeModelCatalogFromProviders(
  providers: Awaited<ReturnType<OpenCodeServerClient['providersList']>>,
  observedAt: number,
): Readonly<{ models: readonly OpenCodePreflightModel[] | null; unavailableReason?: string; catalogConfidence?: AgentSessionModelsSnapshot['catalogConfidence'] }> {
  // Native inventory is a model registry, not this ChatGPT Account's entitlement.
  // Keep its models for explicit runtime selections but do not advertise them.
  let unavailable = false;
  const blocks = providers.flatMap(provider => {
    if (provider.usesChatGptAccount) {
      unavailable = true;
      return [];
    }
    return Object.entries(provider.models ?? {}).flatMap(([id, raw]) => {
      const record = asRecord(raw);
      return record ? [{ fullId: `${provider.id}/${normalizeString(record.id) || id}`, record }] : [];
    });
  });
  const models = buildOpenCodePreflightModels(blocks, observedAt);
  return {
    models: unavailable && models?.length === 0 ? null : models,
    ...(unavailable && models?.length === 0 ? { catalogConfidence: 'account_unverified' as const } : {}),
    ...(unavailable && models?.length === 0 ? { unavailableReason: 'ChatGPT account model entitlement is unavailable from the native OpenCode inventory.' } : {}),
  };
}

export const OPENCODE_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  prepareLaunchEnvironment: async ({ environment, connectedAccounts, signal, modelId }) => {
    const prepared = await prepareOpenCodeQualifiedConnectedAccounts({ launchEnvironment: { values: environment, unset: [] },
      ...(modelId === undefined ? {} : { configuration: {
        model: { value: modelId, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      } }),
    }, {
      signal, catalogObservation: true, services: { connectedAccounts },
    });
    return { environment: prepared.request.launchEnvironment?.values ?? environment,
      unset: prepared.request.launchEnvironment?.unset, dispose: prepared.dispose };
  },
  resolveProbeVariant: resolveOpenCodePreflightProbeVariant,
  probeCatalogs: probeOpenCodePreflightCatalogs,
  probeModes: async context => {
    const backendMode = resolveOpenCodeBackendMode({ runtimeDescriptorV1: context.runtimeDescriptorV1,
      configuredBackendMode: context.runtimeKindOverride, accountSettings: context.accountSettings });
    if (backendMode === 'acp') {
      const toolId = resolveOpenCodeSystemToolId(context.accountSettings?.opencodeCliGeneration);
      return (await context.probeDeclaredAcpSessionControls?.({ toolId, args: ['acp'] }))?.modes ?? null;
    }
    return await withOpenCodePreflightServer(context, async client => buildOpenCodeModesFromAgents(await client.agentsList()));
  },
  probeModels: async context => {
    const backendMode = resolveOpenCodeBackendMode({ runtimeDescriptorV1: context.runtimeDescriptorV1,
      configuredBackendMode: context.runtimeKindOverride, accountSettings: context.accountSettings });
    if (backendMode === 'acp') {
      const toolId = resolveOpenCodeSystemToolId(context.accountSettings?.opencodeCliGeneration);
      const controls = await context.probeDeclaredAcpSessionControls?.({ toolId, args: ['acp'] });
      return controls?.refreshError
        ? { availableModels: controls.models ?? [], refreshError: true, source: controls.models === null ? 'unavailable' : 'dynamic',
          ...(controls.observedAt === undefined ? {} : { observedAt: controls.observedAt }),
          ...(controls.refreshErrorMessage === undefined ? {} : { refreshErrorMessage: controls.refreshErrorMessage }) }
        : controls?.models ?? null;
    }
    return await withOpenCodePreflightServer(context, async client => {
      const providers = await client.providersList();
      const observedAt = Date.now();
      const catalog = buildOpenCodeModelCatalogFromProviders(providers, observedAt);
      return catalog.unavailableReason
        ? { availableModels: catalog.models ?? [], source: catalog.models?.length ? 'dynamic' as const : 'unavailable' as const,
          catalogObserved: true as const, observedAt, refreshError: true, refreshErrorMessage: catalog.unavailableReason }
        : catalog.models;
    });
  },
  probeConfigOptions: async context => {
    const backendMode = resolveOpenCodeBackendMode({ runtimeDescriptorV1: context.runtimeDescriptorV1,
      configuredBackendMode: context.runtimeKindOverride, accountSettings: context.accountSettings });
    if (backendMode !== 'acp') return { configOptions: [], source: 'static' };
    const toolId = resolveOpenCodeSystemToolId(context.accountSettings?.opencodeCliGeneration);
    return await context.probeDeclaredAcpSessionControls?.({ toolId, args: ['acp'] }) ?? null;
  },
  managedServiceCommands: Object.freeze([OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID].map((toolId) => Object.freeze({
    toolId, args: Object.freeze(['serve', '--hostname', '127.0.0.1']),
    environmentKeys: Object.freeze([...OPENCODE_CHILD_LAUNCH_ENV_KEYS, 'OPENCODE_PERMISSION', 'OPENCODE_DISABLE_PRUNE', 'OPENCODE_SERVER_PASSWORD']), ci: 'omit' as const,
  }))),
  jsonRpcCommands: Object.freeze([OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID].flatMap((toolId) => [
    Object.freeze({ toolId, args: Object.freeze(['--version']) }),
    Object.freeze({ toolId, args: Object.freeze(['acp']) }),
  ])),
} satisfies AgentPreflightSessionControlsContributionV1);
