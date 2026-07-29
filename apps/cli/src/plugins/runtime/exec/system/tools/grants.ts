import type { PluginExecExecutableGrantRecord } from './definitions';

export type PluginExecExecutableGrantVerificationRequest = Readonly<{
    kind: 'system-tool' | 'agent-cli';
    grantId: string;
    executablePath: string;
}>;

export type PluginExecSystemToolGrantVerificationRequest = PluginExecExecutableGrantVerificationRequest;

export type PluginExecSystemToolGrantStore = Readonly<{
    register(grant: PluginExecExecutableGrantRecord): void;
    hasActivePathGrant(executablePath: string): boolean;
    verifyGrant(request: PluginExecExecutableGrantVerificationRequest): boolean;
}>;

export function createPluginExecSystemToolGrantStore(params?: Readonly<{
    now?: () => number;
}>): PluginExecSystemToolGrantStore {
    const grantsByPath = new Map<string, PluginExecExecutableGrantRecord>();
    const grantsById = new Map<string, PluginExecExecutableGrantRecord>();
    const now = (): number => params?.now?.() ?? Date.now();
    const isActive = (grant: PluginExecExecutableGrantRecord | undefined): grant is PluginExecExecutableGrantRecord =>
        grant !== undefined && (grant.expiresAt === null || grant.expiresAt > now());
    const readGrantKind = (grant: PluginExecExecutableGrantRecord): PluginExecExecutableGrantVerificationRequest['kind'] =>
        grant.kind ?? 'system-tool';

    return Object.freeze({
        register(grant) {
            grantsByPath.set(grant.executablePath, grant);
            grantsById.set(grant.grantId, grant);
        },
        hasActivePathGrant(executablePath) {
            return isActive(grantsByPath.get(executablePath));
        },
        verifyGrant(request) {
            const grant = grantsById.get(request.grantId);
            return isActive(grant)
                && readGrantKind(grant) === request.kind
                && grant.executablePath === request.executablePath;
        },
    });
}
