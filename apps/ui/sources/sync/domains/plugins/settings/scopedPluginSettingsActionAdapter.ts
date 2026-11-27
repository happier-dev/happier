import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginSettingsAdministrationActionOutputV1Schema, PluginSettingsAdministrationFailureDetailsV1Schema } from '@happier-dev/protocol/plugins/settingsAdministration';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { formatPluginSettingsAdministrationRevision, projectSafeScopedPluginSettingsValues, type ScopedPluginSettingsAdapter, type ScopedPluginSettingsRevision,
    type ScopedPluginSettingsTarget, type ScopedPluginSettingsWriteInput, type ScopedPluginSettingsWriteResult,
    type ScopedPluginDaemonSecretWriteInput, type ScopedPluginDaemonSecretWriteResult } from './scopedPluginSettingsAdapter';

type ActionExecute = ReturnType<typeof createActionExecutor>['execute'];
function portableTarget(target: ScopedPluginSettingsTarget) {
    return target.kind === 'account' ? { kind: 'account' as const }
        : { kind: 'daemon' as const, machineId: target.machineId, serverIdentityId: target.serverIdentityId };
}
function isSamePortableTarget(candidate: ReturnType<typeof portableTarget>, target: ScopedPluginSettingsTarget): boolean {
    return candidate.kind === target.kind && (candidate.kind === 'account' || target.kind === 'daemon'
        && candidate.serverIdentityId === target.serverIdentityId && candidate.machineId === target.machineId);
}
function readRevision(value: string, kind: ScopedPluginSettingsRevision['kind']): ScopedPluginSettingsRevision | null {
    if (kind === 'daemon') return { kind, value };
    if (!(kind === 'account-secret' ? /^account-secret-r1:\d+$/ : /^\d+$/).test(value)) return null;
    const revision = Number(kind === 'account-secret' ? value.slice('account-secret-r1:'.length) : value);
    return Number.isSafeInteger(revision) && revision >= 0 ? { kind, value: revision } : null;
}

