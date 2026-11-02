import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { machineSecretGrantSubjectKey, MachineConnectorSecretGrantSubjectV1Schema, MachineConnectorSecretGrantInputV1Schema,
    type MachineConnectorSecretGrantSubjectV1, type MachineConnectorSecretGrantInputV1 } from '@happier-dev/deployment-protocol';
import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { configuration } from '@/configuration';
import { assertDeploymentSecretInvocationCurrent, materializeMachineConnectorSecretGrantForHost, machineConnectorSecretGrantPathForHost,
    type MachineConnectorSecretGrantHostRequest } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';

/** Private stdin custody, separate from the reviewable request/plan and retained records. */
export const MachineConnectorSecretGrantSessionSchema = z.object({
    type: z.literal('connector.secretGrant.session'), operationId: z.string().min(1),
    token: z.string().min(1), installationIdentityFile: z.string().min(1),
    serverId: z.string().min(1), serverHttpBaseUrl: z.string().url(),
    hostMachineId: z.string().min(1), hostInstallationId: z.string().min(1),
    subject: z.custom<MachineConnectorSecretGrantSubjectV1>(value => MachineConnectorSecretGrantSubjectV1Schema.safeParse(value).success),
}).strict();
export type MachineConnectorSecretGrantSession = z.infer<typeof MachineConnectorSecretGrantSessionSchema>;

type ConnectorRead = Extract<MachineConnectorSecretGrantInputV1, { operation: 'read' }>;
export const MachineConnectorSecretGrantControlSchema = z.object({ type: z.literal('connector.secretGrant.control'), operation: z.literal('headers'),
        body: z.custom<ConnectorRead>(value => {
            const parsed = MachineConnectorSecretGrantInputV1Schema.safeParse(value);
            return parsed.success && parsed.data.operation === 'read';
        }),
    }).strict();
export type MachineConnectorSecretGrantControl = z.infer<typeof MachineConnectorSecretGrantControlSchema>;
export const MachineConnectorSecretGrantReplySchema = z.union([
    z.object({ type: z.literal('connector.secretGrant.reply'), operation: z.literal('headers'), ok: z.literal(false) }).strict(),
    z.object({ type: z.literal('connector.secretGrant.reply'), operation: z.literal('headers'), ok: z.literal(true),
        headers: z.record(z.string(), z.string()),
    }).strict(),
]);
export type MachineConnectorSecretGrantReply = z.infer<typeof MachineConnectorSecretGrantReplySchema>;

