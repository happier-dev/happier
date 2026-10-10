import { resolveCurrentPluginPermissionGrantAuthoritySource } from '@/daemon/identity/currentMachineInstallation';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { StoredCredentials } from '@/persistence';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createVoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import {
  createPluginRawCredentialAuthorizationInspector,
  createPluginRawCredentialMaterializer,
  type CurrentPluginInstallReviewPrincipalReader,
  type CurrentPluginPermissionGrantAuthoritySourceReader,
  type PluginPermissionGrantListReader,
  type PluginRawCredentialAuthorizationInspector,
  type PluginRawCredentialMaterializer,
  type PluginRawCredentialMaterializerBinding,
} from './rawCredentialMaterializer';
import { createAccountLifetimePluginPermissionGrantListReader } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantListReader';
import { createRegistryInstallReviewPrincipalReader } from './registryInstallReviewPrincipalReader';

type DaemonRawCredentialCommonInput = Readonly<{
  binding: PluginRawCredentialMaterializerBinding;
  happyHomeDir?: string;
  currentInstallReviewPrincipal?: CurrentPluginInstallReviewPrincipalReader;
  readCurrentGrantAuthoritySource?: CurrentPluginPermissionGrantAuthoritySourceReader;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>;

type DaemonRawCredentialMaterializerInput = DaemonRawCredentialCommonInput & Readonly<{
  mode?: 'materialize';
  credentials?: StoredCredentials;
  grants?: PluginPermissionGrantListReader;
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'materialize'>;
}>;

type DaemonRawCredentialAuthorizationInspectorInput = DaemonRawCredentialCommonInput & Readonly<{
  mode: 'authorization';
  readStoredCredentials?: () => Promise<StoredCredentials | null>;
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding'>;
}>;

/** The review adapter needs the same principal reader that admission used. */
export type DaemonPluginRawCredentialAuthorizationInspector = PluginRawCredentialAuthorizationInspector & Readonly<{
  currentInstallReviewPrincipal: CurrentPluginInstallReviewPrincipalReader;
}>;

function resolveCurrentInstallReviewPrincipal(input: DaemonRawCredentialCommonInput) {
  return input.currentInstallReviewPrincipal ?? createRegistryInstallReviewPrincipalReader({
    ...(input.happyHomeDir ? { happyHomeDir: input.happyHomeDir } : {}),
  });
}

function resolveAccountSettingsWarmer(input: Readonly<{
  credentials?: StoredCredentials;
  readStoredCredentials?: () => Promise<StoredCredentials | null>;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
}>): (() => Promise<void>) | undefined {
  const resolver = createVoiceCredentialResolver({ machineId: input.machineId,
    ...(input.credentials ? { credentials: input.credentials } : {}),
    ...(input.readStoredCredentials ? { readCredentials: input.readStoredCredentials } : {}),
    ...(input.getAccountSettingsSnapshot ? { getSnapshot: input.getAccountSettingsSnapshot } : {}),
    ...(input.ensureAccountSettingsSnapshot ? { ensureSnapshot: input.ensureAccountSettingsSnapshot } : {}) });
  return () => resolver.prepareForOperation();
}

/**
 * Canonical daemon composition for raw Voice materialization and its preceding
 * authorization inspection. Runtime/RPC adapters supply only their request
 * mapping and runtime-currentness binding; grants, review principal, and
 * account-settings warming are all assembled here.
 */
export function createDaemonPluginRawCredentialMaterializer(
  input: DaemonRawCredentialMaterializerInput,
): PluginRawCredentialMaterializer;
export function createDaemonPluginRawCredentialMaterializer(
  input: DaemonRawCredentialAuthorizationInspectorInput,
): DaemonPluginRawCredentialAuthorizationInspector;
export function createDaemonPluginRawCredentialMaterializer(
  input: DaemonRawCredentialMaterializerInput | DaemonRawCredentialAuthorizationInspectorInput,
): PluginRawCredentialMaterializer | DaemonPluginRawCredentialAuthorizationInspector {
  const currentInstallReviewPrincipal = resolveCurrentInstallReviewPrincipal(input);
  const readCurrentGrantAuthoritySource = input.readCurrentGrantAuthoritySource
    ?? resolveCurrentPluginPermissionGrantAuthoritySource;
  if (input.mode === 'authorization') {
    const ensureAccountSettingsSnapshot = resolveAccountSettingsWarmer({
      readStoredCredentials: input.readStoredCredentials,
      ensureAccountSettingsSnapshot: input.ensureAccountSettingsSnapshot,
      machineId: input.binding.machineId,
      getAccountSettingsSnapshot: input.getAccountSettingsSnapshot,
    });
    return Object.freeze({
      ...createPluginRawCredentialAuthorizationInspector({
        binding: input.binding,
        currentInstallReviewPrincipal,
        readCurrentGrantAuthoritySource,
        ...(input.connectedAccounts ? { connectedAccounts: input.connectedAccounts } : {}),
        ...(input.getAccountSettingsSnapshot
          ? { getAccountSettingsSnapshot: input.getAccountSettingsSnapshot }
          : {}),
        ...(ensureAccountSettingsSnapshot ? { ensureAccountSettingsSnapshot } : {}),
      }),
      currentInstallReviewPrincipal,
    });
  }

  const grants = input.grants ?? (() => {
    if (!input.credentials) {
      throw new TypeError('Raw credential materialization requires credentials or a grant reader');
    }
    return createAccountLifetimePluginPermissionGrantListReader({ credentials: input.credentials });
  })();
  const ensureAccountSettingsSnapshot = resolveAccountSettingsWarmer({
    ...(input.credentials ? { credentials: input.credentials } : {}),
    ensureAccountSettingsSnapshot: input.ensureAccountSettingsSnapshot,
    machineId: input.binding.machineId,
    getAccountSettingsSnapshot: input.getAccountSettingsSnapshot,
  });
  return Object.freeze({
    ...createPluginRawCredentialMaterializer({
      binding: input.binding,
      currentInstallReviewPrincipal,
      readCurrentGrantAuthoritySource,
      grants,
      ...(input.connectedAccounts ? { connectedAccounts: input.connectedAccounts } : {}),
      ...(input.getAccountSettingsSnapshot
        ? { getAccountSettingsSnapshot: input.getAccountSettingsSnapshot }
        : {}),
      ...(ensureAccountSettingsSnapshot ? { ensureAccountSettingsSnapshot } : {}),
    }),
  });
}
