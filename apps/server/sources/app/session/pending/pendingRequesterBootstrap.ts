import { SessionRequesterInstallationSealedBootstrapV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapSchemasV1';
import type { SessionPendingRequesterBootstrapRequestV1, SessionPendingRequesterBootstrapResponseV1 } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { inTx } from '@/storage/inTx';
import { getActivePrismaRuntime } from '@/storage/prisma';

/** Only the admitted installation can recover opaque birth custody, then acknowledge its local persistence. */
export async function accessPendingRequesterBootstrap(input: Readonly<{
    custodianAccountId: string;
    machineId: string;
    installationId: string;
    request: SessionPendingRequesterBootstrapRequestV1;
}>): Promise<SessionPendingRequesterBootstrapResponseV1> {
    return inTx(async tx => {
        const machine = await tx.machine.findFirst({ where: { id: input.machineId, accountId: input.custodianAccountId,
            installationId: input.installationId }, select: { id: true } });
        if (!machine) return { v: 1, ok: false };

        // AccessKey's Machine index discovers only this host's Session bindings;
        // the relation keeps a reconnect free of inventory-sized bind lists.
        const rows = await tx.sessionPendingMessage.findMany({ where: {
            ...(input.request.sessionId ? { sessionId: input.request.sessionId } : {}),
            ...(input.request.operation === 'consume' ? { localId: input.request.requestId } : {}),
            status: 'queued', targetExecutionRunId: null, providerAction: null,
            requesterBootstrap: { not: getActivePrismaRuntime().DbNull },
            OR: [{ deliveryState: null }, { deliveryState: 'blocked' }],
            session: { accessKeys: { some: { machineId: input.machineId } } },
        }, select: { id: true, sessionId: true, localId: true, inputAdmissionReceipt: true, requesterBootstrap: true,
            session: { select: { accountId: true } } } });
        const bootstraps: Extract<SessionPendingRequesterBootstrapResponseV1, { bootstraps: unknown }>['bootstraps'] = [];
        for (const row of rows) {
            const target = readStoredSessionInputAdmissionReceipt(row.inputAdmissionReceipt)?.admittedTarget;
            if (!target || target.machineId !== input.machineId || target.installationId !== input.installationId
                || target.sessionId !== row.sessionId || target.accountId !== row.session.accountId) continue;
            if (input.request.operation === 'consume') {
                await tx.sessionPendingMessage.update({ where: { id: row.id },
                    data: { requesterBootstrap: getActivePrismaRuntime().DbNull } });
                return { v: 1, ok: true };
            }
            const bootstrap = SessionRequesterInstallationSealedBootstrapV1Schema.safeParse(row.requesterBootstrap);
            if (bootstrap.success && bootstrap.data.installationId === target.installationId) {
                bootstraps.push({ target, requestId: row.localId, requesterBootstrap: bootstrap.data });
            }
        }
        return input.request.operation === 'consume' ? { v: 1, ok: false } : { v: 1, ok: true, bootstraps };
    });
}
