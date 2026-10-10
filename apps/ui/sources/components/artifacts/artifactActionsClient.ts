import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ArtifactActionOutputSchemasV1, type ArtifactActionInputV1, type ArtifactActionResultV1, type ArtifactStorageUsageV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/**
 * The Artifacts surfaces reach document writes, history, restore and storage through the canonical `artifact.*`
 * Actions (ART-A1), never a second HTTP path: the UI is one more caller of the same spec the CLI,
 * MCP and agents use, with the same approval policy.
 */

export type ArtifactQuota = Readonly<{ budget: 'document' | 'account'; limitBytes: number; usedBytes: number }>;

export type ArtifactActionFailure = Readonly<{
    code: string;
    /** Present when a write was refused for an operator budget (`quota_exceeded`). */
    quota?: ArtifactQuota;
}>;

export type ArtifactActionOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: ArtifactActionFailure }>;

type SurfaceMutationActionId = 'artifact.create' | 'artifact.update' | 'artifact.revisions.restore' | 'artifact.delete';
type SurfaceActionId = 'artifact.revisions.list' | 'artifact.storage.usage' | SurfaceMutationActionId;

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The typed refusal of a failed Action result: its code and, for a budget, the named budget. */
export function readArtifactActionFailure(result: unknown): ArtifactActionFailure {
    const record = readRecord(result);
    const code = typeof record.errorCode === 'string' ? record.errorCode
        : typeof record.error === 'string' ? record.error : 'artifact_action_failed';
    if (code !== 'quota_exceeded') return { code };
    const details = readRecord(record.details);
    const budget = details.budget === 'document' || details.budget === 'account' ? details.budget : null;
    const limitBytes = typeof details.limitBytes === 'number' ? details.limitBytes : null;
    const usedBytes = typeof details.usedBytes === 'number' ? details.usedBytes : null;
    return budget !== null && limitBytes !== null && usedBytes !== null
        ? { code, quota: { budget, limitBytes, usedBytes } }
        : { code };
}

export function createArtifactActionsClient(scope: ServerAccountScope, execute = createFrontDoorActionExecute()) {
    const dispatch = (actionId: SurfaceActionId, input: unknown) => execute(actionId, input, {
        surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
    }).catch(() => null);
    const readOutcome = <Id extends SurfaceActionId>(actionId: Id, result: Awaited<ReturnType<typeof dispatch>>): ArtifactActionOutcome<ArtifactActionResultV1<Id>> => {
        if (!result) return { ok: false, failure: { code: 'artifact_action_failed' } };
        if (!result.ok) return { ok: false, failure: readArtifactActionFailure(result) };
        const parsed = ArtifactActionOutputSchemasV1[actionId].safeParse(result.result);
        return parsed.success
            ? { ok: true, value: parsed.data as ArtifactActionResultV1<Id> }
            : { ok: false, failure: { code: 'artifact_action_invalid_result' } };
    };
    const run = async <Id extends SurfaceActionId>(actionId: Id, input: unknown): Promise<ArtifactActionOutcome<ArtifactActionResultV1<Id>>> => {
        return readOutcome(actionId, await dispatch(actionId, input));
    };
    const runMutation = async <Id extends SurfaceMutationActionId>(actionId: Id, input: unknown) => {
        const result = await dispatch(actionId, input);
        const pending = result?.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
        return pending?.success
            ? { approvalId: pending.data.artifactId } as const
            : readOutcome(actionId, result);
    };
    return {
        createArtifact: (input: ArtifactActionInputV1<'artifact.create'>) => runMutation('artifact.create', input),
        updateArtifact: (input: ArtifactActionInputV1<'artifact.update'>) => runMutation('artifact.update', input),
        storageUsage: () => run('artifact.storage.usage', {}),
        listRevisions: (artifactId: string) => run('artifact.revisions.list', { artifactId }),
        restoreRevision: (input: Readonly<{ artifactId: string; bodyVersion: number; expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }> }>) =>
            runMutation('artifact.revisions.restore', input),
        deleteArtifact: (input: Readonly<{ artifactId: string; expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }> }>) =>
            runMutation('artifact.delete', input),
    };
}

export type ArtifactActionsClient = ReturnType<typeof createArtifactActionsClient>;

/** The Artifacts client for the active Account, or `null` while no Account is active. */
export function useArtifactActionsClient(): ArtifactActionsClient | null {
    const scope = useActiveServerAccountScope();
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;
    return React.useMemo(
        () => (serverId !== null && accountId !== null ? createArtifactActionsClient({ serverId, accountId }) : null),
        [serverId, accountId],
    );
}

/**
 * Read the active Account's authoritative usage on mount and whenever stored Artifact versions
 * change. Retain the last successful read during refresh; never carry it to another
 * Account. The server, not the retained local heads, accounts for storage and revision bytes.
 */
export function useArtifactStorageUsage(): ArtifactStorageUsageV1 | null {
    const client = useArtifactActionsClient();
    const storageRevision = getStorage()((state) => state.artifactsStorageRevision);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ client: ArtifactActionsClient; usage: ArtifactStorageUsageV1 }> | null>(null);
    React.useEffect(() => {
        if (!client) return;
        let current = true;
        void client.storageUsage().then((outcome) => { if (current && outcome.ok) setSnapshot({ client, usage: outcome.value }); });
        return () => { current = false; };
    }, [client, storageRevision]);
    return snapshot && snapshot.client === client ? snapshot.usage : null;
}
