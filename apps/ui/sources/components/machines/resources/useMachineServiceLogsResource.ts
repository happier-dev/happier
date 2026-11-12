import { ManagedServiceNativeLogResultV1Schema, type ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol/local/services/nativeLogsV1';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useMachineServiceResource } from './useMachineServiceResource';

type LogsReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.logs' | 'deployments.logs' }>;
type Page = Extract<ManagedServiceNativeLogResultV1, { kind: 'page' }>;
type LogsProjection = Readonly<{
    result: ManagedServiceNativeLogResultV1;
    lastGoodPage?: Page;
    /** Only this admitted Resource view remembers identities; they assert no provider history. */
    rowIds?: Set<string>;
}>;
const LOG_PROJECTION = Object.freeze({
    decode(content: Readonly<{ bytes: Uint8Array }>, previous: LogsProjection | undefined,
        source: 'read' | 'pages'): LogsProjection {
        const result = ManagedServiceNativeLogResultV1Schema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
        if (result.kind === 'source-changed') return { result };
        if (result.kind === 'unavailable') return { ...previous, result };
        const prior = source === 'pages' ? previous?.lastGoodPage : undefined;
        if (prior && prior.page.sourceRevision !== result.page.sourceRevision)
            return { result: { kind: 'source-changed', sourceRevision: result.page.sourceRevision } };
        const rowIds = prior ? previous?.rowIds ?? new Set<string>() : new Set<string>();
        const { rowId, ...page } = result.page;
        if (previous && prior && rowId && rowIds.has(rowId))
            return previous.result.kind === 'page' ? previous : { ...previous, result: prior };
        if (rowId) rowIds.add(rowId);
        const lastGoodPage: Page = { kind: 'page', page: { ...page,
            text: (prior?.page.text ?? '') + page.text,
            truncated: page.truncated || prior?.page.truncated === true,
            ...(page.secretMasking === 'incomplete' || prior?.page.secretMasking === 'incomplete'
                ? { secretMasking: 'incomplete' as const } : {}),
        } };
        return { result: lastGoodPage, lastGoodPage, rowIds };
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
