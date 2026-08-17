import type { StoreSet } from './_shared';
import {
  createAccountSettingsIdleStatus,
  type AccountSettingsSyncStatus,
} from '@/sync/domains/settings/accountSettingsSyncStatus';

export type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SyncError = {
  message: string;
  retryable: boolean;
  kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
  at: number;
  serverId?: string;
  failuresCount?: number;
  nextRetryAt?: number;
} | null;

export type NativeUpdateStatus = { available: boolean; updateUrl?: string } | null;

/**
 * The supervisor's `shutting_down` teardown phase is deliberately absent: it describes what WE are doing, not the
 * server, and it is resolved away by `bindManagedConnectionStateToRealtimeStore` before it can reach a connection
 * indicator. Omitting it here makes that invariant compiler-enforced rather than conventional.
 */
export type EndpointConnectivityStatus = 'idle' | 'offline' | 'connecting' | 'online' | 'auth_failed';

export type EndpointConnectivitySnapshot = Readonly<{
  status: EndpointConnectivityStatus;
  reason: string | null;
  attempt: number;
  nextRetryAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastErrorMessage: string | null;
}>;

export type RealtimeDomain = {
  socketStatus: SocketStatus;
  socketLastConnectedAt: number | null;
  socketLastDisconnectedAt: number | null;
  socketLastError: string | null;
  socketLastErrorAt: number | null;
  syncError: SyncError;
  accountSettingsSyncStatus: AccountSettingsSyncStatus;
  lastSyncAt: number | null;
  endpointStatus: EndpointConnectivityStatus;
  endpointReason: string | null;
  endpointAttempt: number;
  endpointNextRetryAt: number | null;
  endpointLastConnectedAt: number | null;
  endpointLastDisconnectedAt: number | null;
  endpointLastErrorMessage: string | null;
  nativeUpdateStatus: NativeUpdateStatus;
  applyNativeUpdateStatus: (status: NativeUpdateStatus) => void;
  setSocketStatus: (status: SocketStatus) => void;
  setSocketError: (message: string | null) => void;
  setSyncError: (error: SyncError) => void;
  clearSyncError: () => void;
  setAccountSettingsSyncStatus: (status: AccountSettingsSyncStatus) => void;
  resetAccountSettingsSyncStatus: () => void;
  setLastSyncAt: (ts: number) => void;
  setEndpointConnectivity: (snapshot: EndpointConnectivitySnapshot) => void;
  resetEndpointConnectivity: () => void;
};

export function createRealtimeDomain<S extends RealtimeDomain>({
  set,
}: {
  set: StoreSet<S>;
}): RealtimeDomain {
  return {
    socketStatus: 'disconnected',
    socketLastConnectedAt: null,
    socketLastDisconnectedAt: null,
    socketLastError: null,
    socketLastErrorAt: null,
    syncError: null,
    accountSettingsSyncStatus: createAccountSettingsIdleStatus(),
    lastSyncAt: null,
    endpointStatus: 'idle',
    endpointReason: null,
    endpointAttempt: 0,
    endpointNextRetryAt: null,
    endpointLastConnectedAt: null,
    endpointLastDisconnectedAt: null,
    endpointLastErrorMessage: null,
    nativeUpdateStatus: null,
    applyNativeUpdateStatus: (status) =>
      set((state) => ({
        ...state,
        nativeUpdateStatus: status,
      })),
    setSocketStatus: (status) =>
      set((state) => {
        const now = Date.now();
        const updates: Partial<RealtimeDomain> = { socketStatus: status };

        // Update timestamp based on status
        if (status === 'connected') {
          updates.socketLastConnectedAt = now;
          updates.socketLastError = null;
          updates.socketLastErrorAt = null;
        } else if (status === 'disconnected' || status === 'error') {
          updates.socketLastDisconnectedAt = now;
        }

        return {
          ...state,
          ...updates,
        };
      }),
    setSocketError: (message) =>
      set((state) => {
        if (!message) {
          return {
            ...state,
            socketLastError: null,
            socketLastErrorAt: null,
          };
        }
        return {
          ...state,
          socketLastError: message,
          socketLastErrorAt: Date.now(),
        };
      }),
    setSyncError: (error) => set((state) => ({ ...state, syncError: error })),
    clearSyncError: () => set((state) => ({ ...state, syncError: null })),
    setAccountSettingsSyncStatus: (status) => set((state) => ({ ...state, accountSettingsSyncStatus: status })),
    resetAccountSettingsSyncStatus: () => set((state) => ({ ...state, accountSettingsSyncStatus: createAccountSettingsIdleStatus() })),
    setLastSyncAt: (ts) => set((state) => ({ ...state, lastSyncAt: ts })),
    setEndpointConnectivity: (snapshot) => set((state) => ({
      ...state,
      endpointStatus: snapshot.status,
      endpointReason: snapshot.reason,
      endpointAttempt: snapshot.attempt,
      endpointNextRetryAt: snapshot.nextRetryAt,
      endpointLastConnectedAt: snapshot.lastConnectedAt,
      endpointLastDisconnectedAt: snapshot.lastDisconnectedAt,
      endpointLastErrorMessage: snapshot.lastErrorMessage,
    })),
    resetEndpointConnectivity: () => set((state) => ({
      ...state,
      endpointStatus: 'idle',
      endpointReason: null,
      endpointAttempt: 0,
      endpointNextRetryAt: null,
      endpointLastConnectedAt: null,
      endpointLastDisconnectedAt: null,
      endpointLastErrorMessage: null,
    })),
  };
}
