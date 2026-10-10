import type { SessionClientTransport } from './transport/sessionClientTransport';
import { createUsageObservationPublisher } from '@/usage/createUsageObservationPublisher';
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';

function readDimension(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createSessionClientUsageObservationPublisher(
    params: Readonly<{
        token: string;
        transport: SessionClientTransport;
        getSocket: () => { connected: boolean; emit: (event: 'usage-report', report: unknown) => void };
        getSessionMetadata?: () => unknown;
    }>,
) {
    const publisher = createUsageObservationPublisher({
        token: params.token,
        apiServerUrl: params.transport.serverUrl,
        ...(params.transport.resolveToken ? { resolveToken: params.transport.resolveToken } : {}),
        emitLegacyUsageReport: (report) => {
            const socket = params.getSocket();
            if (!socket.connected) {
                return false;
            }
            socket.emit('usage-report', report);
            return true;
        },
    });
    return {
        publish(input: Parameters<typeof publisher.publish>[0]) {
            const rawMetadata = params.getSessionMetadata?.();
            const metadata = rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
                ? rawMetadata as Record<string, unknown>
                : {};
            const binding = readSessionProviderBindingMetadataV1(metadata);
            const observedAt = input.observedAt ?? Date.now();
            const accounting = input.metadata?.usageAccounting;
            const observationMetadata = { ...input.metadata };
            // Preserve current binding dimensions, not Agent-supplied guesses. These
            // metadata dimensions alone do not prove a delayed response's source.
            delete observationMetadata.providerId;
            delete observationMetadata.providerConnectionId;
            return publisher.publish({
                ...input,
                observedAt,
                machineId: input.machineId === undefined ? readDimension(metadata.machineId) : input.machineId,
                projectKey: input.projectKey === undefined ? readDimension(metadata.projectId) : input.projectKey,
                workspaceId: input.workspaceId === undefined ? readDimension(metadata.workspaceId) : input.workspaceId,
                metadata: {
                    ...observationMetadata,
                    ...(binding && binding.model?.id === input.observation.modelId ? {
                        ...(binding.contributionKey ? { providerId: binding.contributionKey } : {}),
                        providerConnectionId: binding.connectionId,
                    } : {}),
                    usageAccounting: {
                        path: 'runtime',
                        status: 'unknown',
                        asOfMs: observedAt,
                        ...(accounting && typeof accounting === 'object' && !Array.isArray(accounting) ? accounting : {}),
                    },
                },
            });
        },
    };
}
