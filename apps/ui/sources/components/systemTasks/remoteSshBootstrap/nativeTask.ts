import { SystemTaskSpecSchema, parseSshTarget, type SystemTaskSpec } from '@happier-dev/protocol';

import type { NativeSystemTaskEventInput } from '../bridges/events';
import {
    NATIVE_SSH_BOOTSTRAP_TASK_KIND,
    type NativeSshModule,
    type NativeSshTaskCredentials,
} from '../bridges/native';

export type NativeSshBootstrapTaskInput = Readonly<{
    remoteHostId: string | null;
    ssh: Readonly<{
        target: string;
        host: string;
        username: string;
        port: number;
        auth: 'agent' | 'keyfile' | 'password';
        password?: string;
        identityPrivateKey?: string;
    }>;
}>;

export type NativeSshRunBootstrapTaskParams = Readonly<{
    spec: SystemTaskSpec;
    taskId: string;
    nativeSsh: NativeSshModule | null;
    emit: (event: NativeSystemTaskEventInput) => void;
    prompt: (event: NativeSystemTaskEventInput) => Promise<unknown>;
}>;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readPort(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(readString(value), 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 22;
}

function readSshAuth(value: unknown): 'agent' | 'keyfile' | 'password' {
    return value === 'keyfile' || value === 'password' ? value : 'agent';
}

export function parseNativeSshBootstrapTaskInput(spec: SystemTaskSpec): NativeSshBootstrapTaskInput {
    const parsedSpec = SystemTaskSpecSchema.parse(spec);
    if (parsedSpec.kind !== NATIVE_SSH_BOOTSTRAP_TASK_KIND) {
        throw new Error(`Unsupported native SSH bootstrap task kind: ${parsedSpec.kind}`);
    }

    const params = asRecord(parsedSpec.params);
    const ssh = asRecord(params.ssh);
    const target = readString(ssh.target);
    const parsedTarget = parseSshTarget(target);
    const host = readString(parsedTarget.host);
    const username = readString(parsedTarget.username);
    if (!host || !username) {
        throw new Error('Native SSH bootstrap requires an SSH target with username and host.');
    }

    return {
        remoteHostId: readString(params.remoteHostId) || null,
        ssh: {
            target,
            host,
            username,
            port: readPort(ssh.port),
            auth: readSshAuth(ssh.auth),
            ...(readString(ssh.password) ? { password: readString(ssh.password) } : {}),
            ...(readString(ssh.identityPrivateKey) ? { identityPrivateKey: readString(ssh.identityPrivateKey) } : {}),
        },
    };
}

export function buildNativeSshTaskCredentials(input: NativeSshBootstrapTaskInput): NativeSshTaskCredentials {
    return {
        host: input.ssh.host,
        port: input.ssh.port,
        username: input.ssh.username,
        auth: {
            username: input.ssh.username,
            ...(input.ssh.auth === 'password' && input.ssh.password ? { password: input.ssh.password } : {}),
            ...(input.ssh.auth === 'keyfile' && input.ssh.identityPrivateKey ? { privateKeyPem: input.ssh.identityPrivateKey } : {}),
        },
    };
}

export async function runNativeRemoteSshBootstrapTask(params: NativeSshRunBootstrapTaskParams): Promise<unknown> {
    parseNativeSshBootstrapTaskInput(params.spec);
    params.emit({
        type: 'started',
        stepId: 'prepare',
        message: 'Preparing native SSH bootstrap.',
    });
    throw new Error('Native SSH bootstrap requires the RAU-8 native SSH engine spike before execution can run.');
}
