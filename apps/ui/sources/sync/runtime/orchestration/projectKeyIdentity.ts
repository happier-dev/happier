import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';

/**
 * The project key's machine-scope derivation — a pure function of session metadata.
 *
 * It lives beside `projectManager` rather than inside it because it is the one part of the project
 * key that has nothing to do with the manager's mutable state: `addSession` uses it to key a
 * record, and several readers (SCM scope resolution, the recent-path projection's pure resolver,
 * the display-target resolver) need the same derivation without touching the singleton at all.
 * Keeping it in the 800-line stateful module forced every one of those readers to import the
 * manager, which in turn made a test that stubs the singleton also have to stub a pure function it
 * never wanted to replace.
 */

/**
 * Synthetic machine scope used to key projects for sessions whose metadata never
 * received a machineId. It is a grouping key only — it never corresponds to a real,
 * routable machine and must not be used as an RPC/control target.
 */
export const UNKNOWN_PROJECT_MACHINE_SCOPE_ID = 'unknown';

export function normalizeKnownProjectMachineId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === UNKNOWN_PROJECT_MACHINE_SCOPE_ID) return null;
    return trimmed;
}

export function resolveProjectMachineScopeId(metadata: {
    machineId?: string | null;
    host?: string | null;
    directSessionV1?: unknown;
}): string {
    const machineId = resolveSessionMachineId(metadata) ?? '';
    if (machineId) return machineId;
    return UNKNOWN_PROJECT_MACHINE_SCOPE_ID;
}
