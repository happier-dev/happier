import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { isActionEnabledWithSessionMemory } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import type { AccountSettings, ActionId, ActionSurfaces } from '@happier-dev/protocol';

import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

import {
  createActionSettingsProvider,
  type ActionSettingsProvider,
  type RuntimeActionSettingsProvider,
} from '@/settings/actionsSettingsProvider';

/** @deprecated Use the settings-owned ActionSettingsProvider outside MCP. */
export type McpActionSettingsProvider = ActionSettingsProvider;

/** @deprecated Use createActionSettingsProvider outside MCP. */
export const createMcpActionSettingsProvider = createActionSettingsProvider;

export function createMcpActionEnablement(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  actionSettingsProvider?: RuntimeActionSettingsProvider | null;
  surface: keyof ActionSurfaces;
}>): (id: ActionId) => boolean {
  const provider = params.actionSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: params.accountSettings ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
  });
  return (id) =>
    isActionEnabledByActionsSettings(id, provider.getActionsSettings(), {
      surface: params.surface,
      placement: null,
    });
}

/**
 * Compose the shared Actions policy with the current Session runtime's exact
 * Home feature projection. Server-backed Session Actions must not be exposed
 * without an authenticated runtime and their owning feature bit. Effect-time
 * access and currentness remain owned by each Action adapter.
 */
export function createMcpActionEnablementWithServerFeatureAvailability(params: Readonly<{
  actionSettingsProvider: RuntimeActionSettingsProvider;
  surface: keyof ActionSurfaces;
  hasAuthenticatedRuntime: boolean;
  authorityScope?: 'account' | 'session';
  /** Supplied only by a bound Session host; evaluated again for each call. */
  readSessionMemoryEnabled?: () => boolean;
  readServerFeaturesSnapshot: () => CliServerFeaturesSnapshot | undefined;
  env?: NodeJS.ProcessEnv;
}>): (id: ActionId) => boolean {
  const isEnabledByPolicy = createMcpActionEnablement({
    actionSettingsProvider: params.actionSettingsProvider,
    surface: params.surface,
  });
  return (id) => {
    if (!isActionEnabledWithSessionMemory(id, params.readSessionMemoryEnabled?.())) return false;
    if (!isEnabledByPolicy(id)) return false;
    const featureId = getActionRequiredServerFeatureId(id);
    if (featureId === null) return true;
    if (!params.hasAuthenticatedRuntime) return false;
    try {
      return resolveCliFeatureDecision({
        featureId,
        env: params.env ?? process.env,
        serverSnapshot: params.readServerFeaturesSnapshot(),
      }).state === 'enabled';
    } catch {
      return false;
    }
  };
}

export function createMcpActionApprovalRequirement(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  actionSettingsProvider?: RuntimeActionSettingsProvider | null;
  surface: keyof ActionSurfaces;
}>): (id: ActionId) => boolean {
  const provider = params.actionSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: params.accountSettings ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
  });
  return (id) =>
    isApprovalRequiredByActionsSettings(id, provider.getActionsSettings(), {
      surface: params.surface,
    });
}
