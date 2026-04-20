import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { PermissionMode } from '@/api/types';
import { applyPermissionIntentFromMetadataIfNewer } from '@/agent/runtime/permissions/modeStateSync';

type MetadataListener = (...args: readonly unknown[]) => void;

type ClaudeLocalPermissionModeMetadataClient = Pick<SessionClientPort, 'getMetadataSnapshot'> &
    Partial<Pick<SessionClientPort, 'on' | 'off'>>;

export function createClaudeLocalPermissionModeMetadataSync(params: Readonly<{
    clientEmitter: ClaudeLocalPermissionModeMetadataClient;
    currentPermissionModeUpdatedAt: () => number;
    adoptFromMetadata: (params: { intent: PermissionMode; updatedAt: number }) => void;
}>): Readonly<{
    sync: () => void;
    attach: () => void;
    detach: () => void;
}> {
    const sync = (): void => {
        if (typeof params.clientEmitter.getMetadataSnapshot !== 'function') {
            return;
        }
        applyPermissionIntentFromMetadataIfNewer({
            metadata: params.clientEmitter.getMetadataSnapshot(),
            currentPermissionModeUpdatedAt: params.currentPermissionModeUpdatedAt(),
            apply: ({ intent, updatedAt }) => {
                params.adoptFromMetadata({ intent, updatedAt });
            },
        });
    };
    const onMetadataUpdated: MetadataListener = () => {
        sync();
    };

    return {
        sync,
        attach() {
            params.clientEmitter.on?.('metadata-updated', onMetadataUpdated);
        },
        detach() {
            params.clientEmitter.off?.('metadata-updated', onMetadataUpdated);
        },
    };
}
