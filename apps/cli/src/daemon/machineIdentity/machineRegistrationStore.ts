import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
    readReleasedMachineRegistrations, readStoredMachineRegistration, resolveMachineRegistrationPath,
    resolveRegisteredMachineId, type MachineRegistration, type MachineReplacementCandidate,
} from '@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration';
export {
    hasReleasedMachineRegistrationKeys, omitReleasedMachineRegistrationKeys, resolveRegisteredMachineId,
    type MachineRegistration, type MachineReplacementCandidate,
} from '@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration';
import { configuration } from '@/configuration';
import { isServerIdFilesystemSafe, sanitizeServerIdForFilesystem } from '@/server/serverId';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';

export function activeMachineRegistrationServerId(): string {
    return sanitizeServerIdForFilesystem(configuration.activeServerId, 'cloud');
}

function getRegistrationPath(serverId: string): string {
    return resolveMachineRegistrationPath(configuration.serversDir, serverId);
}

async function updateRegistrationFile(
    path: string,
    updater: (current: MachineRegistration, stored: boolean) => MachineRegistration | Promise<MachineRegistration>,
    readReleased: () => Promise<MachineRegistration | undefined>,
): Promise<MachineRegistration> {
    return withJsonOwnerFileLock({ lockPath: `${path}.lock`, timeoutMs: 5000, staleAfterMs: 10000,
        errorCode: 'machine_registration_lock_timeout' }, async () => {
        const stored = await readStoredMachineRegistration(path);
        const current = stored ?? await readReleased() ?? {};
        const next = { ...await updater(current, stored !== undefined) };
        for (const key of Object.keys(next) as Array<keyof MachineRegistration>) {
            if (next[key] === undefined) delete next[key];
        }
        if (!stored || !isDeepStrictEqual(stored, next)) writeJsonAtomicSync(path, next);
        return next;
    });
}

export async function ensureReleasedMachineRegistrationsImported(): Promise<void> {
    const released = await readReleasedMachineRegistrations(configuration.settingsFile);
    for (const [serverId, registration] of released) {
        const path = getRegistrationPath(serverId);
        if (await readStoredMachineRegistration(path)) continue;
        await updateRegistrationFile(path, current => current, async () => registration);
    }
}

export async function readMachineRegistration(serverId = activeMachineRegistrationServerId()): Promise<MachineRegistration> {
    const path = getRegistrationPath(serverId);
    const stored = await readStoredMachineRegistration(path);
    if (stored) return stored;
    const released = (await readReleasedMachineRegistrations(configuration.settingsFile)).get(serverId);
    if (!released) return {};
    return updateRegistrationFile(path, current => current, async () => released);
}

export function updateMachineRegistration(
    updater: (current: MachineRegistration) => MachineRegistration | Promise<MachineRegistration>,
    serverId = activeMachineRegistrationServerId(),
): Promise<MachineRegistration> {
    return updateRegistrationFile(getRegistrationPath(serverId), updater,
        async () => (await readReleasedMachineRegistrations(configuration.settingsFile)).get(serverId));
}

export async function adoptMachineRegistrationIfMissing(sourceId: string, targetId: string, adoptCredentials: () => Promise<void>): Promise<void> {
    const source = await readMachineRegistration(sourceId);
    await updateRegistrationFile(getRegistrationPath(targetId), async (current, stored) => {
        if (stored || Object.keys(current).length > 0) return current;
        await adoptCredentials();
        return source;
    },
        async () => (await readReleasedMachineRegistrations(configuration.settingsFile)).get(targetId));
}

export async function readMachineRegistrations(): Promise<ReadonlyArray<readonly [string, MachineRegistration]>> {
    const [dirs, released] = await Promise.all([
        readdir(configuration.serversDir, { withFileTypes: true }),
        readReleasedMachineRegistrations(configuration.settingsFile),
    ]);
    const serverIds = new Set([...released.keys(),
        ...dirs.filter(dir => dir.isDirectory() && isServerIdFilesystemSafe(dir.name)).map(dir => dir.name)]);
    const registrations = await Promise.all([...serverIds].map(async serverId => {
        const registration = await readStoredMachineRegistration(getRegistrationPath(serverId)) ?? released.get(serverId);
        return registration ? [serverId, registration] as const : null;
    }));
    return registrations.filter(entry => entry !== null);
}

export async function readActiveMachineId(): Promise<string | null> {
    return resolveRegisteredMachineId(await readMachineRegistration());
}

export async function readRegisteredMachineId(serverId: string, accountId: string | null): Promise<string | null> {
    return resolveRegisteredMachineId(await readMachineRegistration(serverId), accountId);
}

export async function ensureLocalMachineId(opts?: Readonly<{ forceNew?: boolean; accountId?: string | null }>): Promise<{ machineId: string }> {
    const accountId = opts?.accountId?.trim() ?? '';
    const registration = await updateMachineRegistration(current => {
        const previousMachineId = current.machineId?.trim();
        if (!accountId) return {
            ...current, accountId: undefined, confirmedByServer: undefined,
            machineId: !opts?.forceNew && previousMachineId ? previousMachineId : randomUUID(),
        };
        const previousAccount = current.accountId?.trim();
        const didAccountSwap = previousAccount && previousAccount !== accountId;
        const existingForAccount = Object.hasOwn(current.machineIdByAccountId ?? {}, accountId)
            ? current.machineIdByAccountId?.[accountId]?.trim() : undefined;
        const machineId = (!opts?.forceNew && (existingForAccount || (!didAccountSwap && previousMachineId))) || randomUUID();
        return {
            ...current, machineId, accountId,
            machineIdByAccountId: { ...current.machineIdByAccountId, [accountId]: machineId },
            confirmedByServer: previousMachineId === machineId && previousAccount === accountId ? current.confirmedByServer : undefined,
        };
    });
    if (!registration.machineId) throw new Error('Failed to ensure local Machine registration');
    return { machineId: registration.machineId };
}

export async function clearMachineId(opts?: Readonly<{
    preserveReplacementCandidate?: boolean;
    replacementAccountId?: string | null;
    replacementReason?: MachineReplacementCandidate['replacementReason'];
    now?: number;
}>): Promise<void> {
    await updateMachineRegistration(current => {
        const currentMachineId = current.machineId?.trim();
        const currentAccountId = opts?.replacementAccountId?.trim() || current.accountId?.trim();
        const replacementCandidates = opts?.preserveReplacementCandidate && currentMachineId && currentAccountId
            ? { ...current.replacementCandidates, [currentAccountId]: {
                machineId: currentMachineId, replacementReason: opts.replacementReason ?? 'reauth', createdAt: opts.now ?? Date.now(),
            } }
            : current.replacementCandidates;
        return replacementCandidates ? { replacementCandidates } : {};
    });
}
