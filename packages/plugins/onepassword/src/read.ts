import type { PluginSecretSourceAcquisitionV1, PluginSecretSourceRequestV1,
    PluginSecretSourceFieldV1, PluginSecretSourceListRequestV1, PluginSecretSourceListResultV1,
    PluginSecretSourceStoreRequestV1, PluginSecretSourceStoreResultV1 } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

type OnePasswordNative = Readonly<{ exec: Pick<ExecService, 'run'>; serviceAccountToken?: string }>;

/** Captured native output stays private; neither error messages nor values escape metadata calls. */
async function runOnePassword(
    args: readonly string[], native: OnePasswordNative,
    signal: AbortSignal,
    options?: Readonly<{ stdin?: Uint8Array; write?: boolean }>,
): Promise<PluginSecretSourceAcquisitionV1> {
    if (signal.aborted) return { ok: false, code: 'cancelled' };
    try {
        const result = await native.exec.run({
            executable: { kind: 'systemTool', id: 'op' },
            args,
            env: native.serviceAccountToken === undefined ? {} : { OP_SERVICE_ACCOUNT_TOKEN: native.serviceAccountToken },
            ...(options?.stdin ? { stdin: options.stdin } : {}),
        }, { signal, outputDelivery: 'captured' });
        if (signal.aborted || result.termination.requestedBy.kind === 'abort') return { ok: false, code: 'cancelled' };
        if (result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0 && !result.stdoutTruncated) {
            return { ok: true, value: new TextDecoder().decode(result.stdout) };
        }
        const diagnostic = new TextDecoder().decode(result.stderr).toLowerCase();
        if (/denied|declined/.test(diagnostic)) return { ok: false, code: 'access_denied', repair: 'unlock' };
        if (/locked|not signed in|sign in|authentication/.test(diagnostic)) return { ok: false, code: 'authentication_required', repair: 'unlock' };
        if (/not found|could not find/.test(diagnostic)) return { ok: false, code: 'not_found', repair: 'configure' };
        return { ok: false, code: 'acquisition_failed', ...(options?.write ? {} : { repair: 'retry' as const }) };
    } catch (error) {
        if (signal.aborted) return { ok: false, code: 'cancelled' };
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'ENOENT' || code === 'plugin_exec_system_tool_unavailable' || code === 'plugin_system_tool_unavailable') {
            return { ok: false, code: 'native_unavailable', repair: 'install' };
        }
        return { ok: false, code: 'acquisition_failed', ...(options?.write ? {} : { repair: 'retry' as const }) };
    }
}

export async function readOnePasswordField(input: PluginSecretSourceRequestV1, native: OnePasswordNative,
    signal: AbortSignal): Promise<PluginSecretSourceAcquisitionV1> {
    if (signal.aborted) return { ok: false, code: 'cancelled' };
    if (!input.reference.startsWith('op://')) return { ok: false, code: 'not_found', repair: 'configure' };
    return runOnePassword(['read', input.reference, '--account', input.account, '--no-newline'], native, signal);
}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native object');
    return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid native identity');
    return value;
}
function label(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback; }

/** 1Password CLI 2 item JSON: explicitly project identities, labels and types, never value bags. */
export async function listOnePasswordFields(input: PluginSecretSourceListRequestV1, native: OnePasswordNative,
    signal: AbortSignal): Promise<PluginSecretSourceListResultV1> {
    if (signal.aborted) return { ok: false, code: 'cancelled' };
    try {
        const listedVaults = await runOnePassword(['vault', 'list', '--account', input.account, '--format', 'json'], native, signal);
        if (!listedVaults.ok) return listedVaults;
        const nativeVaults: unknown = JSON.parse(listedVaults.value);
        if (!Array.isArray(nativeVaults)) throw new Error('Invalid native vaults');
        const vaults = nativeVaults.map(candidate => {
            const vault = record(candidate);
            const id = identifier(vault.id);
            return { id, name: label(vault.name, id) };
        }).filter(vault => !input.vaultId || vault.id === input.vaultId);
        let items: readonly unknown[];
        if (input.itemId) {
            items = [{ id: input.itemId }];
        } else {
            const listed = await runOnePassword(['item', 'list', '--account', input.account,
                ...(input.vaultId ? ['--vault', input.vaultId] : []), '--format', 'json'], native, signal);
            if (!listed.ok) return listed;
            const parsed: unknown = JSON.parse(listed.value);
            if (!Array.isArray(parsed)) throw new Error('Invalid native items');
            items = parsed;
        }
        const fields: PluginSecretSourceFieldV1[] = [];
        for (const candidate of items) {
            const summary = record(candidate);
            const itemId = identifier(summary.id);
            const response = await runOnePassword(['item', 'get', itemId, '--account', input.account,
                ...(input.vaultId ? ['--vault', input.vaultId] : []), '--format', 'json'], native, signal);
            if (!response.ok) return response;
            const item = record(JSON.parse(response.value));
            const vault = record(item.vault);
            const vaultId = identifier(vault.id);
            const summaryVault = summary.vault === undefined ? undefined : record(summary.vault);
            const vaultName = label(vault.name, label(summaryVault?.name, vaultId));
            const resolvedItemId = identifier(item.id);
            const itemTitle = label(item.title, itemId);
            if (!Array.isArray(item.fields)) throw new Error('Invalid native fields');
            for (const candidateField of item.fields) {
                const field = record(candidateField);
                const fieldId = identifier(field.id);
                const sectionId = field.section === undefined ? undefined : identifier(record(field.section).id);
                const reference = `op://${[vaultId, resolvedItemId, ...(sectionId ? [sectionId] : []), fieldId].map(encodeURIComponent).join('/')}`;
                fields.push({ account: input.account, reference, vault: { id: vaultId, name: vaultName },
                    item: { id: resolvedItemId, title: itemTitle },
                    field: { id: fieldId, title: label(field.label, fieldId), kind: identifier(field.type) } });
            }
        }
        return { ok: true, vaults, fields };
    } catch {
        return signal.aborted ? { ok: false, code: 'cancelled' } : { ok: false, code: 'acquisition_failed', repair: 'retry' };
    }
}

/** CLI 2 supports JSON templates on stdin (`op item create -`); secret values never become arguments or files. */
export async function storeOnePasswordField(input: PluginSecretSourceStoreRequestV1, native: OnePasswordNative,
    signal: AbortSignal): Promise<PluginSecretSourceStoreResultV1> {
    if (signal.aborted) return { ok: false, code: 'cancelled' };
    const stdin = new TextEncoder().encode(JSON.stringify({ title: input.title, category: 'PASSWORD',
        fields: [{ id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: input.value }] }));
    try {
        const response = await runOnePassword(['item', 'create', '-', '--account', input.account,
            '--vault', input.vaultId, '--format', 'json'], native, signal, { stdin, write: true });
        if (!response.ok) return response;
        const item = record(JSON.parse(response.value));
        const vaultId = identifier(record(item.vault).id);
        const itemId = identifier(item.id);
        return { ok: true, account: input.account, reference: `op://${encodeURIComponent(vaultId)}/${encodeURIComponent(itemId)}/password` };
    } catch {
        // A create can have completed before its response is interrupted or malformed. Do not suggest replay.
        return signal.aborted ? { ok: false, code: 'cancelled' } : { ok: false, code: 'acquisition_failed' };
    }
}
