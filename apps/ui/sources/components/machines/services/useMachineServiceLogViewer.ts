import * as React from 'react';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { useLogViewerV1, type LogViewerControlsV1 } from '@happier-dev/forge-ci/ui';
import { isPluginUiResourceReadAuthorityLost } from '@happier-dev/plugin-ui/advanced';
import type { LogIndexV1 } from '@happier-dev/forge-ci/runtime';
import { useMachineServiceLogsResource } from '@/components/machines/resources/useMachineServiceLogsResource';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { buildMachineServiceLogIndex, type MachineServiceLogProjection } from './machineServiceLogIndex';
import { exportMachineServiceLogIndex } from './exportMachineServiceLogIndex';
import { useMachineServiceFirstLogRead, type MachineServiceFirstLogRead } from './useMachineServiceFirstLogRead';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

type LogsReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.logs' | 'deployments.logs' }>;
const RESOURCE_AUTHORITY_WITHDRAWN = Object.freeze({ kind: 'unavailable' as const, reason: 'admission_unavailable' as const });

/** Native acquisition stops at Action/Resource; Forge owns the sole log presentation model. */
export function useMachineServiceLogViewer(input: LogViewerControlsV1 & Readonly<{
    serverId: string; machineId: string; service: MachineServiceRowV1; active: boolean;
}>) {
    const canRead = input.service.capabilities.logs && input.service.generation !== null;
    const first = useMachineServiceFirstLogRead({ serverId: input.serverId, machineId: input.machineId,
        serviceId: input.service.serviceId, active: input.active && canRead,
        expectedGeneration: input.service.generation });
    const page = first.state.kind === 'read' && first.state.value.kind === 'page' ? first.state.value.page : null;
    const reference = React.useMemo<LogsReference | null>(() => page && input.service.generation !== null ? {
        hostRead: 'machines.services.logs', input: { serverId: input.serverId, machineId: input.machineId,
            serviceId: input.service.serviceId, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) },
        expectedGeneration: input.service.generation, sourceRevision: page.sourceRevision,
    } : null, [page, input.serverId, input.machineId, input.service.serviceId, input.service.generation]);
    const sourceKey = JSON.stringify([input.serverId, first.accountLifetime?.scope.accountId ?? null,
        input.machineId, input.service.serviceId, input.service.generation]);
    return useNativeLogViewer({ ...input, first: first.state, read: first.read, accountLifetime: first.accountLifetime,
        reference, sourceKey, active: input.active && canRead, fileName: `${input.service.name}.log` });
}

/**
 * One native log after its first page: the Account Resource follows it, the Forge model indexes and finds in it,
 * and last-known lines stay through a stale follow or a source change. A Machine service and a deployment step's
 * masked stage log both read through here; each supplies its own first read and follow reference.
 */
