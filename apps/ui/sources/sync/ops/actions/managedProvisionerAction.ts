import { projectAccountManagedProvisioners, type ManagedProvisionerDiscoveryEntry } from '@happier-dev/cli-common/machines/managed/provisioners';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/executor/types';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Exact effects demand one selected declaration; chooser discovery retains the family inventory. */
export async function readUiManagedProvisioners(account: LazyActionAccountContext,
    pluginId?: string): Promise<readonly ManagedProvisionerDiscoveryEntry[] | ActionExecuteFailure> {
    const reader = readPluginAccountAvailability(account.accountLifetime.scope);
    if (pluginId !== undefined) {
        const selection = await reader.ensureCurrentAccountExecution(pluginId);
        account.assertCurrent();
        return selection.kind === 'available' ? projectAccountManagedProvisioners([selection])
            : { ok: false, errorCode: selection.code, error: selection.code };
    }
    const declarations = await reader.ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
    account.assertCurrent();
    if (declarations.kind === 'unavailable') return { ok: false as const, errorCode: declarations.code, error: declarations.code };
    return projectAccountManagedProvisioners(declarations.declarations);
}