/** UI mutations enter Actions before reaching the same scoped Settings adapter. */
export function createScopedPluginSettingsActionAdapter(params: Readonly<{
    adapter: ScopedPluginSettingsAdapter;
    accountLifetime: ActiveServerAccountScopeLifetime | null | (() => ActiveServerAccountScopeLifetime | null);
    perActiveServerIdentityId?: string | null;
    execute?: ActionExecute;
}>): ScopedPluginSettingsAdapter {
    let execute = params.execute;
    const dispatch: ActionExecute = async (id, input, context) => {
        if (!execute) execute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
        return execute(id, input, context);
    };
    const dispatchAtTarget = async (id: Parameters<ActionExecute>[0], input: unknown,
        target: ScopedPluginSettingsTarget, lifetime: ActiveServerAccountScopeLifetime, signal?: AbortSignal, isCurrent?: () => boolean): Promise<Awaited<ReturnType<ActionExecute>>> => {
        const unavailable = { ok: false as const, errorCode: 'plugin_settings_target_not_current', error: 'plugin_settings_target_not_current' };
        if (!lifetime?.isCurrent() || signal?.aborted) return unavailable;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const cancellation = mergeAbortSignals([signal, controller.signal]);
        try {
            let scope = lifetime.scope;
            if (target.kind === 'daemon' && target.serverId !== scope.serverId) {
                const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
                const resolved = await resolveServerCredentialAccountScope(target.serverId);
                if (resolved.kind !== 'bound') return unavailable;
                scope = resolved.scope;
            }
            if (!lifetime.isCurrent()) return unavailable;
            return await dispatch(id, input, { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
                signal: cancellation.signal,
                isPluginSettingsIntentCurrent: () => lifetime.isCurrent() && !cancellation.signal.aborted
                    && (isCurrent?.() ?? true) });
        } finally {
            cancellation.dispose();
            retirement.dispose();
        }
    };
    const failure = (errorCode: string): ScopedPluginSettingsWriteResult => isActionApprovalDeclinedErrorCode(errorCode)
        ? { status: 'declined' } : errorCode.endsWith('_revision_conflict')
        ? { status: 'conflict' } : errorCode.endsWith('_outcome_unknown') ? { status: 'outcomeUnknown' }
            : { status: 'unavailable', reason: 'transport' };
    const recordFailure = (errorCode: string, details: unknown, input: ScopedPluginSettingsWriteInput,
        lifetime: ActiveServerAccountScopeLifetime): ScopedPluginSettingsWriteResult => {
        const result = failure(errorCode);
        if (result.status !== 'conflict' && result.status !== 'outcomeUnknown' || !lifetime.isCurrent()) return result;
        const parsed = PluginSettingsAdministrationFailureDetailsV1Schema.safeParse(details);
        if (!parsed.success || !isSamePortableTarget(parsed.data.target, input.target)) return result;
        const revision = readRevision(parsed.data.revision, input.expectedRevision.kind);
        if (!revision) return result;
        if (parsed.data.kind === 'settings_snapshot' && input.expectedRevision.kind !== 'account-secret'
            && parsed.data.scope.kind === input.scope.kind) {
            const values = projectSafeScopedPluginSettingsValues({ values: parsed.data.values, fields: input.fields });
            if (Object.keys(values).length !== Object.keys(parsed.data.values).length) return result;
            return { ...result, snapshot: { scope: input.scope, target: input.target, revision, values } };
        }
        if (parsed.data.kind === 'secret_snapshot' && parsed.data.custody === 'account'
            && input.expectedRevision.kind === 'account-secret' && parsed.data.localId === input.fieldId) {
            return { ...result, snapshot: { scope: input.scope, target: input.target, revision, values: {},
                secretStates: { [input.fieldId]: parsed.data.state } } };
        }
        return result;
    };
    const daemonSecretFailure = (errorCode: string, details: unknown, input: ScopedPluginDaemonSecretWriteInput,
        lifetime: ActiveServerAccountScopeLifetime): ScopedPluginDaemonSecretWriteResult => {
        if (isActionApprovalDeclinedErrorCode(errorCode)) return { status: 'declined' };
        if (!errorCode.endsWith('_outcome_unknown')) return { status: 'unavailable', reason: 'transport' };
        const unresolved = { status: 'outcomeUnknown' as const };
        if (!lifetime.isCurrent() || input.signal?.aborted) return unresolved;
        const parsed = PluginSettingsAdministrationFailureDetailsV1Schema.safeParse(details);
        if (!parsed.success || parsed.data.kind !== 'secret_snapshot' || parsed.data.custody !== 'daemon'
            || parsed.data.localId !== input.secretId || !isSamePortableTarget(parsed.data.target, input.target)
            || parsed.data.canonicalOrigin !== input.canonicalOrigin) return unresolved;
        return { status: 'outcomeUnknown', snapshot: { target: input.target, pluginId: input.pluginId, secretId: input.secretId,
            state: parsed.data.state, revision: parsed.data.revision } };
    };
    return Object.freeze({
        ...params.adapter,
        async write(input) {
            // Raw creation/replacement remains the existing present-user secret
            // acquisition flow; secret bytes are never Action operands.
            if (input.expectedRevision.kind === 'account-secret' && input.mutation.kind === 'set')
                return params.adapter.write(input);
            const lifetime = typeof params.accountLifetime === 'function' ? params.accountLifetime() : params.accountLifetime;
            if (!lifetime?.isCurrent()) return { status: 'unavailable', reason: 'transport' };
            const isSecret = input.expectedRevision.kind === 'account-secret';
            let expectedRevision = input.expectedRevision;
            if (isSecret) {
                const current = await params.adapter.read(input);
                if (current.status !== 'ready' || current.snapshot.revision.kind !== 'account-secret') {
                    return { status: 'unavailable', reason: 'transport' };
                }
                // The mounted snapshot tracks secret state. Capture the
                // Account Settings CAS baseline when the person submits.
                expectedRevision = current.snapshot.revision;
            }
            const field = isSecret ? undefined : input.fields.find(candidate => candidate.binding?.kind === 'perActiveServer'
                && (candidate.binding.byServerIdSettingId === input.fieldId || candidate.binding.fallbackSettingId === input.fieldId))
                ?? input.fields.find(candidate => candidate.binding?.kind === 'direct' && candidate.binding.settingId === input.fieldId)
                ?? input.fields.find(candidate => candidate.key === input.fieldId);
            if (!isSecret && !field) return { status: 'unavailable', reason: 'scope-mismatch' };
            if (!isSecret && field?.redacted) return { status: 'unavailable', reason: 'scope-mismatch' };
            const bindingServerIdentityId = field?.binding?.kind === 'perActiveServer'
                ? input.bindingServerIdentityId !== undefined ? input.bindingServerIdentityId : params.perActiveServerIdentityId ?? null : undefined;
            const values = input.mutation.kind === 'set' ? input.mutation.value : undefined;
            const projectsServerValue = field?.binding?.kind === 'perActiveServer'
                && typeof bindingServerIdentityId === 'string' && input.mutation.kind === 'set';
            const hasServerValue = projectsServerValue && typeof values === 'object' && values !== null && !Array.isArray(values)
                && Object.prototype.hasOwnProperty.call(values, bindingServerIdentityId);
            const isSet = input.mutation.kind === 'set' && (!projectsServerValue || hasServerValue);
            const actionValue = hasServerValue && typeof bindingServerIdentityId === 'string'
                ? (values as Readonly<Record<string, unknown>>)[bindingServerIdentityId] : values;
            const actionId = isSecret
                ? input.mutation.kind === 'bind' ? 'plugins.settings.secret.bind' as const
                    : input.mutation.kind === 'unbind' ? 'plugins.settings.secret.unbind' as const
                        : 'plugins.settings.secret.delete' as const
                : isSet ? 'plugins.settings.set' as const : 'plugins.settings.reset' as const;
            const result = await dispatchAtTarget(actionId, { pluginId: input.pluginId,
                ...(!isSecret ? { scope: input.scope, target: portableTarget(input.target) } : {}), localId: field?.key ?? input.fieldId,
                expectedRevision: formatPluginSettingsAdministrationRevision(expectedRevision),
                ...(bindingServerIdentityId !== undefined ? { bindingServerIdentityId } : {}),
                ...(isSet ? { value: actionValue } : {}),
                ...(input.mutation.kind === 'bind' ? { savedSecretId: input.mutation.savedSecretId } : {}),
            }, input.target, lifetime, input.signal, input.isCurrent);
            if (!result.ok) return recordFailure(result.errorCode, result.details, input, lifetime);
            const receipt = PluginSettingsAdministrationActionOutputV1Schema.safeParse(result.result);
            if (!receipt.success || receipt.data.kind !== actionId) return { status: 'unavailable', reason: 'transport' };
            if (!receipt.data.ok) {
                return recordFailure(receipt.data.errorCode, receipt.data.details, input, lifetime);
            }
            if (!('localId' in receipt.data.data) || receipt.data.data.localId !== (field?.key ?? input.fieldId)
                || !isSamePortableTarget(receipt.data.data.target, input.target)
                || 'scope' in receipt.data.data && receipt.data.data.scope.kind !== input.scope.kind)
                return { status: 'outcomeUnknown' };
            const revision = readRevision(receipt.data.data.revision, input.expectedRevision.kind);
            if (!revision) return { status: 'outcomeUnknown' };
            // The record store owns presentation refresh after an applied receipt.
            return { status: 'applied', revision };
        },
        ...(params.adapter.daemonSecret ? { daemonSecret: {
            read: params.adapter.daemonSecret.read,
            async write(input: ScopedPluginDaemonSecretWriteInput) {
                if (input.mutation.kind === 'set') return params.adapter.daemonSecret!.write(input);
                const lifetime = typeof params.accountLifetime === 'function' ? params.accountLifetime() : params.accountLifetime;
                if (!lifetime?.isCurrent()) return { status: 'unavailable' as const, reason: 'transport' as const };
                const result = await dispatchAtTarget('plugins.settings.secret.delete', { pluginId: input.pluginId, localId: input.secretId,
                    secretDaemonTarget: portableTarget(input.target), expectedRevision: input.expectedRevision,
                    ...(input.canonicalOrigin !== undefined ? { canonicalOrigin: input.canonicalOrigin } : {}),
                }, input.target, lifetime, input.signal, input.signal
                    ? () => lifetime.isCurrent() && input.signal?.aborted !== true
                    : undefined);
                if (!result.ok) return daemonSecretFailure(result.errorCode, result.details, input, lifetime);
                const receipt = PluginSettingsAdministrationActionOutputV1Schema.safeParse(result.result);
                if (receipt.success && receipt.data.kind === 'plugins.settings.secret.delete' && !receipt.data.ok)
                    return daemonSecretFailure(receipt.data.errorCode, receipt.data.details, input, lifetime);
                if (!receipt.success || !receipt.data.ok || receipt.data.kind !== 'plugins.settings.secret.delete'
                    || receipt.data.data.custody !== 'daemon' || receipt.data.data.localId !== input.secretId
                    || !isSamePortableTarget(receipt.data.data.target, input.target) || !lifetime.isCurrent())
                    return { status: 'outcomeUnknown' as const };
                return { status: 'ready' as const, snapshot: { target: input.target, pluginId: input.pluginId,
                    secretId: input.secretId, state: receipt.data.data.state, revision: receipt.data.data.revision } };
            },
        } } : {}),
    });
}
