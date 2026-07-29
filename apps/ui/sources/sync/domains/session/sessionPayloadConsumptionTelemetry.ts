import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

type SessionPayloadFamily = 'presentation' | 'work-state';

export function recordSessionPayloadConsumptionTelemetry(params: Readonly<{
    family: SessionPayloadFamily;
    payload: unknown;
    itemCount: number;
    lineCount?: number;
}>): void {
    syncPerformanceTelemetry.countLazy(
        `ui.session.payload.consume.${params.family}`,
        () => {
            const serialized = JSON.stringify(params.payload);
            if (serialized === undefined) return undefined;
            return {
                payloadBytes: new TextEncoder().encode(serialized).byteLength,
                itemCount: params.itemCount,
                ...(params.lineCount === undefined ? {} : { lineCount: params.lineCount }),
            };
        },
    );
}
