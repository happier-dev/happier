export type RpcAckResponseEmitter = Readonly<{
    id: string;
    data?: Record<string, unknown>;
    timeout: (ms: number) => Readonly<{
        emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
    }>;
}>;

export type RpcTargetSelectionResult =
    | Readonly<{ type: "target"; target: RpcAckResponseEmitter; hadMultipleTargets: boolean }>
    | Readonly<{ type: "self-call" }>
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
    >;
}>;
