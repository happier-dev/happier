export async function socketEmitWithAckFallback<TAck>(params: {
    emitWithAck: (event: string, payload: any, opts?: { timeoutMs?: number }) => Promise<TAck>;
    send: (event: string, payload: any) => void;
    event: string;
    payload: any;
    timeoutMs: number;
    onNoAck: () => void;
}): Promise<TAck | null> {
    const ack: TAck | null = await (async () => {
        try {
            return await params.emitWithAck(params.event, params.payload, { timeoutMs: params.timeoutMs });
        } catch {
            return null;
        }
    })();

    if (!ack || typeof ack !== 'object') {
        params.send(params.event, params.payload);
        params.onNoAck();
        return null;
    }

    return ack;
}

