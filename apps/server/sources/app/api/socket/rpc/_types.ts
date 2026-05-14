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
