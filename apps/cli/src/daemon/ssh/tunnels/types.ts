import type {
  SshTunnelEnsureRequest,
  SshTunnelHealth,
  SshTunnelLease,
  SshTunnelPurpose,
  SshTunnelSnapshot,
  SshTunnelStatus,
} from '@happier-dev/protocol';
import type {
  CloseOpenSshLocalPortForwardRequest,
  OpenSshLocalPortForwardHandle,
  OpenSshLocalPortForwardRequest,
} from '@happier-dev/cli-common/ssh';

export type {
  SshTunnelEnsureRequest,
  SshTunnelHealth,
  SshTunnelLease,
  SshTunnelPurpose,
  SshTunnelSnapshot,
  SshTunnelStatus,
};

export type SshTunnelRegistryEntry = Readonly<{
  tunnelKey: string;
  controlPath: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  ownerPid: number;
  createdAt: string;
  lastProbeAt: string;
  purpose: SshTunnelPurpose;
  remoteHostId?: string;
  httpBaseUrl: string;
  wsBaseUrl?: string;
  sshTarget?: string;
  sshPort?: number;
  sshConfigFile?: string;
  knownHostsPath?: string;
}>;

export type SshTunnelRegistry = Readonly<{
  read: () => Promise<readonly SshTunnelRegistryEntry[]>;
  write: (entries: readonly SshTunnelRegistryEntry[]) => Promise<void>;
}>;

export type SshTunnelForwardHandle = OpenSshLocalPortForwardHandle;
export type SshTunnelOpenForward = (
  request: OpenSshLocalPortForwardRequest,
) => SshTunnelForwardHandle | Promise<SshTunnelForwardHandle>;
export type SshTunnelCloseForward = (
  request: Partial<CloseOpenSshLocalPortForwardRequest> & Readonly<{ controlPath: string }>,
) => void | Promise<void>;

export type SshTunnelSupervisor = Readonly<{
  ensureTunnel: (request: SshTunnelEnsureRequest) => Promise<SshTunnelLease>;
  listTunnels: () => Promise<readonly SshTunnelSnapshot[]>;
  probeTunnel: (tunnelKey: string) => Promise<SshTunnelHealth>;
  releaseTunnel: (leaseId: string) => Promise<void>;
  stopTunnel: (tunnelKey: string) => Promise<void>;
  stopAllTunnels: () => Promise<void>;
  adoptPersistedTunnels: () => Promise<void>;
}>;
