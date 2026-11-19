import type { DeploymentTelemetryServiceV1 } from '@happier-dev/plugin-sdk';
import { DeploymentTelemetryAssignmentsV1Schema } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createDefaultPluginInstallationPublisherHeader, type CreatePluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import { createCollectorDomainBridges, type CollectorDomainNative, type InstalledCollectorCaddy } from './collectorDomainBridge';

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
    readInstalledCollectorCaddy?: (signal: AbortSignal) => Promise<InstalledCollectorCaddy | null>;
}

/** One runtime endpoint publication, owned by the existing background invocation. */
export function createDeploymentTelemetryHost(options: DeploymentTelemetryHostOptions): Readonly<{
    bind(signal: AbortSignal): DeploymentTelemetryServiceV1;
    readEndpoint(): string | null;
    acquireDomainEndpoint(input: CollectorDomainNative & Readonly<{ networkId: string }>): ReturnType<ReturnType<typeof createCollectorDomainBridges>['acquire']>;
    restoreDomainEndpoints(): Promise<void>;
    closeDomainEndpoints(): Promise<void>;
}> {
    let readEndpoint: (() => string | null) | null = null;
    const domains = createCollectorDomainBridges({ machineId: options.machineId, readEndpoint: () => readEndpoint?.() ?? null,
        readInstalledCaddy: options.readInstalledCollectorCaddy });
    const path = `/v1/deployments/machines/${encodeURIComponent(options.machineId)}/telemetry-assignments`;
    return {
        readEndpoint: () => readEndpoint?.() ?? null,
        acquireDomainEndpoint: domains.acquire,
        restoreDomainEndpoints: domains.restore,
        closeDomainEndpoints: domains.close,
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
                    const receiver = new AbortController();
                    readEndpoint = read;
                    domains.publish(AbortSignal.any([signal, receiver.signal]));
                    void domains.restore().catch(error => { if (!receiver.signal.aborted && !signal.aborted) options.onRefreshError(error); });
                    return retain(() => {
                        receiver.abort();
                        if (readEndpoint === read) readEndpoint = null;
                        void domains.close().catch(options.onRefreshError);
                    });
                },
            };
        },
    };
}
