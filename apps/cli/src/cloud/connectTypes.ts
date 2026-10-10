import type { CatalogAgentId } from '@/backends/types';
import type { CloudConnectTargetStatus, CloudVendorKey } from '@happier-dev/agents';

export type { CloudConnectTargetStatus, CloudVendorKey };

export type ConnectedAccountVendorKey = CloudVendorKey | 'github';

export type ConnectTargetId = CatalogAgentId | 'github';

export type CloudConnectResult = Readonly<{
  vendorKey: ConnectedAccountVendorKey;
  oauth: unknown;
}>;

export type CloudConnectAuthenticateOptions = Readonly<{
  projectId?: string;
  paste?: boolean;
  device?: boolean;
  noOpen?: boolean;
  timeoutSeconds?: number;
}>;

export type CloudConnectImportedCredentials = Readonly<{
  oauth: unknown;
  requiresBrowserReauthorization: boolean;
}>;

export type CloudConnectTarget = Readonly<{
  id: ConnectTargetId;
  displayName: string;
  vendorDisplayName: string;
  vendorKey: ConnectedAccountVendorKey;
  /**
   * Whether this connect target is actively consumed by Happy (CLI/app) today.
   *
   * - wired: connecting has an effect (token is fetched/used by the product)
   * - experimental: token may be stored but not yet used everywhere
   */
  status: CloudConnectTargetStatus;
  requireSameProviderAccount?: boolean;
  authenticate: (opts?: CloudConnectAuthenticateOptions) => Promise<unknown>;
  importCredentials?: (opts: Readonly<{ source: 'acp' | 'cli'; projectId?: string; signal?: AbortSignal }>) => Promise<CloudConnectImportedCredentials>;
  postConnect?: (oauth: unknown) => void;
}>;
