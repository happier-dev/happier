import { useCallback, useEffect, useMemo, useState } from 'react';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1, type SavedSecretVaultQueryV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { PluginSecretSourceFailureV1Schema, type PluginSecretSourceFieldV1, type PluginSecretSourceFailureV1 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isTeamActionApprovalPendingError, runTeamAction } from '@/sync/ops/teams/teamActionClient';

export type SavedSecretVaultPickerState = Readonly<{
    status: 'idle' | 'loading' | 'empty' | 'ready' | 'unavailable';
    fields: readonly PluginSecretSourceFieldV1[];
    vaults?: readonly PluginSecretSourceFieldV1['vault'][];
    code?: string;
    repair?: PluginSecretSourceFailureV1['repair'];
}>;
const idle: SavedSecretVaultPickerState = Object.freeze({ status: 'idle', fields: [] });
const loading: SavedSecretVaultPickerState = Object.freeze({ status: 'loading', fields: [] });
type PickerResult = ReturnType<(typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1)['secrets.list']['parse']>;

/** Metadata is acquired only for an open picker and its explicit Machine/Account selection. */
export function useSavedSecretVaultPicker(input: Readonly<{
    scope: ServerAccountScope | null;
    source: SavedSecretVaultQueryV1 | null;
    active: boolean;
}>) {
    const { scope, source, active } = input;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const pluginId = source?.contribution.pluginId;
    const localId = source?.contribution.localId;
    const account = source?.account;
    const machineId = source?.machineId;
    const vaultId = source?.vaultId;
    const itemId = source?.itemId;
    const query = useMemo(() => pluginId && localId && account ? {
        contribution: { pluginId, localId }, account,
        ...(machineId ? { machineId } : {}), ...(vaultId ? { vaultId } : {}), ...(itemId ? { itemId } : {}),
    } : null, [pluginId, localId, account, machineId, vaultId, itemId]);
    const key = JSON.stringify([serverId, accountId, query]);
    const [refresh, setRefresh] = useState(0);
    const [record, setRecord] = useState<Readonly<{ key: string; state: SavedSecretVaultPickerState; approval?: ActionApprovalRegistration }>>({ key: '', state: idle });
    const reload = useCallback(() => setRefresh(value => value + 1), []);
    useEffect(() => {
        if (!active || !serverId || !accountId || !query) return;
        const controller = new AbortController();
        const publish = (state: SavedSecretVaultPickerState) => {
            if (!controller.signal.aborted) setRecord({ key, state });
        };
        setRecord(previous => ({ key, state: { status: 'loading', fields: previous.key === key ? previous.state.fields : [],
            vaults: previous.key === key ? previous.state.vaults : [] } }));
        const succeed = (result: PickerResult) => {
            const fields = result.fields ?? [];
            // Older acquire/list sources expose only fields; normalize those destinations here once.
            const vaults = result.vaults ?? [...new Map(fields.map(field => [field.vault.id, field.vault])).values()];
            publish({ status: fields.length || vaults.length ? 'ready' : 'empty', fields, vaults });
        };
        const fail = (code: string, details?: unknown) => {
            const repair = PluginSecretSourceFailureV1Schema.shape.repair.safeParse(
                details !== null && typeof details === 'object' && 'repair' in details ? details.repair : undefined);
            setRecord(previous => controller.signal.aborted ? previous : { key, state: { status: 'unavailable', code,
                fields: previous.key === key ? previous.state.fields : [],
                vaults: previous.key === key ? previous.state.vaults : [],
                ...(repair.success && repair.data ? { repair: repair.data } : {}) } });
        };
        void runTeamAction({ scope: { serverId, accountId }, actionId: 'secrets.list', input: { source: query },
            signal: controller.signal, parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.list'].parse(value),
            onApprovalSucceeded: succeed, onApprovalFailed: (code, failure) => fail(code, failure?.details),
        }).then(result => {
            if (result.kind === 'succeeded') succeed(result.value);
            else fail(result.failure.code ?? 'source_unavailable', result.failure.details);
        }).catch((error: unknown) => {
            if (controller.signal.aborted) return;
            if (isTeamActionApprovalPendingError(error)) setRecord(previous => ({ key,
                state: { status: 'loading', fields: previous.key === key ? previous.state.fields : [],
                    vaults: previous.key === key ? previous.state.vaults : [] }, approval: error.registration }));
            else fail('source_unavailable');
        });
        return () => controller.abort();
    }, [active, serverId, accountId, query, key, refresh]);
    const state = !active || !query ? idle : !serverId || !accountId
        ? { status: 'unavailable' as const, fields: [], code: 'target_unavailable' }
        : record.key === key ? record.state : loading;
    return { state, reload, approval: active && record.key === key ? record.approval : undefined };
}
