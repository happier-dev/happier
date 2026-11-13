import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { storeKinds, type StoreInstalledInput } from '@/components/store/catalog/storeKinds';
import { useInstalledScope } from '@/components/store/catalog/storeAccountAdmission';
import { captureStoreUpdateBasis } from '@/components/store/updates/storeUpdatesModel';
import { useStorePluginUpdates } from '@/components/store/updates/useStorePluginUpdates';
import { useStoreUpdates } from '@/components/store/updates/useStoreUpdates';
import { useRegistryUpdateCheck, type RegistryUpdateCheckState } from '@/registries/useRegistryUpdateCheck';

const NO_REFRESH = () => {};

/** Shared acquisition and observation owner for Machine Updates and Store's kind-filtered view. No idle loader. */
export function useInstalledUpdates(query: StoreInstalledInput, presented: boolean,
    externalActionTarget?: ActionExecutorContext['externalActionTarget'], publishStoreSummary = false) {
    const scope = query.scope;
    const demand = React.useMemo(() => ({ presented }), [presented]);
    const admitted = useInstalledScope(query);
    const app = storeKinds.app.useInstalled(query, demand, admitted);
    const mcpServer = storeKinds.mcpServer.useInstalled(query, demand, admitted);
    const skill = storeKinds.skill.useInstalled(query, demand, admitted);
    const agent = storeKinds.agent.useInstalled(query, demand, admitted);
    const browserExtension = storeKinds.browserExtension.useInstalled(query, demand, admitted);
    const plugin = storeKinds.plugin.useInstalled(query, demand, admitted);
    const rows = React.useMemo(() => [...app.rows, ...mcpServer.rows, ...agent.rows, ...skill.rows, ...browserExtension.rows, ...plugin.rows],
        [app.rows, mcpServer.rows, agent.rows, skill.rows, browserExtension.rows, plugin.rows]);
    const execution = useMountedActionExecution(scope);
    const execute = React.useCallback<typeof execution.execute>((actionId, input, options) =>
        execution.execute(actionId, input, { ...options, externalActionTarget }), [execution.execute, externalActionTarget]);
    const refreshSkills = skill.continuation;
    const refreshExtensions = browserExtension.continuation;
    const retry = React.useCallback(() => { refreshSkills?.(); refreshExtensions?.(); }, [refreshSkills, refreshExtensions]);
    const captureBasis = React.useCallback(() => captureStoreUpdateBasis(rows), [rows]);
    const scopeKey = JSON.stringify([scope, externalActionTarget]);
    const ordinary = useRegistryUpdateCheck({ scopeKey, execute, isCurrent: execution.isCurrent, retry,
        enabled: presented, captureBasis });
    const environments = React.useMemo(() => app.rows.map(row => ({ environmentId: row.native.environment.id,
        expectedRevision: row.native.environment.revision })), [app.rows]);
    const apps = useRegistryUpdateCheck({ scopeKey, execute, isCurrent: execution.isCurrent, retry: NO_REFRESH,
        enabled: presented && environments.length > 0, kind: 'app', environments, captureBasis });
    const hasApps = environments.length > 0;
    const check = React.useMemo<RegistryUpdateCheckState>(() => {
        if (!hasApps) return ordinary.check;
        const other = ordinary.check;
        const application = apps.check;
        return { checking: other.checking || application.checking,
            checkedAt: other.checkedAt === null || application.checkedAt === null ? null : Math.min(other.checkedAt, application.checkedAt),
            attemptedAt: Math.max(other.attemptedAt ?? 0, application.attemptedAt ?? 0) || null,
            failed: other.failed || application.failed, code: other.code ?? application.code,
            results: [...other.results, ...application.results],
            basis: new Map([...(other.basis ?? []), ...(application.basis ?? [])]) };
    }, [ordinary.check, apps.check, hasApps]);
    const checkNow = React.useCallback(async () => {
        await Promise.all([ordinary.checkNow(), ...(hasApps ? [apps.checkNow()] : [])]);
    }, [ordinary.checkNow, apps.checkNow, hasApps]);
    const pluginUpdates = useStorePluginUpdates({ rows: plugin.rows, check });
    const inventoryReady = [app, mcpServer, skill, agent, browserExtension, plugin].every(family => family.coverage === 'available');
    const view = useStoreUpdates(rows, check, scope, presented && publishStoreSummary, inventoryReady, pluginUpdates.entries);
    return { view, check, checkNow, execution, app, mcpServer, skill, agent, browserExtension, plugin };
}
