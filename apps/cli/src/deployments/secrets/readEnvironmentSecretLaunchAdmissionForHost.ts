import axios from '@/api/client/credentialAxios';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, EnvironmentSecretLaunchAdmissionBodyV1Schema,
    EnvironmentSecretLaunchAdmissionResultV1Schema, MachineConnectorSecretGrantBodyV1Schema,
    MachineConnectorSecretGrantResultV1Schema, MachineConnectorSecretGrantInputV1Schema, machineSecretGrantSubjectKey, parseMachineSecretGrantSubjectKey,
    type EnvironmentSecretLaunchAdmissionBodyV1, type MachineConnectorSecretGrantBodyV1,
    type MachineConnectorSecretGrantSubjectV1, type MachineConnectorSecretGrantInputV1,
    type EnvironmentDomainSecretLaunchAdmissionV1 } from '@happier-dev/deployment-protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { OwnServerSecretLaunchAdmission, OwnServerSecretLaunchAdmissionRequest } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { openMachineSecretGrant, sealMachineSecretGrant } from './machineSecretGrant';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
type InstalledSecretContext = Pick<ActionExecutorContext, 'signal' | 'externalActionExecutionAuthorization'
    | 'externalActionCredential' | 'rpcSessionAuthorization'> & Readonly<{
    operationAcceptance?: Pick<NonNullable<ActionExecutorContext['operationAcceptance']>, 'operationId'>;
}>;
type HostSecretAdmissionRequest = Omit<OwnServerSecretLaunchAdmissionRequest, 'materialization'> & Readonly<{
    materialization: OwnServerSecretLaunchAdmissionRequest['materialization']
        | Extract<EnvironmentSecretLaunchAdmissionBodyV1['materialization'], { kind: 'bindings' | 'domain' }>;
}>;

/** Requester custody for author preparation and protected Machine setup effects. */
export async function assertDeploymentSecretInvocationCurrent(context: InstalledSecretContext, signal = context.signal): Promise<void> {
    if (signal?.aborted) return refuse('cancelled');
    const authorization = context.externalActionExecutionAuthorization;
    if (authorization && (!authorization.requesterAccountProjection || !authorization.requesterHttpProjection
        || !await authorization.requesterAccountProjection.isCurrent()
        || !await authorization.requesterHttpProjection.isCurrent())) return refuse('action_forbidden');
    if (!authorization && (context.externalActionCredential || context.rpcSessionAuthorization)) return refuse('action_forbidden');
    if (signal?.aborted) return refuse('cancelled');
}

/** Installed target read. Account credentials authenticate transport; only the installed key opens a grant. */
export async function readEnvironmentSecretLaunchAdmissionForHost(input: OwnServerSecretLaunchAdmissionRequest): Promise<OwnServerSecretLaunchAdmission> {
    const admitted = await readEnvironmentSecretAdmissionForHost(input);
    if (admitted.bindingPreparation) { admitted.release(); return refuse('invalid_action_output'); }
    return admitted;
}

/** Domain native work uses the same installation proof, grant reader and release lifetime. */
export async function readEnvironmentDomainSecretLaunchAdmissionForHost(input: Omit<HostSecretAdmissionRequest, 'materialization'> & Readonly<{
    materialization: Extract<EnvironmentSecretLaunchAdmissionBodyV1['materialization'], { kind: 'domain' }>;
}>): Promise<OwnServerSecretLaunchAdmission & Readonly<{ domainAdmission?: EnvironmentDomainSecretLaunchAdmissionV1 }>> {
    const admitted = await readEnvironmentSecretAdmissionForHost(input);
    if (admitted.bindingPreparation) { admitted.release(); return refuse('invalid_action_output'); }
    if (!input.materialization.use && !admitted.domainAdmission) { admitted.release(); return refuse('invalid_action_output'); }
    return admitted;
}

/** The same private admission owner serves explicit manager preparation, never a public inventory. */
export async function readEnvironmentSecretBindingPreparationForHost(input: Omit<HostSecretAdmissionRequest, 'materialization'> & Readonly<{
    expectedRevision: number; buildMachineId?: string; domainIds?: readonly string[];
}>) {
    const admitted = await readEnvironmentSecretAdmissionForHost({ ...input,
        materialization: { kind: 'bindings', expectedRevision: input.expectedRevision,
            ...(input.domainIds?.length ? { domainIds: [...input.domainIds] } : {}),
            ...(input.buildMachineId ? { buildMachineId: input.buildMachineId } : {}) } });
    if (!admitted.bindingPreparation) { admitted.release(); return refuse('invalid_action_output'); }
    return { ...admitted, bindingPreparation: admitted.bindingPreparation };
}

