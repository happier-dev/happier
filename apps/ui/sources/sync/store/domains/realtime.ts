import type { StoreGet, StoreSet } from './_shared';
import {
  createAccountSettingsIdleStatus,
  type AccountSettingsSyncStatus,
} from '@/sync/domains/settings/accountSettingsSyncStatus';

export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type RealtimeMode = 'idle' | 'speaking';
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

export type EndpointConnectivityStatus = 'idle' | 'offline' | 'connecting' | 'online' | 'auth_failed' | 'shutting_down';

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
  realtimeStatus: RealtimeStatus;
  realtimeMode: RealtimeMode;
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
  setRealtimeStatus: (status: RealtimeStatus) => void;
  setRealtimeMode: (mode: RealtimeMode, immediate?: boolean) => void;
  clearRealtimeModeDebounce: () => void;
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
  get: StoreGet<S>;
}): RealtimeDomain {
  // Debounce timer for realtimeMode changes
  let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const REALTIME_MODE_DEBOUNCE_MS = 150;

  return {
    realtimeStatus: 'disconnected',
    realtimeMode: 'idle',
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
    setRealtimeStatus: (status) =>
      set((state) => ({
        ...state,
        realtimeStatus: status,
      })),
    setRealtimeMode: (mode, immediate) => {
      if (immediate) {
        // Clear any pending debounce and set immediately
        if (realtimeModeDebounceTimer) {
          clearTimeout(realtimeModeDebounceTimer);
          realtimeModeDebounceTimer = null;
        }
        set((state) => ({ ...state, realtimeMode: mode }));
      } else {
        // Debounce mode changes to avoid flickering
        if (realtimeModeDebounceTimer) {
          clearTimeout(realtimeModeDebounceTimer);
        }
        realtimeModeDebounceTimer = setTimeout(() => {
          realtimeModeDebounceTimer = null;
          set((state) => ({ ...state, realtimeMode: mode }));
        }, REALTIME_MODE_DEBOUNCE_MS);
      }
    },
    clearRealtimeModeDebounce: () => {
      if (realtimeModeDebounceTimer) {
        clearTimeout(realtimeModeDebounceTimer);
        realtimeModeDebounceTimer = null;
      }
    },
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
