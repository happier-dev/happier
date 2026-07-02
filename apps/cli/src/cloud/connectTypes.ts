import type { CatalogAgentId } from '@/backends/types';
import type { CloudConnectTargetStatus, CloudVendorKey } from '@happier-dev/agents';
import type {
  CloudAuthCredentialWriteInputV1,
  CloudAuthCredentialWriteResultV1,
  CloudConnectAuthenticateOptionsV1,
  CloudConnectAuthenticateResultV1,
} from '@happier-dev/plugin-sdk';

export type {
  CloudAuthCallbackCreateInputV1,
  CloudAuthCallbackCreateResultV1,
  CloudAuthCallbackModeV1,
  CloudAuthCallbackResultV1,
  CloudAuthCallbackServiceV1,
  CloudAuthCallbackSessionV1,
  CloudAuthCallbackWaitInputV1,
  CloudAuthCredentialWriteInputV1,
  CloudAuthCredentialWriteResultV1,
  CloudAuthDiagnosticV1,
  CloudAuthFailureCodeV1,
  CloudAuthLoopbackInputV1,
  CloudAuthLoopbackResultV1,
  CloudAuthOpenBrowserResultV1,
  CloudAuthPkceChallengeV1,
  CloudAuthPromptTextInputV1,
  CloudAuthPromptTextResultV1,
  CloudConnectAuthenticateOptionsV1,
  CloudConnectAuthenticateResultV1,
  CloudCustomAuthenticatorContextV1,
  CloudCustomAuthenticatorV1,
} from '@happier-dev/plugin-sdk';

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
