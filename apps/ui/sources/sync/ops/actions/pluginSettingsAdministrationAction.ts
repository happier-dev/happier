import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { PluginSettingsAdministrationActionInputSchemasV1, PluginSettingsAdministrationActionOutputV1Schema,
    PluginSettingsAdministrationFailureDetailsV1Schema,
    resolvePluginSettingsAdministrationTargetV1,
    type PluginSettingsAdministrationActionOutputV1, type PluginSettingsAdministrationFailureDetailsV1 } from '@happier-dev/protocol/plugins/settingsAdministration';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { resolvePluginSettingBoundSetV1, resolvePluginSettingBoundResetV1 } from '@happier-dev/protocol/plugins/contributions/settings';
import type { PluginProjectionEditableSettingsGroup } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { projectScopedPluginSettingsField, projectScopedPluginSettingsFields, readScopedPluginSettingsDeclaredFieldValue } from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';
import { formatPluginSettingsAdministrationRevision, type ScopedPluginSettingsAdapter, type ScopedPluginSettingsTarget,
    type ScopedPluginSettingsSnapshot } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import type { LazyActionAccountContext } from './actionAccountContext';

type AdministrationRequest = Parameters<NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']>>[0];
type AdministrationScope = Readonly<{
    target: ScopedPluginSettingsTarget;
    groups: readonly PluginProjectionEditableSettingsGroup[];
    adapter: ScopedPluginSettingsAdapter;
    secretAdapter: ScopedPluginSettingsAdapter;
    assertCurrent(): void;
}>;

type AdministrationDeclarationScope = Pick<AdministrationScope, 'target' | 'groups' | 'assertCurrent'>;

function resolveDeclaredInput(params: AdministrationRequest & AdministrationDeclarationScope) {
    params.context.signal?.throwIfAborted();
    params.assertCurrent();
    if (params.context.isPluginSettingsIntentCurrent && !params.context.isPluginSettingsIntentCurrent())
        throw new Error('plugin_settings_target_not_current');
    const input = PluginSettingsAdministrationActionInputSchemasV1[params.actionId].parse(params.input);
    const scope = 'scope' in input && input.scope ? input.scope : { kind: params.target.kind };
    const publicTarget = params.target.kind === 'account' ? { kind: 'account' as const }
        : { kind: 'daemon' as const, serverIdentityId: params.target.serverIdentityId, machineId: params.target.machineId };
    const selected = 'secretDaemonTarget' in input && input.secretDaemonTarget ? input.secretDaemonTarget
        : 'target' in input ? input.target : undefined;
    if (selected && (selected.kind !== params.target.kind || selected.kind === 'daemon'
        && (params.target.kind !== 'daemon' || selected.machineId !== params.target.machineId
            || selected.serverIdentityId !== params.target.serverIdentityId)))
        return { ok: false as const, errorCode: 'plugin_settings_target_not_current' };
    const isSecret = params.actionId.startsWith('plugins.settings.secret.');
    const groups = params.groups.filter(group => group.pluginId === input.pluginId
        && (isSecret && !('scope' in input && input.scope) || group.scope.kind === scope.kind));
    const declared = groups.flatMap(group => group.fields);
    const localId = 'localId' in input ? input.localId : undefined;
    const matches = localId === undefined ? [] : declared.filter(field => field.key === localId);
    if (localId !== undefined && matches.length !== 1) return { ok: false as const, errorCode: 'plugin_settings_unknown_key' };
    const field = matches[0];
    const bindingServerIdentityId = params.actionId === 'plugins.settings.get' || params.actionId === 'plugins.settings.set'
        || params.actionId === 'plugins.settings.reset'
        ? PluginSettingsAdministrationActionInputSchemasV1[params.actionId].parse(params.input).bindingServerIdentityId : undefined;
    if (bindingServerIdentityId !== undefined && (scope.kind !== 'account' || !field
        || projectScopedPluginSettingsField(field).binding?.kind !== 'perActiveServer'))
        return { ok: false as const, errorCode: 'invalid_arguments' };
    if (!isSecret && field && (field.secretCustody !== null || field.control === 'password' || field.redaction !== 'none'))
        return { ok: false as const, errorCode: 'plugin_settings_unknown_key' };
    return { ok: true as const, input, scope, publicTarget, isSecret, declared, localId, field, bindingServerIdentityId,
        fields: projectScopedPluginSettingsFields(isSecret && field ? [field] : declared) };
}