export function useNativeLogViewer(input: LogViewerControlsV1 & Readonly<{
    first: MachineServiceFirstLogRead; read: () => Promise<void>;
    accountLifetime: ServerAccountScopeLifetime | null; reference: LogsReference | null;
    sourceKey: string; active: boolean; fileName: string;
    /** False for a log that can no longer grow: it is read once and never followed. */
    followable?: boolean;
}>) {
    const followable = input.followable !== false;
    const [follow, setFollow] = React.useState(true);
    const { accountLifetime, reference, sourceKey } = input;
    const firstState = input.first;
    // The Resource hook must accept absent admission without creating a store or acquiring transport demand.
    const followed = useMachineServiceLogsResource({ accountLifetime, reference,
        active: input.active && followable, follow: follow && followable });
    const baseline = React.useRef<Readonly<{
        lifetime: NonNullable<typeof accountLifetime>; index: LogIndexV1; truncated: boolean; secretMasking: boolean;
    }> | null>(null);
    // The Resource owner already distinguishes withdrawn read authority from
    // offline/transport failures. Reuse that decision for the separate first page.
    const resourceAuthorityLost = followed !== null && isPluginUiResourceReadAuthorityLost({ ...followed, value: undefined });
    const authorityWithdrawal = resourceAuthorityLost ? RESOURCE_AUTHORITY_WITHDRAWN : null;
    const projection = React.useMemo((): MachineServiceLogProjection | null => {
        const continuation = followed?.value;
        if (authorityWithdrawal) {
            // Existing typed authority withdrawal also withdraws already-loaded bytes.
            return { kind: 'unavailable', reason: authorityWithdrawal.reason };
        }
        const previous = baseline.current?.lifetime === accountLifetime && accountLifetime?.isCurrent()
            && baseline.current.index.sourceKey === sourceKey ? baseline.current : null;
        if (firstState.kind === 'reading' && previous)
            return { kind: 'index', index: previous.index, truncated: previous.truncated, secretMasking: previous.secretMasking };
        return firstState.kind === 'read' ? buildMachineServiceLogIndex({
            sourceKey, first: firstState.value,
            followed: continuation?.kind === 'unavailable' ? followed?.lastGoodPage : continuation,
            baseline: previous?.index,
            // A follow reference with a cursor continues the first page; a tail reference replaces it.
            continues: reference?.input.cursor !== undefined,
        }) : null;
    }, [sourceKey, accountLifetime, firstState, followed?.value, followed?.lastGoodPage, authorityWithdrawal, reference]);
    const index = projection?.kind === 'index' || projection?.kind === 'sourceChanged' ? projection.index : null;
    const followUnavailable = followed?.value?.kind === 'unavailable' ? followed.value.reason : null;
    const stale = firstState.kind === 'reading' && index !== null || projection?.kind === 'sourceChanged'
        || followUnavailable !== null || followed?.error !== undefined
        || followed?.freshness === 'stale' || followed?.subscription === 'reconnecting';
    React.useEffect(() => {
        if (authorityWithdrawal || baseline.current?.lifetime !== accountLifetime || !accountLifetime?.isCurrent())
            baseline.current = null;
        if (index && accountLifetime?.isCurrent()) baseline.current = { lifetime: accountLifetime, index,
            truncated: projection?.kind === 'index' ? projection.truncated : baseline.current?.truncated ?? false,
            secretMasking: projection?.kind === 'index' ? projection.secretMasking : baseline.current?.secretMasking ?? false };
    }, [index, projection, accountLifetime, authorityWithdrawal]);
    const viewer = useLogViewerV1({ ...input, index, active: input.active,
        partialErrors: stale || projection?.kind === 'index' && projection.truncated });
    const clipboard = useClipboardWrite(accountLifetime?.scope,
        { enabled: input.active && index !== null });
    const latest = React.useRef({ sourceKey, index, accountLifetime, active: input.active, fileName: input.fileName });
    latest.current = { sourceKey, index, accountLifetime, active: input.active, fileName: input.fileName };
    const copyLoaded = React.useCallback(() => {
        const current = latest.current;
        if (!current.active || !current.index || !current.accountLifetime?.isCurrent()) return Promise.resolve(false);
        return clipboard(current.index.plainText);
    }, [clipboard]);
    const exportLoaded = React.useCallback(async (): Promise<'saved' | 'canceled' | 'failed'> => {
        const current = latest.current;
        const admitted = current.index;
        const lifetime = current.accountLifetime;
        if (!current.active || !admitted || !lifetime?.isCurrent()) return 'canceled';
        return exportMachineServiceLogIndex({ index: admitted, fileName: current.fileName, scope: lifetime.scope, isCurrent: () => {
            const present = latest.current;
            return lifetime.isCurrent() && present.accountLifetime === lifetime && present.active
                && present.sourceKey === current.sourceKey && present.index?.logId === admitted.logId;
        } });
    }, []);
    const read = input.read;
    React.useEffect(() => {
        if (input.active && firstState.kind === 'idle') void read();
    }, [input.active, firstState.kind, read]);
    const firstRead = authorityWithdrawal && firstState.kind === 'read'
        ? { ...firstState, value: authorityWithdrawal } : firstState;
    const followedRead = authorityWithdrawal && followed ? { ...followed, lastGoodPage: undefined } : followed;
    return { first: firstRead, readAgain: read, follow, setFollow, followed: followedRead, followUnavailable, stale,
        projection, index, viewer, copyLoaded, exportLoaded };
}
