import type {
    AndroidSimulatorAdapterHealthV1,
    IosSimulatorAdapterHealthV1,
} from '@happier-dev/protocol';

export type SimulatorPlatformHealthReader = Readonly<{
    health(): Promise<IosSimulatorAdapterHealthV1 | AndroidSimulatorAdapterHealthV1>;
}>;

export function createSimulatorPlatformDiagnosticsReader(
    adapters: readonly SimulatorPlatformHealthReader[],
): () => Promise<readonly Record<string, unknown>[]> {
    return async () => {
        const healthResults = await Promise.all(adapters.map((adapter) => adapter.health()));
        return healthResults.flatMap((health) => {
            if (health.status === 'available') return [];
            return [{
                platform: health.platform,
                status: health.status,
                severity: 'error',
                reasonCode: health.reasonCode,
                diagnostics: health.diagnostics,
            }];
        });
    };
}