type InstalledSecretHostInput = Pick<OwnServerSecretLaunchAdmissionRequest,
    'signal' | 'serverHttpBaseUrl' | 'machineId' | 'installationId'> & Readonly<{
    credentials: Pick<OwnServerSecretLaunchAdmissionRequest['credentials'], 'token'>;
    context: InstalledSecretContext;
    /** Existing installed identity location, carried privately across elevation; never a copied seed. */
    installationIdentityFile?: string;
}>;

/** One installed signer, invocation lifetime and HTTP boundary for both Environment and Machine subjects. */
function createInstalledSecretTransportForHost(input: InstalledSecretHostInput,
    createRequestHeaders?: (body: unknown) => Promise<Readonly<Record<string, string>>>) {
    const identity = readInstallationIdentityIfExistsSync(input.installationIdentityFile);
    const accountId = readAccountIdFromToken(input.credentials.token);
    if (!identity || identity.installationId !== input.installationId || !accountId) return refuse('secret_missing');
    let released = false;
    const assertAuthority = async () => {
        if (released) return refuse('secret_missing');
        if (input.signal.aborted) return refuse('cancelled');
    };
    const prepareRequest = async (path: string, body: EnvironmentSecretLaunchAdmissionBodyV1 | MachineConnectorSecretGrantBodyV1,
        effectActionId?: string) => {
        await assertAuthority();
        const projection = effectActionId ? input.context.externalActionExecutionAuthorization?.requesterHttpProjection : undefined;
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: input.machineId,
            installationId: identity.installationId, accountId: projection?.accountId ?? accountId,
            deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
            privateKey: identity.privateKey });
        const data = { ...body, proof };
        const authorizationHeaders = createRequestHeaders ? await createRequestHeaders(data)
            : projection && effectActionId ? await projection.createRequestHeaders({ method: 'POST', path, body: data,
                effectActionId, signal: input.signal }) : { Authorization: `Bearer ${input.credentials.token}` };
        if (!authorizationHeaders) return refuse('action_forbidden');
        const url = `${input.serverHttpBaseUrl}${path}`;
        const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorizationHeaders };
        return async (signal: AbortSignal) => {
            try {
                return await axios.request<unknown>({ method: 'POST', url, headers, data, signal,
                    maxRedirects: 0, validateStatus: () => true });
            } catch {
                return refuse(signal.aborted ? 'cancelled' : 'home_unreachable');
            }
        };
    };
    const request = async (path: string, body: EnvironmentSecretLaunchAdmissionBodyV1 | MachineConnectorSecretGrantBodyV1,
        effectActionId?: string) => {
        const send = await prepareRequest(path, body, effectActionId);
        const response = await send(input.signal);
        await assertAuthority();
        return response;
    };
    return { identity, request, prepareRequest, assertCurrent: assertAuthority, release() { released = true; } };
}

async function readEnvironmentSecretAdmissionForHost(input: HostSecretAdmissionRequest) {
    if (input.materialization.kind === 'deployment' && !input.context.operationAcceptance?.operationId) return refuse('operation_unavailable');
    const custody = createInstalledSecretTransportForHost(input);
    const body = EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ serverId: input.serverId,
        environmentId: input.environmentId, targetLinkId: input.targetLinkId,
        machineId: input.machineId, installationId: input.installationId,
        materialization: input.materialization.kind !== 'deployment' ? input.materialization : {
            ...input.materialization, actionOperationId: input.context.operationAcceptance?.operationId,
        } });
    const read = async () => {
        const response = await custody.request(`/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/secret-launch-admission`,
            body, input.materialization.kind === 'bindings'
                ? input.materialization.buildMachineId ? 'deployments.environments.update' : 'deployments.bindings.set'
                : input.materialization.kind === 'domain' && !input.materialization.use
                    ? input.context.externalActionExecutionAuthorization?.binding.actionId : undefined);
        const parsed = EnvironmentSecretLaunchAdmissionResultV1Schema.safeParse(response.data);
        if (!parsed.success) return refuse(response.status === 404 || response.status === 405 || response.status === 501
            ? 'unsupported_action' : response.status === 401 ? 'action_home_signed_out' : response.status === 403
                ? 'action_forbidden' : 'invalid_action_output');
        if (!parsed.data.ok) return refuse(parsed.data.error);
        if (response.status !== 200) return refuse('invalid_action_output');
        const { grants, bindingPreparation, domainAdmission } = parsed.data;
        return { grants, ...(bindingPreparation ? { bindingPreparation } : {}), ...(domainAdmission ? { domainAdmission } : {}) };
    };
    const admitted = await read();
    return { ...admitted, assertCurrent: custody.assertCurrent, release: custody.release };
}