const refuse = (): never => { throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' }); };

function hasExactGrantSteps(steps: readonly MachineRecipeStepV1[], grantRef: string) {
    const refs = steps.flatMap(step => step.kind === 'file' && step.content?.kind === 'secretGrant' ? [step.content.grantRef] : []);
    return refs.length > 0 && refs.every(ref => ref === grantRef);
}

/** The original admitted invocation stays in the daemon; only this private dialogue reaches its child. */
export function createMachineConnectorSecretGrantSession(input: Readonly<{
    machineId: string; installationId: string; operationId: string; steps: readonly MachineRecipeStepV1[];
    verifyCurrent(): Promise<boolean>;
}>, admitted?: MachineConnectorSecretGrantHostRequest) {
    if (!admitted || !input.steps.some(step => step.kind === 'file' && step.content?.kind === 'secretGrant')) return undefined;
    const grantRef = machineSecretGrantSubjectKey(admitted.subject);
    const frame = MachineConnectorSecretGrantSessionSchema.parse({ type: 'connector.secretGrant.session',
        operationId: input.operationId, serverId: admitted.serverId, serverHttpBaseUrl: admitted.serverHttpBaseUrl,
        hostMachineId: admitted.hostMachineId, hostInstallationId: admitted.hostInstallationId, subject: admitted.subject,
        token: admitted.credentials.token, installationIdentityFile: admitted.installationIdentityFile ?? configuration.installationIdentityFile });
    if (admitted.context.operationAcceptance?.operationId !== input.operationId
        || frame.hostMachineId !== input.machineId || frame.subject.machineId !== input.machineId
        || frame.hostInstallationId !== input.installationId || frame.subject.installationId !== input.installationId
        || !isAbsolute(frame.installationIdentityFile) || !hasExactGrantSteps(input.steps, grantRef)) return refuse();
    const path = machineConnectorSecretGrantPathForHost(frame.subject.machineId);
    const assertCurrent = async () => {
        admitted.signal.throwIfAborted();
        if (!await input.verifyCurrent()) return refuse();
        await assertDeploymentSecretInvocationCurrent(admitted.context, admitted.signal);
        await admitted.assertCurrent();
        admitted.signal.throwIfAborted();
    };
    return { frame, signal: admitted.signal, assertCurrent,
        async reply(control: MachineConnectorSecretGrantControl): Promise<MachineConnectorSecretGrantReply> {
            try {
                admitted.signal.throwIfAborted();
                const body = control.body;
                if (body.operation !== 'read' || body.serverId !== frame.serverId || body.hostMachineId !== frame.hostMachineId
                    || body.hostInstallationId !== frame.hostInstallationId || machineSecretGrantSubjectKey(body.subject) !== grantRef) return refuse();
                const authorization = admitted.context.externalActionExecutionAuthorization;
                const headers = authorization
                    ? await authorization.requesterHttpProjection!.createRequestHeaders({ method: 'POST', path, body,
                        effectActionId: authorization.binding.actionId, signal: admitted.signal })
                    : { Authorization: `Bearer ${admitted.credentials.token}` };
                if (!headers) return refuse();
                admitted.signal.throwIfAborted();
                return { type: 'connector.secretGrant.reply', operation: 'headers', ok: true, headers };
            } catch { return { type: 'connector.secretGrant.reply', operation: control.operation, ok: false }; }
        },
    };
}

/** Child-local P42 opening. The parent signs each exact read; finite byte checks use local cancellation. */
export function bindMachineConnectorSecretGrantMaterializer(input: Readonly<{
    session: MachineConnectorSecretGrantSession; machineId: string; installationId: string; operationId: string;
    steps: readonly MachineRecipeStepV1[]; signal: AbortSignal;
    exchange(control: MachineConnectorSecretGrantControl): Promise<MachineConnectorSecretGrantReply>;
}>) {
    const { session } = input;
    const grantRef = machineSecretGrantSubjectKey(session.subject);
    if (session.operationId !== input.operationId || session.hostMachineId !== input.machineId
        || session.subject.machineId !== input.machineId || session.hostInstallationId !== input.installationId
        || session.subject.installationId !== input.installationId || !isAbsolute(session.installationIdentityFile)
        || !hasExactGrantSteps(input.steps, grantRef)) return refuse();
    const assertCurrent = async () => {
        input.signal.throwIfAborted();
    };
    const credentials = { token: session.token };
    session.token = '';
    // One admitted child invocation owns the opening through check, effect and verification.
    let material: Awaited<ReturnType<typeof materializeMachineConnectorSecretGrantForHost>> | undefined;
    return { async materialize(ref: string) {
        if (ref !== grantRef) return refuse();
        material ??= await materializeMachineConnectorSecretGrantForHost({ grantRef: ref, subject: session.subject,
            credentials, serverId: session.serverId, serverHttpBaseUrl: session.serverHttpBaseUrl,
            hostMachineId: session.hostMachineId, hostInstallationId: session.hostInstallationId,
            installationIdentityFile: session.installationIdentityFile, context: { operationAcceptance: { operationId: session.operationId } },
            signal: input.signal, assertCurrent,
            async createReadRequestHeaders(body) {
                const reply = await input.exchange({ type: 'connector.secretGrant.control', operation: 'headers', body });
                if (reply.operation !== 'headers' || !reply.ok) return refuse();
                return reply.headers;
            },
        });
        return { bytes: material.bytes, assertCurrent: material.assertCurrent,
            // Native comparisons borrow the invocation-owned material.
            dispose() {} };
    }, dispose() { material?.dispose(); material = undefined; credentials.token = ''; } };
}
