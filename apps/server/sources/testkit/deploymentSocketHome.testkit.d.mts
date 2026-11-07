import type { Fastify } from '../app/api/types.js';

export interface DeploymentArtifactReference {
    contentArtifactId: string;
    contentHeaderVersion: number;
    contentBodyVersion: number;
}
export interface DeploymentSocketHomeFixture {
    readonly baseDir: string;
    readonly baseUrl: string;
    readonly accountId: string;
    readonly serverId: string;
    readonly machineId: string;
    readonly token: string;
    readonly daemonToken?: string;
    readonly installationId: string;
    readonly keys: Readonly<{ publicKey: Uint8Array; secretKey: Uint8Array }>;
    readonly encryptionMode: 'plain' | 'e2ee';
    readonly machineEncryptionKey: Uint8Array | null;
    readonly encryption: Readonly<{ type: 'dataKey'; machineKey: Uint8Array; publicKey: Uint8Array }> | null;
    prepareControllerProvisioner(manifest: unknown): Promise<void>;
    setControllerProvisionerFiniteOnly(finiteOnly: boolean): Promise<void>;
    readManagedEnrollment(machineId: string): Promise<Readonly<{
        managedId: string; enrolledMachineId: string | null; controllerMachineId: string; allocation: string;
    }> | null>;
    createContentArtifact(content: unknown, kind: string): Promise<DeploymentArtifactReference>;
    close(): Promise<void>;
}
export function createDeploymentSocketHome(options?: Readonly<{
    encryptionMode?: 'plain' | 'e2ee';
    prepareMachineContent?: (key: Uint8Array, metadata: Readonly<Record<string, unknown>>) => string | Promise<string>;
    configureApp?: (app: Fastify) => void | Promise<void>;
}>): Promise<DeploymentSocketHomeFixture>;
