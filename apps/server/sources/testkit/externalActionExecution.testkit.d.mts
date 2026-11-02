import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { MachineConnectorSecretGrantSubjectV1 } from '@happier-dev/deployment-protocol';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';

export interface ExternalActionHomeForTestsOptions {
    readonly serverIdentityId: string;
    readonly accountId: string;
    readonly manageGranteeAccountId?: string;
    readonly machineId: string;
    readonly installationId: string;
    readonly installationPublicKey: Uint8Array;
    dispatch(packet: SocketRpcRequestPayload, options: Readonly<{ signal: AbortSignal }>): Promise<unknown>;
}

export interface ExternalActionHomeForTests {
    readonly token: string;
    readonly manageGrantee?: Readonly<{ accountId: string; token: string;
        machineAdmission: SocketRpcMachineAdmissionContextV1 }>;
    /** Actual exact-subject row observation, never read/admission authority. */
    readConnectorGrantCount(subject: MachineConnectorSecretGrantSubjectV1): Promise<number>;
    /** External fixture withdrawal through the existing repository owner. */
    removeConnectorGrant(subject: MachineConnectorSecretGrantSubjectV1): Promise<void>;
    request(method: 'POST', path: string, body: unknown, headers?: Readonly<Record<string, string>>,
        signal?: AbortSignal): Promise<Readonly<{ status: number; data: unknown }>>;
    close(): Promise<void>;
}

export function createExternalActionHomeProcessForTests(options: ExternalActionHomeForTestsOptions): Promise<ExternalActionHomeForTests>;
