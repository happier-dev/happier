import { resolveCurrentPluginPermissionGrantAuthoritySource } from '@/daemon/identity/currentMachineInstallation';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { StoredCredentials } from '@/persistence';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
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
import { createServerPluginPermissionGrantListReader } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantListReader';
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
  warmFromCredentials: boolean;
}>): (() => Promise<void>) | undefined {
  if (input.ensureAccountSettingsSnapshot) return input.ensureAccountSettingsSnapshot;
  const credentials = input.credentials;
  if (credentials && input.warmFromCredentials) {
    return async () => {
      await warmActiveAccountSettingsSnapshotBestEffort({ credentials });
    };
  }
  const readStoredCredentials = input.readStoredCredentials;
  if (!readStoredCredentials) return undefined;
  return async () => {
    const storedCredentials = await readStoredCredentials();
    if (!storedCredentials) return;
    await warmActiveAccountSettingsSnapshotBestEffort({ credentials: storedCredentials });
  };
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
      warmFromCredentials: true,
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
    return createServerPluginPermissionGrantListReader({ credentials: input.credentials });
  })();
  const ensureAccountSettingsSnapshot = resolveAccountSettingsWarmer({
    ...(input.credentials ? { credentials: input.credentials } : {}),
    ensureAccountSettingsSnapshot: input.ensureAccountSettingsSnapshot,
    warmFromCredentials: !input.getAccountSettingsSnapshot,
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
