import { ManagedServiceNativeLogResultV1Schema, type ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol/local/services/nativeLogsV1';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineServiceResource } from './useMachineServiceResource';

type LogsReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.logs' | 'deployments.logs' }>;
type Page = Extract<ManagedServiceNativeLogResultV1, { kind: 'page' }>;
type LogsProjection = Readonly<{ result: ManagedServiceNativeLogResultV1; lastGoodPage?: Page }>;
const LOG_PROJECTION = Object.freeze({
    decode(content: Readonly<{ bytes: Uint8Array }>, previous: LogsProjection | undefined): LogsProjection {
        const result = ManagedServiceNativeLogResultV1Schema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
        // Source changes stop continuation. Ordinary unavailability retains one
        // admitted finite page; authority-loss errors are retired by the store.
        const lastGoodPage = result.kind === 'page' ? result
            : result.kind === 'source-changed' ? undefined : previous?.lastGoodPage;
        return { result, ...(lastGoodPage ? { lastGoodPage } : {}) };
    },
});

/** Native Machine data binding. The existing Resource owner controls reads, follow and last-good state. */
type LogsInput = Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null;
    reference: LogsReference | null;
    active: boolean;
    follow: boolean;
}>;
function useLogsResource(input: LogsInput) {
    const snapshot = useMachineServiceResource({ ...input, projection: LOG_PROJECTION });
    return snapshot ? { ...snapshot, value: snapshot.value?.result, lastGoodPage: snapshot.value?.lastGoodPage } : null;
}
export function useMachineServiceLogsResource(input: LogsInput & Readonly<{
    accountLifetime: ServerAccountScopeLifetime; reference: LogsReference;
}>): NonNullable<ReturnType<typeof useLogsResource>>;
export function useMachineServiceLogsResource(input: LogsInput): ReturnType<typeof useLogsResource>;
export function useMachineServiceLogsResource(input: LogsInput): ReturnType<typeof useLogsResource> {
    return useLogsResource(input);
}
