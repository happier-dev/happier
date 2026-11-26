import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { type ActionEnablementDecision, type ActionEnablementReader, isActionEnabledWithSessionMemory } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import type { AccountSettings, ActionId, ActionSurfaces } from '@happier-dev/protocol';

import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolveCliFeatureDecisionEnvironment } from '@/features/featureDecisionInputs';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

import {
  createActionSettingsProvider,
  createSessionActionSettingsView,
  type ActionSettingsProvider,
  type RuntimeActionSettingsProvider,
} from '@/settings/actionsSettingsProvider';

/** @deprecated Use the settings-owned ActionSettingsProvider outside MCP. */
export type McpActionSettingsProvider = ActionSettingsProvider;

/** Bind Session ingress to its admitted policy; standalone callers retain CLI precedence. */
export function createMcpActionSettingsProvider(params: NonNullable<Parameters<typeof createActionSettingsProvider>[0]> & Readonly<{
  credentials?: StoredCredentials | null;
  sessionCredentials?: Pick<StoredCredentials, 'token'> | null;
  authorityScope?: 'account' | 'session';
}> = {}): ActionSettingsProvider {
  const credentials = params.authorityScope === 'session' ? null : params.credentials;
  return createActionSettingsProvider({
    accountSettings: params.accountSettings,
    credentials,
    // Credential-derived MCP bindings follow the canonical Account snapshot.
    // Legacy host callbacks read ambient focus and cannot prove that scope;
    // explicitly scoped invocation getters retain their admitted authority.
    getAccountSettings: credentials && !params.scopeKey ? undefined : params.getAccountSettings,
    scopeKey: params.scopeKey ?? (credentials ? resolveAccountSettingsScopeKeyForToken(credentials.token) : null),
    allowEnvironmentOverride: params.sessionCredentials || params.credentials
      ? false : params.allowEnvironmentOverride,
  });
}

export function createMcpActionEnablement(params: Readonly<{
  accountSettings?: AccountSettings | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  actionSettingsProvider?: RuntimeActionSettingsProvider | null;
  surface: keyof ActionSurfaces;
}>): (id: ActionId) => boolean {
  const baseProvider = params.actionSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: params.accountSettings ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
  });
  const provider = params.surface === 'voice'
    ? createSessionActionSettingsView(baseProvider, () => null, 'voice') : baseProvider;
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
}>): ActionEnablementReader {
  const env = resolveCliFeatureDecisionEnvironment(params.env);
  const isEnabledByPolicy = createMcpActionEnablement({
    actionSettingsProvider: params.actionSettingsProvider,
    surface: params.surface,
  });
  const readDecision = (id: ActionId): ActionEnablementDecision => {
    // A Voice Run's host Session is its carrier. The App owns the working Session's Memory choice.
    if (params.surface !== 'voice' && !isActionEnabledWithSessionMemory(id, params.readSessionMemoryEnabled?.())) return { enabled: false };
    if (!isEnabledByPolicy(id)) return { enabled: false };
    const featureId = getActionRequiredServerFeatureId(id);
    if (featureId === null) return { enabled: true };
    if (!params.hasAuthenticatedRuntime) return { enabled: false, authenticatedRuntime: false };
    try {
      const featureDecision = resolveCliFeatureDecision({
        featureId,
        env,
        serverSnapshot: params.readServerFeaturesSnapshot(),
      });
      return { enabled: featureDecision.state === 'enabled', featureDecision };
    } catch {
      return { enabled: false };
    }
  };
  return Object.assign((id: ActionId) => readDecision(id).enabled, { readDecision });
}