export type MachineConnectorSecretGrantHostRequest = Omit<InstalledSecretHostInput, 'machineId' | 'installationId'> & Readonly<{
    serverId: string;
    hostMachineId: string;
    hostInstallationId: string;
    subject: MachineConnectorSecretGrantSubjectV1;
    /** P21's current admitted provider/connector/operation, never caller-authored authority. */
    assertCurrent(): Promise<void>;
    /** Same elevated invocation only: the live parent creates headers for this exact signed read. */
    createReadRequestHeaders?: (body: Extract<MachineConnectorSecretGrantInputV1, { operation: 'read' }>) => Promise<Readonly<Record<string, string>>>;
}>;

/** Capture every admitted Domain target; Account code supplies only the connector and token. */
export function bindMachineConnectorSecretsForHost(input: Omit<MachineConnectorSecretGrantHostRequest,
    'subject' | 'hostMachineId' | 'hostInstallationId'> & Readonly<{
    domainAdmissions: readonly EnvironmentDomainSecretLaunchAdmissionV1[];
    onGrant?: (grant: Readonly<{ machineId: string; installationId: string; grantRef: string }>) => void;
}>): NonNullable<PluginAccountActionContext['services']['machineConnectorSecrets']> {
    const { domainAdmissions, onGrant, ...host } = input;
    type Write = NonNullable<PluginAccountActionContext['services']['machineConnectorSecrets']>['write'];
    return Object.freeze({
        async write({ token, subject }: Parameters<Write>[0]) {
            const grants: { machineId: string; installationId: string; grantRef: string }[] = [];
            for (const { controller, target, actionOperationId } of domainAdmissions) {
                const written = await writeMachineConnectorSecretGrantForHost({
                    ...host, context: { ...host.context, operationAcceptance: { operationId: actionOperationId } }, token,
                    installationPublicKey: decodeBase64(target.publicKey, 'base64url'),
                    hostMachineId: controller.machineId, hostInstallationId: controller.installationId,
                    subject: { v: 1, kind: 'connectorToken', machineId: target.machineId,
                        installationId: target.installationId, provider: subject.provider, connectorId: subject.connectorId },
                });
                const grant = { machineId: target.machineId, installationId: target.installationId, grantRef: written.grantRef };
                grants.push(grant);
                onGrant?.(grant);
            }
            return { grants };
        },
    });
}

function exactConnectorRef(input: MachineConnectorSecretGrantHostRequest, grantRef: string) {
    const subject = parseMachineSecretGrantSubjectKey(grantRef);
    if (!subject || subject.kind !== 'connectorToken'
        || machineSecretGrantSubjectKey(input.subject) !== grantRef) return refuse('secret_missing');
}

export function machineConnectorSecretGrantPathForHost(machineId: string): string {
    return `/v1/deployments/machines/${encodeURIComponent(machineId)}/connector-secret-grant`;
}

async function createConnectorSecretTransportForHost(input: MachineConnectorSecretGrantHostRequest) {
    if (!input.context.operationAcceptance?.operationId) return refuse('operation_unavailable');
    const custody = createInstalledSecretTransportForHost({ ...input,
        machineId: input.hostMachineId, installationId: input.hostInstallationId }, input.createReadRequestHeaders ? async body => {
        const parsed = MachineConnectorSecretGrantInputV1Schema.parse(body);
        if (parsed.operation !== 'read') return refuse('action_forbidden');
        return await input.createReadRequestHeaders!(parsed);
    } : undefined);
    try {
        await custody.assertCurrent();
        const actionId = input.context.externalActionExecutionAuthorization?.binding.actionId;
        // Domain effects carry their accepted child to Home. Its active-job
        // lookup owns this request; local custody only observes cancellation.
        if (actionId !== 'deployments.domains.add' && actionId !== 'deployments.domains.remove') {
            await assertDeploymentSecretInvocationCurrent(input.context, input.signal);
            await input.assertCurrent();
        }
        await custody.assertCurrent();
    } catch (error) { custody.release(); throw error; }
    const projectResponse = (response: Readonly<{ status: number; data: unknown }>) => {
        const parsed = MachineConnectorSecretGrantResultV1Schema.safeParse(response.data);
        if (!parsed.success) return refuse(response.status === 404 || response.status === 405 || response.status === 501
            ? 'unsupported_action' : response.status === 401 ? 'action_home_signed_out' : response.status === 403 ? 'action_forbidden' : 'invalid_action_output');
        if (!parsed.data.ok) return refuse(parsed.data.error);
        if (response.status !== 200) return refuse('invalid_action_output');
        const grant = parsed.data.grant;
        if (grant && (grant.kind !== 'connectorToken' || machineSecretGrantSubjectKey(grant) !== machineSecretGrantSubjectKey(input.subject))) {
            return refuse('secret_missing');
        }
        return grant;
    };
    const body = { serverId: input.serverId, hostMachineId: input.hostMachineId,
        hostInstallationId: input.hostInstallationId, subject: input.subject };
    const path = machineConnectorSecretGrantPathForHost(input.subject.machineId);
    const effectActionId = input.context.externalActionExecutionAuthorization?.binding.actionId;
    const request = async (operation: MachineConnectorSecretGrantBodyV1) => projectResponse(await custody.request(
        path, MachineConnectorSecretGrantBodyV1Schema.parse(operation), effectActionId));
    const prepareRemoval = async () => {
        const send = await custody.prepareRequest(path,
            MachineConnectorSecretGrantBodyV1Schema.parse({ ...body, operation: 'remove' }), effectActionId);
        // Exact proof and requester headers were captured while admitted. Cleanup
        // is a later natural HTTP boundary, not another local custody acquisition.
        const signal = new AbortController().signal;
        return async () => projectResponse(await send(signal));
    };
    return { ...custody, body, request, prepareRemoval };
}

