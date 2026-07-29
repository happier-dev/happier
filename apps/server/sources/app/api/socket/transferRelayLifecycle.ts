type TransferRelayNamespace = 'machine-transfer-v1' | 'transfer-relay-v2';

export type TransferRelayLogicalIdentity = Readonly<{
  namespace: TransferRelayNamespace;
  userId: string;
  transferId: string;
  participants: readonly [string, string];
}>;

type TransferRelayLifecycleEntry = {
  readonly key: string;
  readonly scopeKey: string;
  readonly socketsByParticipant: Map<string, Set<string>>;
  readonly disconnectCallbacksByParticipant: Map<string, () => void>;
  bytes: number;
  blocked: boolean;
  accounted: boolean;
};

type TrackTransferFrameResult =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'active-limit-exceeded' }>
  | Readonly<{ kind: 'blocked' }>
  | Readonly<{ kind: 'max-bytes-exceeded' }>;

function buildLogicalTransferKey(identity: TransferRelayLogicalIdentity): string {
  const participants = [...identity.participants].sort();
  return JSON.stringify([
    identity.namespace,
    identity.userId,
    participants[0],
    participants[1],
    identity.transferId,
  ]);
}

function buildAccountingScopeKey(identity: TransferRelayLogicalIdentity, scopeKey: string): string {
  return JSON.stringify([identity.namespace, scopeKey]);
}

class TransferRelayLifecycle {
  private readonly entriesByKey = new Map<string, TransferRelayLifecycleEntry>();
  private readonly activeTransferKeysByScope = new Map<string, Set<string>>();
  private readonly transferKeysBySocket = new Map<string, Set<string>>();

  trackTransferFrame(params: Readonly<{
    identity: TransferRelayLogicalIdentity;
    scopeKey: string;
    participant: string;
    socketId: string;
    payloadSizeBytes: number;
    maxActiveTransfers: number;
    maxBytes: number | null;
    releaseActiveOnMaxBytes: boolean;
    onParticipantDisconnect: () => void;
  }>): TrackTransferFrameResult {
    const key = buildLogicalTransferKey(params.identity);
    let entry = this.entriesByKey.get(key);
    if (entry?.blocked === true) {
      return { kind: 'blocked' };
    }

    if (!entry) {
      const scopeKey = buildAccountingScopeKey(params.identity, params.scopeKey);
      const activeTransferKeys = this.activeTransferKeysByScope.get(scopeKey) ?? new Set<string>();
      if (activeTransferKeys.size >= params.maxActiveTransfers) {
        return { kind: 'active-limit-exceeded' };
      }

      entry = {
        key,
        scopeKey,
        socketsByParticipant: new Map(),
        disconnectCallbacksByParticipant: new Map(),
        bytes: 0,
        blocked: false,
        accounted: true,
      };
      this.entriesByKey.set(key, entry);
      activeTransferKeys.add(key);
      this.activeTransferKeysByScope.set(scopeKey, activeTransferKeys);
    }

    this.attachSocket(
      entry,
      params.participant,
      params.socketId,
      params.onParticipantDisconnect,
    );
    entry.bytes += params.payloadSizeBytes;

    if (params.maxBytes !== null && entry.bytes > params.maxBytes) {
      entry.blocked = true;
      if (params.releaseActiveOnMaxBytes) {
        this.releaseActiveAccounting(entry);
      }
      return { kind: 'max-bytes-exceeded' };
    }

    return { kind: 'accepted' };
  }

  observeTransferFrame(params: Readonly<{
    identity: TransferRelayLogicalIdentity;
    participant: string;
    socketId: string;
    onParticipantDisconnect: () => void;
  }>): void {
    const entry = this.entriesByKey.get(buildLogicalTransferKey(params.identity));
    if (!entry) {
      return;
    }
    this.attachSocket(
      entry,
      params.participant,
      params.socketId,
      params.onParticipantDisconnect,
    );
  }

  terminateTransfer(identity: TransferRelayLogicalIdentity): void {
    const entry = this.entriesByKey.get(buildLogicalTransferKey(identity));
    if (entry) {
      this.clearEntry(entry);
    }
  }

  disconnectSocket(socketId: string): void {
    const transferKeys = [...(this.transferKeysBySocket.get(socketId) ?? [])];
    for (const transferKey of transferKeys) {
      const entry = this.entriesByKey.get(transferKey);
      if (!entry) {
        continue;
      }

      let disconnectCallback: (() => void) | undefined;
      for (const [participant, socketIds] of entry.socketsByParticipant) {
        if (!socketIds.delete(socketId)) {
          continue;
        }
        if (socketIds.size === 0) {
          entry.socketsByParticipant.delete(participant);
          disconnectCallback = entry.disconnectCallbacksByParticipant.get(participant);
        }
      }

      if (!disconnectCallback) {
        continue;
      }

      const shouldEmitAbort = !entry.blocked;
      this.clearEntry(entry);
      if (shouldEmitAbort) {
        disconnectCallback();
      }
    }
    this.transferKeysBySocket.delete(socketId);
  }

  private attachSocket(
    entry: TransferRelayLifecycleEntry,
    participant: string,
    socketId: string,
    onParticipantDisconnect: () => void,
  ): void {
    const participantSockets = entry.socketsByParticipant.get(participant) ?? new Set<string>();
    participantSockets.add(socketId);
    entry.socketsByParticipant.set(participant, participantSockets);
    entry.disconnectCallbacksByParticipant.set(participant, onParticipantDisconnect);

    const socketTransferKeys = this.transferKeysBySocket.get(socketId) ?? new Set<string>();
    socketTransferKeys.add(entry.key);
    this.transferKeysBySocket.set(socketId, socketTransferKeys);
  }

  private releaseActiveAccounting(entry: TransferRelayLifecycleEntry): void {
    if (!entry.accounted) {
      return;
    }
    entry.accounted = false;
    const activeTransferKeys = this.activeTransferKeysByScope.get(entry.scopeKey);
    activeTransferKeys?.delete(entry.key);
    if (activeTransferKeys?.size === 0) {
      this.activeTransferKeysByScope.delete(entry.scopeKey);
    }
  }

  private clearEntry(entry: TransferRelayLifecycleEntry): void {
    this.entriesByKey.delete(entry.key);
    this.releaseActiveAccounting(entry);
    for (const socketIds of entry.socketsByParticipant.values()) {
      for (const socketId of socketIds) {
        const transferKeys = this.transferKeysBySocket.get(socketId);
        transferKeys?.delete(entry.key);
        if (transferKeys?.size === 0) {
          this.transferKeysBySocket.delete(socketId);
        }
      }
    }
    entry.socketsByParticipant.clear();
    entry.disconnectCallbacksByParticipant.clear();
  }
}

export const transferRelayLifecycle = new TransferRelayLifecycle();
