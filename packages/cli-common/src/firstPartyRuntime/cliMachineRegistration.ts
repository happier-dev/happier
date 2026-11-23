import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/mini';
import { MachineReplacementReasonSchema } from '@happier-dev/protocol/machines/identity/machineReplacement';

const SERVER_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isServerIdFilesystemSafe(raw: string): boolean {
  const value = String(raw ?? '').trim();
  if (!value) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return SERVER_ID_SAFE_RE.test(value);
}

const CandidateSchema = z.object({ machineId: z.string(), replacementReason: MachineReplacementReasonSchema, createdAt: z.number() });
export type MachineReplacementCandidate = z.infer<typeof CandidateSchema>;

const MachineRegistrationSchema = z.object({
    machineId: z.optional(z.string()),
    machineIdByAccountId: z.optional(z.record(z.string(), z.string())),
    accountId: z.optional(z.string()),
    confirmedByServer: z.optional(z.boolean()),
    replacementCandidates: z.optional(z.record(z.string(), CandidateSchema)),
});
export type MachineRegistration = z.infer<typeof MachineRegistrationSchema>;

export function resolveMachineRegistrationPath(serversDir: string, serverId: string): string {
    if (!isServerIdFilesystemSafe(serverId)) throw new Error('Invalid Machine registration Home');
    return join(serversDir, serverId.trim(), 'machine-registration.json');
}

export async function readRegistrationJsonIfPresent(path: string): Promise<unknown> {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

export async function readStoredMachineRegistration(path: string): Promise<MachineRegistration | undefined> {
    const data = await readRegistrationJsonIfPresent(path);
    return data === undefined ? undefined : MachineRegistrationSchema.parse(data);
}

const ReleasedIdentityKeys = {
    machineIdByServerId: 'machineId',
    machineIdByServerIdByAccountId: 'machineIdByAccountId',
    lastTokenSubByServerId: 'accountId',
    machineIdConfirmedByServerByServerId: 'confirmedByServer',
    machineReplacementCandidatesByServerIdByAccountId: 'replacementCandidates',
} as const;

const retiredSettingsKeys = [...Object.keys(ReleasedIdentityKeys), 'machineId', 'machineIdConfirmedByServer'];

export function hasReleasedMachineRegistrationKeys(settings: object): boolean {
    return retiredSettingsKeys.some(key => Object.hasOwn(settings, key));
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read released Settings only at the one-way import boundary. The scoped file, even empty, replaces the source. */
export async function readReleasedMachineRegistrations(settingsFile: string): Promise<Map<string, MachineRegistration>> {
    const raw = asRecord(await readRegistrationJsonIfPresent(settingsFile).catch(error => {
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }));
    const registrations = new Map<string, MachineRegistration>();
    for (const [source, field] of Object.entries(ReleasedIdentityKeys)) {
        for (const [serverId, value] of Object.entries(asRecord(raw[source]))) {
            if (!isServerIdFilesystemSafe(serverId)) continue;
            const id = serverId.trim();
            const candidate = MachineRegistrationSchema.safeParse({ ...registrations.get(id), [field]: value });
            if (candidate.success) registrations.set(id, candidate.data);
        }
    }
    if (Number(raw.schemaVersion ?? 1) < 5 && !registrations.has('cloud')) {
        const candidate = MachineRegistrationSchema.safeParse({ machineId: raw.machineId, confirmedByServer: raw.machineIdConfirmedByServer });
        if (candidate.success && (candidate.data.machineId || candidate.data.confirmedByServer !== undefined)) {
            registrations.set('cloud', candidate.data);
        }
    }
    return registrations;
}

export function omitReleasedMachineRegistrationKeys<T extends object>(settings: T): T {
    const copy = { ...settings };
    const raw = copy as Record<string, unknown>;
    for (const key of retiredSettingsKeys) delete raw[key];
    return copy;
}

export function resolveRegisteredMachineId(registration: MachineRegistration, accountId = registration.accountId?.trim() || null): string | null {
    if (registration.machineIdByAccountId) {
        return accountId && Object.hasOwn(registration.machineIdByAccountId, accountId)
            ? registration.machineIdByAccountId[accountId]?.trim() || null : null;
    }
    return registration.machineId?.trim() || null;
}