/** The Action port projects the incumbent Settings owners; it never owns another record or CAS. */
async function executeScopedPluginSettingsAdministrationActionCore(
    params: AdministrationRequest & AdministrationScope,
): Promise<PluginSettingsAdministrationActionOutputV1> {
    const assertCurrent = () => {
        params.context.signal?.throwIfAborted();
        params.assertCurrent();
        if (params.context.isPluginSettingsIntentCurrent && !params.context.isPluginSettingsIntentCurrent())
            throw new Error('plugin_settings_target_not_current');
    };
    const fail = (errorCode: string, details?: PluginSettingsAdministrationFailureDetailsV1): PluginSettingsAdministrationActionOutputV1 => ({
        ok: false, kind: params.actionId, errorCode, error: errorCode,
        ...(details ? { details } : {}),
    });
    const complete = (data: unknown): PluginSettingsAdministrationActionOutputV1 =>
        PluginSettingsAdministrationActionOutputV1Schema.parse({ ok: true, kind: params.actionId, data });
    try {
        params.context.signal?.throwIfAborted();
        assertCurrent();
        const resolved = resolveDeclaredInput(params);
        if (!resolved.ok) return fail(resolved.errorCode);
        const { input, scope, publicTarget, isSecret, declared, localId, field, bindingServerIdentityId, fields } = resolved;
        const adapter = isSecret ? params.secretAdapter : params.adapter;
        const settlement = (snapshot: ScopedPluginSettingsSnapshot): PluginSettingsAdministrationFailureDetailsV1 => PluginSettingsAdministrationFailureDetailsV1Schema.parse(isSecret
            ? { kind: 'secret_snapshot', localId: field!.key, custody: 'account', target: { kind: 'account' },
                revision: formatPluginSettingsAdministrationRevision(snapshot.revision), state: snapshot.secretStates?.[field!.key] ?? 'missing' }
            : { kind: 'settings_snapshot', scope: snapshot.scope, target: publicTarget,
                revision: formatPluginSettingsAdministrationRevision(snapshot.revision), values: snapshot.values });
        if (isSecret && field?.secretCustody === 'daemon') {
            const daemonSecret = params.adapter.daemonSecret;
            if (params.target.kind !== 'daemon' || !daemonSecret) return fail('plugin_secret_custody_unavailable');
            if (params.actionId !== 'plugins.settings.secret.status' && params.actionId !== 'plugins.settings.secret.delete')
                return fail('plugin_secret_custody_unavailable');
            const daemonInput = { pluginId: input.pluginId, target: params.target, secretId: field.key,
                ...('canonicalOrigin' in input && input.canonicalOrigin ? { canonicalOrigin: input.canonicalOrigin } : {}),
                ...(params.context.signal ? { signal: params.context.signal } : {}) };
            const before = await daemonSecret.read(daemonInput);
            params.context.signal?.throwIfAborted();
            assertCurrent();
            if (before.status !== 'ready') return fail('plugin_secret_custody_unavailable');
            const data = { localId: field.key, custody: 'daemon' as const,
                target: { kind: 'daemon' as const, serverIdentityId: params.target.serverIdentityId, machineId: params.target.machineId },
                state: before.snapshot.state, revision: before.snapshot.revision };
            if (params.actionId === 'plugins.settings.secret.status') return complete(data);
            if ('expectedRevision' in input && input.expectedRevision !== undefined && input.expectedRevision !== before.snapshot.revision)
                return fail('plugin_secret_revision_conflict', { kind: 'secret_snapshot', ...data,
                    ...('canonicalOrigin' in input && input.canonicalOrigin ? { canonicalOrigin: input.canonicalOrigin } : {}) });
            const result = await daemonSecret.write({ ...daemonInput, expectedRevision: before.snapshot.revision, mutation: { kind: 'delete' } });
            if (result.status !== 'ready') {
                let details: PluginSettingsAdministrationFailureDetailsV1 | undefined;
                if (result.status === 'outcomeUnknown' && result.snapshot) {
                    try { assertCurrent(); details = { kind: 'secret_snapshot', ...data, state: result.snapshot.state,
                        revision: result.snapshot.revision, ...('canonicalOrigin' in input && input.canonicalOrigin ? { canonicalOrigin: input.canonicalOrigin } : {}) }; } catch {}
                }
                return fail(result.status === 'outcomeUnknown' ? 'plugin_secret_outcome_unknown' : 'plugin_secret_custody_unavailable', details);
            }
            return complete({ ...data, state: result.snapshot.state, revision: result.snapshot.revision, application: { kind: 'live' } });
        }
        if (isSecret && (field?.secretCustody !== 'account' || 'canonicalOrigin' in input && input.canonicalOrigin !== undefined))
            return fail('invalid_arguments');
        const readInput = { pluginId: input.pluginId, scope, target: params.target, fields,
            ...(params.context.signal ? { signal: params.context.signal } : {}) };
        const before = await adapter.read(readInput);
        params.context.signal?.throwIfAborted();
        assertCurrent();
        if (before.status !== 'ready') return fail('plugin_settings_unavailable');
        const revision = formatPluginSettingsAdministrationRevision(before.snapshot.revision);
        if (params.actionId === 'plugins.settings.list') return complete({ scope, target: publicTarget, revision,
            fields: declared.filter(candidate => candidate.presentation?.hidden !== true).map(candidate => ({
                localId: candidate.key, ...(candidate.secretCustody !== null ? { secret: true } : { secret: false,
                    value: StrictJsonValueSchema.parse(readScopedPluginSettingsDeclaredFieldValue({ values: before.snapshot.values,
                        field: candidate, serverIdentityId: null }) ?? null) }),
            })),
        });
        if (!field || !localId) return fail('plugin_settings_unknown_key');
        if (params.actionId === 'plugins.settings.get') return complete({ scope, target: publicTarget, revision, localId,
            value: StrictJsonValueSchema.parse(readScopedPluginSettingsDeclaredFieldValue({ values: before.snapshot.values,
                field, serverIdentityId: bindingServerIdentityId ?? null }) ?? null),
        });
        if (params.actionId === 'plugins.settings.secret.status') return complete({ localId, custody: 'account',
            target: { kind: 'account' }, revision, state: before.snapshot.secretStates?.[localId] ?? 'missing' });
        if ('expectedRevision' in input && input.expectedRevision !== undefined && input.expectedRevision !== revision)
            return fail(isSecret ? 'plugin_secret_revision_conflict' : 'plugin_settings_revision_conflict', settlement(before.snapshot));
        let mutation = params.actionId === 'plugins.settings.set'
            ? { kind: 'set' as const, value: PluginSettingsAdministrationActionInputSchemasV1[params.actionId].parse(params.input).value }
            : params.actionId === 'plugins.settings.secret.bind'
                ? { kind: 'bind' as const, savedSecretId: PluginSettingsAdministrationActionInputSchemasV1[params.actionId].parse(params.input).savedSecretId }
                : params.actionId === 'plugins.settings.secret.unbind' ? { kind: 'unbind' as const }
                    : { kind: 'delete' as const };
        if (mutation.kind === 'set' && !isValidPluginJsonSchemaValue(compilePluginJsonSchema(field.valueSchema), mutation.value))
            return fail('plugin_settings_invalid_value');
        let fieldId = localId;
        if (!isSecret) {
            const bound = { values: before.snapshot.values, field: projectScopedPluginSettingsField(field),
                serverIdentityId: bindingServerIdentityId ?? null };
            if (mutation.kind === 'set') {
                const selected = resolvePluginSettingBoundSetV1({ ...bound, value: mutation.value });
                fieldId = selected.fieldId;
                mutation = { kind: 'set', value: StrictJsonValueSchema.parse(selected.value) };
            } else {
                const selected = resolvePluginSettingBoundResetV1(bound);
                fieldId = selected.fieldId;
                mutation = selected.mutation.kind === 'delete' ? selected.mutation
                    : { kind: 'set', value: StrictJsonValueSchema.parse(selected.mutation.value) };
            }
        }
        assertCurrent();
        const result = await adapter.write({ ...readInput, fieldId, mutation, expectedRevision: before.snapshot.revision,
            isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } } });
        if (result.status !== 'ready' && result.status !== 'applied') {
            assertCurrent();
            let details: PluginSettingsAdministrationFailureDetailsV1 | undefined;
            if ((result.status === 'conflict' || result.status === 'outcomeUnknown') && result.snapshot) {
                try { assertCurrent(); details = settlement(result.snapshot); } catch {}
            }
            return fail(result.status === 'conflict' ? isSecret ? 'plugin_secret_revision_conflict' : 'plugin_settings_revision_conflict'
                : result.status === 'outcomeUnknown' ? isSecret ? 'plugin_secret_outcome_unknown' : 'plugin_settings_outcome_unknown'
                    : 'plugin_settings_unavailable', details);
        }
        const nextRevision = formatPluginSettingsAdministrationRevision(result.status === 'ready' ? result.snapshot.revision : result.revision);
        return complete(isSecret ? { localId, custody: 'account', target: { kind: 'account' }, revision: nextRevision, application: { kind: 'live' } }
            : { scope, target: publicTarget, localId, revision: nextRevision, application: { kind: 'live' } });
    } catch {
        return fail('plugin_settings_target_not_current');
    }
}

