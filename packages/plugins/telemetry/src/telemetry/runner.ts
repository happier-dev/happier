import type { DeploymentTelemetryServiceV1 } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';
import type { DaemonDatabaseService } from '@happier-dev/plugin-sdk/storage';
import { localCaptureBackground, type createCaptureBackgroundOwner } from '../background.js';
import { startTelemetryCollector, type TelemetryCollector } from './collector.js';

export interface TelemetryCollectorRunnerContext {
    signal: AbortSignal;
    services: { storage: { daemon: DaemonDatabaseService }; deploymentTelemetry: DeploymentTelemetryServiceV1 };
}
export async function runTelemetryCollector(context: TelemetryCollectorRunnerContext,
    owner: ReturnType<typeof createCaptureBackgroundOwner> = localCaptureBackground): Promise<void> {
    if (context.signal.aborted) return;
    const deployedAppPort = context.services.deploymentTelemetry.deployedAppPort;
    const acquisition = await owner.acquireRuntime(context);
    let collector: TelemetryCollector | undefined;
    let withdrawEndpoint: (() => void) | undefined;
    try {
        collector = await startTelemetryCollector({ port: deployedAppPort ?? 0,
            host: deployedAppPort === undefined ? '127.0.0.1' : '0.0.0.0', runtime: acquisition.runtime,
            readAssignments: () => context.services.deploymentTelemetry.readAssignments({ signal: context.signal }),
            subscribeAssignmentsChanged: refresh => context.services.deploymentTelemetry.subscribeAssignmentsChanged(refresh),
            onEndpointChanged(endpoint) {
                withdrawEndpoint?.();
                withdrawEndpoint = endpoint === null ? undefined
                    : context.services.deploymentTelemetry.exposeEndpoint(() => endpoint);
            },
        });
        await new Promise<void>(resolve => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
    } catch (error) {
        if (!context.signal.aborted) throw error;
    } finally {
        withdrawEndpoint?.();
        withdrawEndpoint = undefined;
        try { await collector?.stop(); }
        finally { await acquisition.release(); }
    }
}
export const telemetryCollectorRunner: BackgroundServiceRunner = context => runTelemetryCollector(context);
