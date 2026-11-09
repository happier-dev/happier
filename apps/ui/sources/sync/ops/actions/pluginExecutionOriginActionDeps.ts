import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { PluginExecutionOriginActionInputSchemas as inputs, type PluginExecutionOriginUnavailableResult } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';
import { readCurrentAppShellPluginUiExecutionOriginCandidates } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { readFreshPluginMachineExecutionOriginCandidates, resolveFreshPluginMachineExecutionOrigin,
    readPluginExecutionOriginAutomaticHints } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin, getPluginExecutionOriginCandidateVersion,
    isPluginMachineExecutionOriginCandidateSelectable, resolvePluginMachineExecutionOriginState } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { persistPluginMachineExecutionOriginSelection, readCurrentPluginMachineExecutionTargetPreference } from '@/sync/domains/machines/administration/selectionPreferences';
import type { LazyActionAccountContext } from './actionAccountContext';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { executionOriginMachineSnapshotPublication } from '@/sync/domains/machines/administration/pluginExecutionOriginMachineSnapshots';

/** The answering client's Account-bound projection supplies candidates. Neither
 * the caller nor a daemon inventory can elect another plugin execution origin. */
export function createPluginExecutionOriginActionDeps(account: Pick<LazyActionAccountContext,
    'serverId' | 'accountId' | 'accountLifetime' | 'assertCurrent'>): Pick<ActionExecutorDeps, 'pluginExecutionOriginAction'> {
    return { pluginExecutionOriginAction: async ({ actionId, input, context }) => {
        account.assertCurrent();
        context.signal?.throwIfAborted();
        const scope = getActiveServerAccountScope();
        const current = () => account.accountLifetime.isCurrent() && scope !== null
            && scope.accountId === account.accountId && areServerProfileIdentifiersEquivalent(scope.serverId, account.serverId)
            && areServerAccountScopesEqual(scope, getActiveServerAccountScope())
            && areServerAccountScopesEqual(scope, storage.getState().settingsScope);
        const unavailable = (code: PluginExecutionOriginUnavailableResult['reason']['code']) => actionId === 'plugins.execution_origin.list'
            ? { status: 'unavailable', reason: { code, phase: 'selection', retryable: false } } satisfies PluginExecutionOriginUnavailableResult
            : { status: 'unavailable' as const };
        if (!scope || !current()) return unavailable('account_scope_unavailable');
        const parsed = inputs[actionId].parse(input);
        if (parsed.contextualTarget || (actionId === 'plugins.execution_origin.list'
            && inputs[actionId].parse(input).contextual === true)) {
            const mounted = readCurrentUiContextActionReader(context);
            const resolve = (commandId: string) => {
                const record = mounted?.resolveCurrentUiCommand(commandId);
                const command = record?.command;
                return record && !record.retirementSignal.aborted && command?.kind === 'pluginExecutionOrigin'
                    && command.pluginId === parsed.pluginId && areServerAccountScopesEqual(command.account.scope, account.accountLifetime.scope)
                    && command.account.isCurrent() && current() ? command : null;
            };
            if (!mounted) return unavailable('current_ui_context_unavailable');
            if (!parsed.contextualTarget) return { status: 'available', contextualTargets:
                mounted.readCurrentUiContext()?.commands.flatMap(descriptor => {
                    const command = resolve(descriptor.id);
                    return command ? [{ commandId: descriptor.id, ...command.target }] : [];
                }) ?? [] };
            const command = resolve(parsed.contextualTarget.commandId);
            if (!command) return unavailable('contextual_target_unavailable');
            if (actionId === 'plugins.execution_origin.list') return command.read();
            context.signal?.throwIfAborted();
            const origin = actionId === 'plugins.execution_origin.set' ? inputs[actionId].parse(input).origin : null;
            return resolve(parsed.contextualTarget.commandId) === command
                ? command.apply(origin) : { status: 'unavailable' };
        }
        const readFacts = () => {
            const reader = readPluginAccountAvailability(scope);
            return { pluginId: parsed.pluginId, origin: null, reader, classifyRelease: reader.classifyRelease,
                ...readCurrentAppShellPluginUiExecutionOriginCandidates(parsed.pluginId, { scope, declarationsOnly: true }) };
        };
        if (actionId === 'plugins.execution_origin.list') {
            const facts = readFacts();
            const candidates = readFreshPluginMachineExecutionOriginCandidates(facts);
            const admission = facts.reader.readMaterializations();
            const storedTarget = readCurrentPluginMachineExecutionTargetPreference(parsed.pluginId);
            const selection = resolvePluginMachineExecutionOriginState({ ...facts, storedOrigin: null, storedTarget, candidates,
                automaticOrigin: executionOriginMachineSnapshotPublication.readAutomaticOrigin(parsed.pluginId, captureActiveServerAccountScopeLifetime()),
                ...readPluginExecutionOriginAutomaticHints(parsed.pluginId, candidates, undefined,
                    admission.kind === 'available' ? admission.materializations : [], facts.reader.readInstalledPlugins()),
                homeServerIdentityId: getServerProfileById(scope.serverId)?.serverIdentityId });
            return { status: 'available', storedTarget, storedOrigin: null,
                selectedOrigin: selection.kind === 'selected' ? selection.origin : null,
                selectionSource: storedTarget ? 'pinned' : selection.kind === 'selected' ? selection.selectionSource : null,
                candidates: candidates.map(candidate => ({ origin: getPluginExecutionOriginCandidateOrigin(candidate),
                    version: getPluginExecutionOriginCandidateVersion(candidate), selectable: isPluginMachineExecutionOriginCandidateSelectable(candidate) })) };
        }
        const mutation = actionId === 'plugins.execution_origin.set' ? inputs[actionId].parse(input)
            : inputs['plugins.execution_origin.clear'].parse(input);
        const result = await persistPluginMachineExecutionOriginSelection({ pluginId: mutation.pluginId,
            origin: actionId === 'plugins.execution_origin.set' ? inputs[actionId].parse(input).origin : null,
            expectedSettingsScope: scope,
            isInvocationCurrent: () => { context.signal?.throwIfAborted(); return current(); },
            isOriginCurrent: origin => current() && resolveFreshPluginMachineExecutionOrigin({ ...readFacts(), origin }) !== null });
        return result;
    } };
}
