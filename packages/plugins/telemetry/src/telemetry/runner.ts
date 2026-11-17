import type { DeploymentTelemetryServiceV1 } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';
import type { DaemonDatabaseService } from '@happier-dev/plugin-sdk/storage';
import { localCaptureBackground, type createCaptureBackgroundOwner } from '../background.js';
import { startTelemetryCollector, type TelemetryCollector } from './collector.js';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { startCollectorIssueProjection } from '../exceptions/collectorIssues.js';
import type { ExceptionIssueTransition } from '../exceptions/issueWriter.js';
import { createExceptionIssuePublisher } from '../exceptions/publication.js';

export interface TelemetryCollectorRunnerContext {
    signal: AbortSignal;
    services: { storage: { daemon: DaemonDatabaseService }; deploymentTelemetry: DeploymentTelemetryServiceV1 };
    /** The full background context; native exception issues use its Account storage and publication services. */
    issues?: Readonly<{ account: PluginAccountStorageScope | undefined; publish: (transition: ExceptionIssueTransition) => Promise<void> }>;
}
export async function runTelemetryCollector(context: TelemetryCollectorRunnerContext,
    owner: ReturnType<typeof createCaptureBackgroundOwner> = localCaptureBackground): Promise<void> {
    if (context.signal.aborted) return;
    const deployedAppPort = context.services.deploymentTelemetry.deployedAppPort;
    const acquisition = await owner.acquireRuntime(context);
    let collector: TelemetryCollector | undefined;
    let withdrawEndpoint: (() => void) | undefined;
    let teams = new Map<string, string>();
    const issues = startCollectorIssueProjection({ account: context.issues?.account, runtime: acquisition.runtime,
        publish: context.issues?.publish ?? (async () => {}), teamOf: environmentId => teams.get(environmentId) });
    try {
        collector = await startTelemetryCollector({ port: deployedAppPort ?? 0,
            host: deployedAppPort === undefined ? '127.0.0.1' : '0.0.0.0', runtime: acquisition.runtime,
            readAssignments: async () => {
                const assignments = await context.services.deploymentTelemetry.readAssignments({ signal: context.signal });
                teams = new Map(assignments.flatMap(assignment => assignment.teamId ? [[assignment.environmentId, assignment.teamId] as const] : []));
                return assignments;
            },
            subscribeAssignmentsChanged: refresh => context.services.deploymentTelemetry.subscribeAssignmentsChanged(refresh),
            onExceptionsCommitted: (environment, fingerprints) => issues.observe(environment, fingerprints),
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
        finally { issues.stop(); await acquisition.release(); }
    }
}
export const telemetryCollectorRunner: BackgroundServiceRunner = context => runTelemetryCollector({ ...context,
    issues: { account: context.services.storage.account, publish: createExceptionIssuePublisher(context) } });
