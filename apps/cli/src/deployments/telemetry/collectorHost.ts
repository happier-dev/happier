import type { DeploymentTelemetryServiceV1 } from '@happier-dev/plugin-sdk';
import { DeploymentTelemetryAssignmentsV1Schema } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createDefaultPluginInstallationPublisherHeader, type CreatePluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';

export const DEPLOYED_TELEMETRY_PORT_ENV = 'HAPPIER_DEPLOYED_TELEMETRY_PORT';

/** The declared TCP listener belongs only to the deployed collector App. */
export function readDeployedTelemetryPort(environment: Readonly<Record<string, string | undefined>>): number | undefined {
    const declared = environment[DEPLOYED_TELEMETRY_PORT_ENV];
    if (declared === undefined) return undefined;
    const port = Number(declared);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${DEPLOYED_TELEMETRY_PORT_ENV} must declare a TCP port between 1 and 65535`);
    }
    return port;
}

export interface DeploymentTelemetryHostOptions {
    serverBaseUrl: string;
    token: string;
    machineId: string;
    /** Existing Account change feed; null means reconnect reconciliation. */
    subscribeMachineChanges(listener: (machineId: string | null) => void): () => void;
    onRefreshError(error: unknown): void;
    createPublisherHeader?: CreatePluginInstallationPublisherHeader;
    environment?: NodeJS.ProcessEnv;
}

/** One runtime endpoint publication, owned by the existing background invocation. */
export function createDeploymentTelemetryHost(options: DeploymentTelemetryHostOptions): Readonly<{
    bind(signal: AbortSignal): DeploymentTelemetryServiceV1;
    readEndpoint(): string | null;
}> {
    let readEndpoint: (() => string | null) | null = null;
    const path = `/v1/deployments/machines/${encodeURIComponent(options.machineId)}/telemetry-assignments`;
    return {
        readEndpoint: () => readEndpoint?.() ?? null,
        bind(signal) {
            function retain(dispose: () => void): () => void {
                if (signal.aborted) { dispose(); return () => {}; }
                let active = true;
                const release = () => {
                    if (!active) return;
                    active = false;
                    signal.removeEventListener('abort', release);
                    dispose();
                };
                signal.addEventListener('abort', release, { once: true });
                return release;
            }
            return {
                get deployedAppPort() {
                    return readDeployedTelemetryPort(options.environment ?? process.env);
                },
                async readAssignments(request = {}) {
                    signal.throwIfAborted();
                    const body = {};
                    const publisherHeader = await (options.createPublisherHeader ?? createDefaultPluginInstallationPublisherHeader)({ method: 'POST', path, body });
                    if (!publisherHeader) throw new Error('telemetry_assignment_publisher_proof_unavailable');
                    const response = await axios.post(`${options.serverBaseUrl}${path}`, body, {
                        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                            Authorization: `Bearer ${options.token}`,
                            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader },
                        signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
                    });
                    return DeploymentTelemetryAssignmentsV1Schema.parse(response.data).assignments;
                },
                subscribeAssignmentsChanged(refresh) {
                    signal.throwIfAborted();
                    return retain(options.subscribeMachineChanges(machineId => {
                        if (machineId === null || machineId === options.machineId) {
                            void refresh().catch(options.onRefreshError);
                        }
                    }));
                },
                exposeEndpoint(read) {
                    signal.throwIfAborted();
                    readEndpoint = read;
                    return retain(() => { if (readEndpoint === read) readEndpoint = null; });
                },
            };
        },
    };
}