/** P21 seals in its admitted controller invocation; only the canonical value-free ref leaves custody. */
export async function writeMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{
    installationPublicKey: Uint8Array; token: Uint8Array;
}>): Promise<Readonly<{ grantRef: string }>> {
    const custody = await createConnectorSecretTransportForHost(input);
    const bytes = input.token.slice();
    try {
        await custody.assertCurrent();
        const grant = sealMachineSecretGrant({ subject: input.subject, installationPublicKey: input.installationPublicKey,
            content: { kind: 'connectorToken', token: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } });
        const stored = await custody.request({ ...custody.body, operation: 'set', grant });
        if (!stored || stored.sealedContent !== grant.sealedContent) return refuse('invalid_action_output');
        return { grantRef: machineSecretGrantSubjectKey(input.subject) };
    } finally { bytes.fill(0); custody.release(); }
}

/** One finite acquisition shared by the sealed reader and protected-file materializer. */
async function acquireMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>) {
    exactConnectorRef(input, input.grantRef);
    if (input.hostMachineId !== input.subject.machineId || input.hostInstallationId !== input.subject.installationId) return refuse('secret_missing');
    const custody = await createConnectorSecretTransportForHost(input);
    try {
        const grant = await custody.request({ ...custody.body, operation: 'read' });
        if (!grant) return refuse('secret_missing');
        return { grant, custody };
    } catch (error) { custody.release(); throw error; }
}

/** Exact installed delivery; withdrawal is admitted again at the next acquisition. */
export async function readMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>) {
    const { grant, custody } = await acquireMachineConnectorSecretGrantForHost(input);
    return { grant, assertCurrent: custody.assertCurrent, release: custody.release };
}

/** Host-private P20 protected-file boundary. Installed seeds never leave this owner. */
export async function materializeMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>) {
    const { grant, custody } = await acquireMachineConnectorSecretGrantForHost(input);
    const key = decodeBase64(custody.identity.privateKey, 'base64url');
    let bytes: Uint8Array | undefined;
    try {
        const content = openMachineSecretGrant({ grant, machineId: input.subject.machineId,
            installationId: input.subject.installationId, installationPrivateSeed: key.subarray(0, 32) });
        if (content?.kind !== 'connectorToken') return refuse('secret_missing');
        bytes = new TextEncoder().encode(content.token);
        await custody.assertCurrent();
        const material = bytes;
        return { bytes: material, assertCurrent: custody.assertCurrent,
            dispose() { material.fill(0); custody.release(); } };
    } catch (error) { bytes?.fill(0); custody.release(); throw error; }
    finally { key.fill(0); }
}

export async function prepareMachineConnectorSecretGrantRemovalForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>): Promise<() => Promise<void>> {
    exactConnectorRef(input, input.grantRef);
    const custody = await createConnectorSecretTransportForHost(input);
    try {
        const remove = await custody.prepareRemoval();
        return async () => {
            try {
                if (await remove()) return refuse('invalid_action_output');
            } finally { custody.release(); }
        };
    } catch (error) { custody.release(); throw error; }
}

export async function removeMachineConnectorSecretGrantForHost(input: MachineConnectorSecretGrantHostRequest & Readonly<{ grantRef: string }>): Promise<void> {
    await (await prepareMachineConnectorSecretGrantRemovalForHost(input))();
}
