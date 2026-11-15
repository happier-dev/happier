import type { SessionClientTransport } from './transport/sessionClientTransport';
import type { UsageEventIngestRequest } from '@happier-dev/protocol';
import { createUsageObservationPublisher } from '@/usage/createUsageObservationPublisher';
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { createNativeUsageProjectResolver } from '@/usage/collector/nativeUsageProjectResolver';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';

function readDimension(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createSessionClientUsageObservationPublisher(
    params: Readonly<{
        token: string;
        transport: SessionClientTransport;
        /** The admitted Session socket's acknowledged `usage-event` emit; null while it is not connected. */
        emitUsageEvent: (request: UsageEventIngestRequest, signal?: AbortSignal) => Promise<unknown> | null;
        getSessionMetadata?: () => unknown;
        /** Captured owner authority only; restricted Session runners cannot read Account rows. */
        projectContext?: Readonly<{
            machineId: string;
            deviceLocalSecretKeyFile: string;
            signal: AbortSignal;
            readCredentials(): Promise<StoredCredentials | null>;
        }>;
    }>,
) {
    const publisher = createUsageObservationPublisher({
        token: params.token,
        apiServerUrl: params.transport.serverUrl,
        ...(params.transport.resolveToken ? { resolveToken: params.transport.resolveToken } : {}),
        emitUsageEvent: params.emitUsageEvent,
    });
    // One project resolver per Session client (its storage and authority do not change per publish).
    let projectResolver: Promise<ReturnType<typeof createNativeUsageProjectResolver>> | null = null;
    const readProjectResolver = (projectContext: NonNullable<typeof params.projectContext>, accountId: string) => {
        projectResolver ??= readOrCreateDeviceLocalSecretStorage({ path: projectContext.deviceLocalSecretKeyFile })
            .then(storage => createNativeUsageProjectResolver({
                authority: { serverId: params.transport.serverId, accountId, machineId: projectContext.machineId },
                serverHttpBaseUrl: params.transport.serverUrl, storage, readCredentials: projectContext.readCredentials,
                sessionCustody: {
                    serverId: params.transport.serverId, accountId, serverHttpBaseUrl: params.transport.serverUrl,
                    isCurrent: async () => {
                        const credentials = await projectContext.readCredentials();
                        return !projectContext.signal.aborted && credentials !== null
                            && readAccountIdFromToken(credentials.token) === accountId;
                    },
                },
            }));
        // A failed storage read is not retained: the next publish retries it.
        projectResolver.catch(() => { projectResolver = null; });
        return projectResolver;
    };
    return {
        async publish(input: Parameters<typeof publisher.publish>[0]) {
            const rawMetadata = params.getSessionMetadata?.();
            const metadata = rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
                ? rawMetadata as Record<string, unknown>
                : {};
            const binding = readSessionProviderBindingMetadataV1(metadata);
            const observedAt = input.observedAt ?? Date.now();
            let projectKey = input.projectKey === undefined ? readDimension(metadata.projectId) : input.projectKey;
            let workspaceId = input.workspaceId === undefined ? readDimension(metadata.workspaceId) : input.workspaceId;
            const projectContext = params.projectContext;
            const accountId = readAccountIdFromToken(params.token);
            const rootPath = readDimension(metadata.path);
            if (projectKey == null && workspaceId == null && input.projectKey === undefined && input.workspaceId === undefined
                && projectContext && accountId && rootPath && metadata.machineId === projectContext.machineId) {
                try {
                    const resolveProject = await readProjectResolver(projectContext, accountId);
                    const root = resolveSessionWorkspaceRootForMachine({ metadata, machineId: projectContext.machineId, candidatePath: rootPath });
                    const project = await resolveProject({ rootPath: root.machinePath }, projectContext.signal);
                    projectKey = project.projectKey;
                    workspaceId = project.workspaceId ?? null;
                } catch {
                    // Accounting remains valid without Project evidence. Never substitute
                    // another Account, infer a containing checkout, or disclose its root.
                    logger.debug('[USAGE] Session Project attribution unavailable');
                }
            }
            const accounting = input.metadata?.usageAccounting;
            const observationMetadata = { ...input.metadata };
            // Preserve current binding dimensions, not Agent-supplied guesses. These
            // metadata dimensions alone do not prove a delayed response's source.
            delete observationMetadata.providerId;
            delete observationMetadata.providerConnectionId;
            delete observationMetadata.usageAttribution;
            return publisher.publish({
                ...input,
                signal: input.signal ?? projectContext?.signal,
                observedAt,
                machineId: input.machineId === undefined ? readDimension(metadata.machineId) : input.machineId,
                projectKey,
                workspaceId,
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
