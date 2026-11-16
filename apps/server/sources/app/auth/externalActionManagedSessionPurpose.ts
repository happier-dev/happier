import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineSetupReportInputV1Schema, ManagedControllerContextInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db } from '@/storage/db';

/** Bound Session follow-ups consume the active birth association, without another admission. */
export async function readManagedBoundSessionHttpPurpose(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, proof: Readonly<{ method: string; path: string; body?: unknown }>): Promise<boolean | null> {
    const path = proof.path.split('?')[0];
    if (binding.actionId !== SESSION_SPAWN_NEW_ACTION_ID_V1 || proof.method.toUpperCase() !== 'POST'
        || path !== '/v1/machines/setup/report' && path !== '/v1/machines/managed/controller/context') return null;
    const report = path === '/v1/machines/setup/report' ? MachineSetupReportInputV1Schema.safeParse(proof.body) : null;
    const context = path === '/v1/machines/managed/controller/context'
        ? ManagedControllerContextInputV1Schema.safeParse(proof.body) : null;
    const input = report?.success && 'target' in report.data
        ? { homeId: report.data.homeId, managedId: report.data.managedId, ...report.data.target }
        : context?.success ? context.data : null;
    if (effectActionId !== SESSION_SPAWN_NEW_ACTION_ID_V1 || !input?.sessionId
        || input.homeId !== binding.serverIdentityId || !input.controller
        || input.controller.machineId !== binding.machineId
        || input.controller.installationId !== binding.installationId) return false;
    // Birth already admitted this exact Account, managed row and installed controller.
    const session = await db.session.findFirst({ where: { id: input.sessionId,
        accountId: binding.accountId, managedCreationId: input.managedId, archivedAt: null,
        managedCreation: { homeId: input.homeId, custodianAccountId: binding.custodianAccountId,
            controllerMachineId: binding.machineId, controllerInstallationId: binding.installationId },
    }, select: { id: true } });
    return session !== null;
}
