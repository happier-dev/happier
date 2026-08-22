import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readStoredCredentials } from '@/persistence';
import { createUsageObservationPublisher } from '@/usage/createUsageObservationPublisher';
import { logger } from '@/ui/logger';

export function createSessionClientUsageObservationPublisher(
    params: Readonly<{
        token: string;
        getSocket: () => { connected: boolean; emit: (event: 'usage-report', report: unknown) => void };
    }>,
) {
    return createUsageObservationPublisher({
        token: params.token,
        apiServerUrl: resolveServerHttpBaseUrl(),
        resolveToken: async () => (await readStoredCredentials())?.token ?? null,
        emitLegacyUsageReport: (report) => {
            const socket = params.getSocket();
            if (!socket.connected) {
                return;
            }
            socket.emit('usage-report', report);
        },
        onPublishError: (error) => {
            logger.debug('[SOCKET] Failed to publish usage observation (non-fatal)', serializeAxiosErrorForLog(error));
        },
    });
}
