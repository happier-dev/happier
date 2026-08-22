import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { CloudConnectTargetStatus, CloudVendorKey } from '@happier-dev/agents';
import type {
  AuthCredentialWriteInput as CloudAuthCredentialWriteInputV1,
  AuthCredentialWriteResult as CloudAuthCredentialWriteResultV1,
  AuthenticateOptions as CloudConnectAuthenticateOptionsV1,
  AuthenticateResult as CloudConnectAuthenticateResultV1,
} from '@happier-dev/plugin-sdk/connected-accounts';

export type {
  AuthCallbackCreateInput,
  AuthCallbackCreateResult,
  AuthCallbackMode,
  AuthCallbackResult,
  AuthCallbackService,
  AuthCallbackSession,
  AuthCallbackWaitInput,
  AuthCredentialWriteInput,
  AuthCredentialWriteResult,
  AuthDiagnostic,
  AuthFailureCode,
  AuthLoopbackInput,
  AuthLoopbackResult,
  AuthOpenBrowserResult,
  AuthPkceChallenge,
  AuthPromptTextInput,
  AuthPromptTextResult,
  AuthenticateOptions,
  AuthenticateResult,
  AuthenticatorContext,
  Authenticator,
} from '@happier-dev/plugin-sdk/connected-accounts';

export type { CloudConnectTargetStatus, CloudVendorKey };

export type ConnectTargetId = CatalogAgentId | string;

export type CloudConnectResult = Readonly<{
  vendorKey: CloudVendorKey | 'scm';
  oauth: unknown;
}>;

export type CloudConnectAuthenticateOptions = CloudConnectAuthenticateOptionsV1 & Readonly<{
  hostServices?: CloudConnectAuthenticateHostServicesV1;
}>;

export type CloudConnectAuthenticateHostServicesV1 = Readonly<{
  credentials?: Readonly<{
    write(input: CloudAuthCredentialWriteInputV1): Promise<CloudAuthCredentialWriteResultV1>;
  }>;
}>;

export function isCloudConnectAuthenticateResultV1(value: unknown): value is CloudConnectAuthenticateResultV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.ok === true) return true;
  return record.ok === false && typeof record.code === 'string';
}

export type CloudConnectTarget = Readonly<{
  id: ConnectTargetId;
  displayName: string;
  vendorDisplayName: string;
  vendorKey: CloudVendorKey | 'scm';
  /**
   * Whether this connect target is actively consumed by Happy (CLI/app) today.
   *
   * - wired: connecting has an effect (token is fetched/used by the product)
   * - experimental: token may be stored but not yet used everywhere
   */
  status: CloudConnectTargetStatus;
  authenticate: (opts?: CloudConnectAuthenticateOptions) => Promise<unknown>;
  postConnect?: (oauth: unknown) => void;
}>;