export const executeScopedPluginSettingsAdministrationAction = Object.assign(executeScopedPluginSettingsAdministrationActionCore, {
    async admitInput(params: AdministrationRequest & AdministrationDeclarationScope) {
        try {
            const resolved = resolveDeclaredInput(params);
            return resolved.ok ? null : { ok: false as const, errorCode: resolved.errorCode, error: resolved.errorCode };
        } catch {
            return { ok: false as const, errorCode: 'plugin_settings_target_not_current', error: 'plugin_settings_target_not_current' };
        }
    },
});

export function createUiPluginSettingsAdministrationAction(
    account: LazyActionAccountContext,
): NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']> {
    const resolveScope = async (request: AdministrationRequest): Promise<AdministrationDeclarationScope | null> => {
        let assertDeclarationCurrent = () => {};
        const assertCurrent = () => {
            request.context.signal?.throwIfAborted();
            account.assertCurrent();
            if (request.context.isPluginSettingsIntentCurrent && !request.context.isPluginSettingsIntentCurrent())
                throw new Error('plugin_settings_target_not_current');
            assertDeclarationCurrent();
        };
        assertCurrent();
        const input = PluginSettingsAdministrationActionInputSchemasV1[request.actionId].parse(request.input);
        if (!account.serverIdentityId) return null;
        const selected = resolvePluginSettingsAdministrationTargetV1(request.actionId, input);
        let target: ScopedPluginSettingsTarget = { kind: 'account', serverIdentityId: account.serverIdentityId };
        let groups: readonly PluginProjectionEditableSettingsGroup[];
        if (selected.kind === 'daemon') {
            if (selected.serverIdentityId !== account.serverIdentityId) return null;
            target = { ...selected, serverId: account.serverId };
            const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
            // Settings groups and package occurrence only.
            const projection = await loadDaemonMergedProjectionInputs({ machineId: selected.machineId, serverId: account.serverId,
                accountLifetime: account.accountLifetime, signal: request.context.signal, sections: ['settingsById'] });
            assertCurrent();
            if (!projection) return null;
            groups = projection.pluginProjectionById[input.pluginId]?.editableSettingsGroups ?? [];
        } else {
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const { areServerAccountScopesEqual } = await import('@/sync/domains/scope/serverAccountScope');
            const active = captureActiveServerAccountScopeLifetime();
            if (!active?.isCurrent() || !areServerAccountScopesEqual(active.scope, account.accountLifetime.scope)) return null;
            const { readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
            const reader = readPluginAccountAvailability({ serverId: account.serverId, accountId: account.accountId });
            const { readCurrentAppShellPluginUiExecutionOriginCandidates } = await import('@/components/appShell/plugins/committedPluginUiProjection');
            const { resolveFreshPluginMachineExecutionOrigin } = await import('@/sync/domains/machines/administration/usePluginExecutionOriginSelection');
            const { readCurrentPluginMachineExecutionTargetPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
            const { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
            const readSelected = () => resolveFreshPluginMachineExecutionOrigin({ pluginId: input.pluginId,
                origin: null, storedTarget: readCurrentPluginMachineExecutionTargetPreference(input.pluginId),
                reader, classifyRelease: reader.classifyRelease,
                ...readCurrentAppShellPluginUiExecutionOriginCandidates(input.pluginId, { scope: active.scope, declarationsOnly: true }) });
            const selectedSource = readSelected();
            if (selectedSource?.source) {
                // A live source declaration stays with its current daemon. It
                // declares Account fields without becoming their storage target.
                const source = selectedSource.source;
                if (selectedSource.origin.serverIdentityId !== account.serverIdentityId) return null;
                assertDeclarationCurrent = () => {
                    const current = readSelected();
                    if (!current?.source || !arePluginMachineExecutionOriginsEqual(current.origin, selectedSource.origin)
                        || current.source.occurrenceId !== source.occurrenceId)
                        throw new Error('plugin_settings_target_not_current');
                };
                const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
                const projection = await loadDaemonMergedProjectionInputs({ machineId: getPluginMachineExecutionOriginRef(source.origin).machineId,
                    serverId: source.serverId, accountLifetime: account.accountLifetime, sections: ['settingsById'] });
                assertCurrent();
                const declaration = projection?.pluginProjectionById[input.pluginId];
                if (!declaration?.installedPackage?.executionOrigin || declaration.occurrenceId !== source.occurrenceId
                    || !arePluginMachineExecutionOriginsEqual(declaration.installedPackage.executionOrigin, selectedSource.origin)) return null;
                groups = declaration.editableSettingsGroups;
            } else {
                const declaration = reader.readCurrentSettingsDeclaration({ pluginId: input.pluginId });
                if (declaration.kind === 'available') {
                    const { projectPluginSettingsContributionV2 } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
                    const { mapV2EditableSettingsGroup } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
                    groups = (declaration.declaration.contributes.settings ?? []).map(definition => mapV2EditableSettingsGroup(
                        projectPluginSettingsContributionV2({ pluginId: input.pluginId, definition })));
                } else {
                    // A selected release or ambiguous Account claim cannot be
                    // reinterpreted as the app's bundled Agent declaration.
                    const inventory = reader.readMaterializations();
                    if (declaration.code === 'account_availability_scope_mismatch'
                        || declaration.code === 'artifact_slot_ambiguous'
                        || inventory.kind === 'available' && inventory.intentReads.some(entry =>
                            entry.pluginId === input.pluginId && entry.response.intent?.desiredVersion != null)) return null;
                    const { projectBundledAgentAccountSettingsGroups } = await import('@/sync/domains/plugins/settings/accountDeclaredPluginSettings');
                    groups = projectBundledAgentAccountSettingsGroups({ pluginId: input.pluginId });
                    if (groups.length === 0) return null;
                }
            }
        }
        assertCurrent();
        return { target, groups, assertCurrent };
    };
    const unavailable = (request: AdministrationRequest): PluginSettingsAdministrationActionOutputV1 => ({ ok: false,
        kind: request.actionId, errorCode: 'plugin_settings_unavailable', error: 'plugin_settings_unavailable' });
    return Object.assign(async (request: AdministrationRequest) => {
        const scope = await resolveScope(request);
        if (!scope) return unavailable(request);
        const { executePluginSettingsAdministrationStorageAction } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime');
        scope.assertCurrent();
        return executePluginSettingsAdministrationStorageAction({ ...request, ...scope });
    }, {
        async admitInput(request: AdministrationRequest) {
            try {
                const scope = await resolveScope(request);
                if (!scope) return { ok: false as const, errorCode: 'plugin_settings_unavailable', error: 'plugin_settings_unavailable' };
                return executeScopedPluginSettingsAdministrationAction.admitInput({ ...request, ...scope });
            } catch {
                return { ok: false as const, errorCode: 'plugin_settings_target_not_current', error: 'plugin_settings_target_not_current' };
            }
        },
    });
}
