import type { SocketRpcAnsweringClientCandidateV1 } from '@happier-dev/protocol/socketRpc';

export type RpcAckResponseEmitter = Readonly<{
    id: string;
    data?: Record<string, unknown>;
    timeout: (ms: number, ackLifetime?: Readonly<{ rejectOnDisconnect?: boolean; signal?: AbortSignal }>) => Readonly<{
        emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
    }>;
}>;

export type RpcTargetSelectionResult =
    | Readonly<{ type: "target"; target: RpcAckResponseEmitter; hadMultipleTargets: boolean; clientIds?: readonly string[]; clients?: readonly SocketRpcAnsweringClientCandidateV1[] }>
    | Readonly<{ type: "self-call" }>
    | Readonly<{ type: "ambiguous"; clientIds: readonly string[]; clients: readonly SocketRpcAnsweringClientCandidateV1[] }>
    | Readonly<{ type: "not-available" }>;

export type RpcForwardTargetGuard = Readonly<{
    filterTargets: (targets: RpcAckResponseEmitter[]) => Promise<RpcAckResponseEmitter[]>;
    runOperation: (params: Readonly<{
        target: RpcAckResponseEmitter;
        operation: () => Promise<unknown>;
        readLatestTarget: () => Promise<RpcAckResponseEmitter | null>;
    }>) => Promise<
        | Readonly<{ status: "current"; value: unknown }>
        | Readonly<{ status: "unavailable" }>
        /**
         * The guard proved a typed refusal rather than an absent target. The
         * forwarder answers with this exact envelope so the caller keeps the
         * recovery the decision owner stated.
         */
        | Readonly<{ status: "refused"; response: Readonly<{ ok: false; error: string; errorCode: string }> }>
    >;
}>;
