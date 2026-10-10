import * as privacyKit from "privacy-kit";
import {
    readHomeAuthenticationPolicyV1,
    isHomeGovernanceSettingKey,
    validateHomeSettingsWrite,
    type HomeSettingEntryV1,
    type HomeSettingsInvalidReasonV1,
    type HomeSettingsProjectionV1,
    type HomeSettingsSetInputV1,
    type ServerConfigEntry,
    type ServerConfigEnv,
    type ServerConfigRegistry,
    type ServerConfigValue,
} from "@happier-dev/protocol";

import { resolveFeatureDecisionsFromEnv } from "@/app/features/registry";
import { recordHomeAdministrationEventInTx, type HomeAdministrationActor } from "@/app/home/audit/homeAdministrationEvents";
import { homeAuthenticationPolicyConfigValues } from "@/app/home/governance/homeAuthenticationPolicyEnv";
import { findRetentionPolicyEnvProblem } from "@/app/retention/config/readRetentionPolicyFromEnv";
import { publishHomeGovernanceChangedInTx } from "@/app/home/governance/governanceChanges";
import { authorizeHomeGovernanceMutationInTx } from "@/app/home/governance/homeCapabilities";
import { peekInferredPublicServerUrl } from "@/app/integrations/publicUrl/publicServerUrlInference";
import { SERVER_CONFIG_REGISTRY } from "@/config/serverConfigRegistry";
import { decryptString, encryptString } from "@/modules/encrypt";
import { db, isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { buildHomeConfigEnv, composeHomeConfigEnv, projectHomeSettings } from "./homeConfigOverlay";
import { readHomeDeploymentEnv, readStartupHomeEnv, type StoredHomeSettings } from "./startupHomeEnv";

/**
 * The persisted Home settings (plan `2026-09-26-home-owner-console` §3.1 "Persisted Home settings").
 *
 * One row, `id = 'home'`. `values` holds typed values for `editable: 'home'` registry entries keyed
 * by env name. Secrets never enter `values`: each is sealed on its own with the server's at-rest key
 * (`modules/encrypt.ts`, `docs/encryption.md`) and kept in `encryptedSecrets` as a JSON map of env
 * name to ciphertext, so a projection can report which secrets are set without opening any, and an
 * unreadable ciphertext is reported for that key alone. Writes are compare-and-set on `revision`.
 */
export const HOME_SETTINGS_ID = "home";

type SealedSecrets = Readonly<Record<string, string>>;

export type HomeSettingsRecord = Readonly<{
    /** `0` while no row exists. */
    revision: number;
    values: Readonly<Record<string, unknown>>;
    sealedSecrets: SealedSecrets;
}>;

const EMPTY_RECORD: HomeSettingsRecord = Object.freeze({ revision: 0, values: Object.freeze({}), sealedSecrets: Object.freeze({}) });

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

function secretPath(key: string): string[] {
    return ["storage", "HomeSettings", HOME_SETTINGS_ID, "secrets", key, "v1"];
}

function readJsonObject(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function parseSealedSecrets(bytes: Uint8Array | null): SealedSecrets {
    if (!bytes || bytes.length === 0) return {};
    try {
        const parsed = readJsonObject(JSON.parse(new TextDecoder().decode(bytes)));
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") out[key] = value;
        return out;
    } catch {
        return {};
    }
}

function encodeSealedSecrets(sealed: SealedSecrets): Uint8Array<ArrayBuffer> | null {
    if (Object.keys(sealed).length === 0) return null;
    return new TextEncoder().encode(JSON.stringify(sealed)) as Uint8Array<ArrayBuffer>;
}

function sealSecret(key: string, text: string): string {
    return privacyKit.encodeBase64(encryptString(secretPath(key), text));
}

/** Opens one sealed secret; `null` when the ciphertext can no longer be opened (e.g. a new master secret). */
function openSecret(key: string, sealed: string): string | null {
    try {
        return decryptString(secretPath(key), privacyKit.decodeBase64(sealed) as Uint8Array<ArrayBuffer>);
    } catch {
        return null;
    }
}

type HomeSettingsRow = Readonly<{ revision: number; values: unknown; encryptedSecrets: Uint8Array | null }>;

function toRecord(row: HomeSettingsRow | null): HomeSettingsRecord {
    if (!row) return EMPTY_RECORD;
    return { revision: row.revision, values: readJsonObject(row.values), sealedSecrets: parseSealedSecrets(row.encryptedSecrets) };
}

const ROW_SELECT = { revision: true, values: true, encryptedSecrets: true } as const;

export async function readHomeSettingsInTx(tx: Tx): Promise<HomeSettingsRecord> {
    return toRecord(await tx.homeSettings.findUnique({ where: { id: HOME_SETTINGS_ID }, select: ROW_SELECT }));
}

async function readHomeSettings(): Promise<HomeSettingsRecord> {
    return toRecord(await db.homeSettings.findUnique({ where: { id: HOME_SETTINGS_ID }, select: ROW_SELECT }));
}

/** Opens the sealed secrets of the given keys (all when omitted), marking the ones that cannot be opened. */
export function openHomeSettingSecrets(
    record: HomeSettingsRecord,
    keys?: readonly string[],
): Record<string, string | Readonly<{ unreadable: true }>> {
    const out: Record<string, string | Readonly<{ unreadable: true }>> = {};
    for (const key of keys ?? Object.keys(record.sealedSecrets)) {
        if (!hasOwn(record.sealedSecrets, key)) continue;
        out[key] = openSecret(key, record.sealedSecrets[key]!) ?? { unreadable: true };
    }
    return out;
}

function liveSecretKeys(record: HomeSettingsRecord, registry: ServerConfigRegistry): string[] {
    return Object.keys(record.sealedSecrets).filter((key) => {
        const entry = hasOwn(registry, key) ? registry[key] : undefined;
        return entry?.editable === "home" && entry.apply === "live";
    });
}

/** Builds the request/job overlay from a stored record: live values and opened live secrets. */
export function buildHomeConfigEnvFromRecord(
    base: ServerConfigEnv,
    record: HomeSettingsRecord,
    registry: ServerConfigRegistry = SERVER_CONFIG_REGISTRY,
    /** The Home authentication policy's env values (§3.4), owned by the governance policy. */
    policyValues: PersistedPolicyValues = {},
): ServerConfigEnv {
    const opened: Record<string, string> = {};
    for (const [key, secret] of Object.entries(openHomeSettingSecrets(record, liveSecretKeys(record, registry)))) {
        if (typeof secret === "string") opened[key] = secret;
    }
    const origin = { base, settingsValues: record.values, policyValues, openedSecrets: opened };
    // Even an empty Home resolves to a distinct snapshot: downstream Home readers must not
    // mistake process.env for an unresolved source and read the same rows again mid-request.
    const overlay = composeHomeConfigEnv(origin, { registry, snapshot: true });
    // §3.2: the public address falls back to what the hosting computer infers, last and read-only.
    // Peeking never waits; it probes only when neither the deployment nor the owner set an address.
    if (overlay.HAPPIER_PUBLIC_SERVER_URL?.trim()) return overlay;
    const inferred = peekInferredPublicServerUrl(process.env);
    return inferred
        ? composeHomeConfigEnv({ ...origin, inferred: { HAPPIER_PUBLIC_SERVER_URL: inferred.url } }, { registry, snapshot: true })
        : overlay;
}

/**
 * The request/job overlay (§3.1 "Request/job-scoped configuration"): one indexed row read, then the
 * `apply: 'live'` Home values over `base` for every key the deployment leaves unset. Restart keys keep
 * the values this process started with. No process cache: every replica reads the same row.
 */
export async function readHomeConfigEnv(base: ServerConfigEnv = process.env): Promise<ServerConfigEnv> {
    const [record, policyValues] = await inTx(tx => Promise.all([
        readHomeSettingsInTx(tx), readHomeAuthenticationPolicyValues(tx),
    ]), { readOnly: true });
    return buildHomeConfigEnvFromRecord(base, record, SERVER_CONFIG_REGISTRY, policyValues);
}

/**
 * The same overlay as `readHomeConfigEnv`, read inside an open transaction (SQLite runs one
 * connection, so code already in a transaction must not read through `db`).
 */
export async function readHomeConfigEnvInTx(tx: Tx, base: ServerConfigEnv = process.env): Promise<ServerConfigEnv> {
    const record = await readHomeSettingsInTx(tx);
    const policyValues = await readHomeAuthenticationPolicyValues(tx);
    return buildHomeConfigEnvFromRecord(base, record, SERVER_CONFIG_REGISTRY, policyValues);
}

type PersistedPolicyValues = Readonly<Record<string, ServerConfigValue>>;

/**
 * §3.4: the Home side of the sign-in and storage ceiling keys lives in the governance policy
 * document, not in `values`; it joins the same precedence rule here, as persisted Home values.
 */
async function readHomeAuthenticationPolicyValues(client: Pick<Tx, "homeGovernancePolicy">): Promise<PersistedPolicyValues> {
    const row = await client.homeGovernancePolicy.findUnique({
        where: { id: "home" },
        select: { authenticationPolicy: true },
    });
    return homeAuthenticationPolicyConfigValues(readHomeAuthenticationPolicyV1(row?.authenticationPolicy ?? null));
}

/** What startup composition applies (`loadStartupHomeEnv`): stored values and opened restart secrets. */
export async function readStoredHomeSettingsForStartup(
    registry: ServerConfigRegistry = SERVER_CONFIG_REGISTRY,
): Promise<StoredHomeSettings> {
    const record = await readHomeSettings();
    const restartSecretKeys = Object.keys(record.sealedSecrets).filter((key) => {
        const entry = hasOwn(registry, key) ? registry[key] : undefined;
        return entry?.editable === "home" && entry.apply === "restart";
    });
    const policyValues = await readHomeAuthenticationPolicyValues(db);
    return { values: { ...record.values, ...policyValues }, secrets: openHomeSettingSecrets(record, restartSecretKeys) };
}

/** Whether a stored secret exists for `key` but can no longer be opened. */
export function isHomeSettingSecretUnreadable(record: HomeSettingsRecord, key: string): boolean {
    const opened = openHomeSettingSecrets(record, [key])[key];
    return opened !== undefined && typeof opened !== "string";
}

async function projectRecordInTx(
    tx: Tx,
    record: HomeSettingsRecord,
    registry: ServerConfigRegistry,
): Promise<HomeSettingsProjectionV1> {
    const policyValues = await readHomeAuthenticationPolicyValues(tx);
    const startup = readStartupHomeEnv();
    const entries: HomeSettingEntryV1[] = projectHomeSettings({
        registry,
        env: readHomeDeploymentEnv(),
        persisted: { ...record.values, ...policyValues },
        persistedSecretKeys: Object.keys(record.sealedSecrets),
        persistedRestartSecrets: openHomeSettingSecrets(record, Object.keys(record.sealedSecrets).filter((key) => registry[key]?.apply === "restart")),
        startup,
    }).map((row) => ({ ...row }));
    // The same overlay a request would read, answered by the canonical feature decision engine.
    const featureDecisions = resolveFeatureDecisionsFromEnv(buildHomeConfigEnvFromRecord(process.env, record, registry, policyValues));
    return { revision: record.revision, startedAt: startup?.snapshot.appliedAt ?? null, entries, featureDecisions };
}

export type HomeSettingsReadResult =
    | Readonly<{ status: "ok"; projection: HomeSettingsProjectionV1 }>
    | Readonly<{ status: "forbidden" }>;

/** `home.settings.get`: Home administrators read (owners and admins, `viewAdministration`). */
export async function readHomeSettingsProjectionInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; registry?: ServerConfigRegistry }>,
): Promise<HomeSettingsReadResult> {
    const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
        actorAccountId: input.actorAccountId,
        request: { operation: "view" },
    });
    if (authorization.status === "rejected") return { status: "forbidden" };
    return { status: "ok", projection: await projectRecordInTx(tx, await readHomeSettingsInTx(tx), input.registry ?? SERVER_CONFIG_REGISTRY) };
}

/**
 * §3.4: the Home side of the sign-in and encryption ceiling lives in `HomeGovernancePolicy`, whose
 * owner runs the viable-login check; those registry entries give the console their lock/source
 * state but are never stored here (U4 routes their writes to the governance document).
 */
function isGovernanceRoutedEntry(entry: ServerConfigEntry): boolean {
    return isHomeGovernanceSettingKey(entry.key);
}

/**
 * §3.2: the direct-connection mode is written only by the reachability owner, which runs the Iroh
 * retirement or re-creation together with it; a bare settings write would store a mode nothing
 * applies until the next start.
 */
export const REACHABILITY_ROUTED_SETTING_KEYS: ReadonlySet<string> = new Set(["HAPPIER_HOME_IROH_MODE"]);

export type HomeSettingsSetResult =
    | Readonly<{ status: "applied"; projection: HomeSettingsProjectionV1 }>
    | Readonly<{ status: "forbidden" }>
    | Readonly<{ status: "revision_conflict" }>
    | Readonly<{ status: "invalid"; key: string; reason: HomeSettingsInvalidReasonV1 }>
    /** The write asked for a discard together with values or secrets (the route answers `invalid_home_input`). */
    | Readonly<{ status: "invalid_input" }>;

class HomeSettingsCreateConflictError extends Error {
    constructor() {
        super("home_settings_create_conflict");
        this.name = "HomeSettingsCreateConflictError";
    }
}

type SettingChange =
    | Readonly<{ secret: false; key: string; from: ServerConfigValue | null; to: ServerConfigValue | null }>
    | Readonly<{ secret: true; key: string; from: "set" | "unset"; to: "set" | "unset" }>;

type SettingsWrite = Pick<HomeSettingsSetInputV1, "values" | "secrets">;

/**
 * Discard (§3.14 r3): the write that returns every pending `apply: 'restart'` value to what this
 * process started with. "Pending" is the projection's own answer (stored ≠ the startup snapshot's
 * applied value), so the page and the discard agree by construction. A key this process took from
 * the Home gets that value back (a secret is sealed again from the opened value it runs with); a
 * key it ran on env or its default is cleared. Keys another owner writes (the governance policy,
 * the reachability owner) are left to that owner. Without a startup snapshot nothing is pending.
 */
function discardPendingRestartWrite(
    registry: ServerConfigRegistry,
    projection: HomeSettingsProjectionV1,
): SettingsWrite {
    const startup = readStartupHomeEnv();
    const values: Record<string, ServerConfigValue | null> = {};
    const secrets: Record<string, NonNullable<HomeSettingsSetInputV1["secrets"]>[string]> = {};
    if (!startup) return { values, secrets };
    const appliedFromHome = new Set(startup.snapshot.applied);
    for (const row of projection.entries) {
        if (row.applied?.pending !== true || row.editable !== "home" || row.fixed) continue;
        const entry = hasOwn(registry, row.key) ? registry[row.key] : undefined;
        if (!entry || entry.apply !== "restart" || isGovernanceRoutedEntry(entry) || REACHABILITY_ROUTED_SETTING_KEYS.has(entry.key)) continue;
        const running = appliedFromHome.has(entry.key) ? startup.env[entry.key] : undefined;
        if (entry.sensitivity === "secret") {
            secrets[entry.key] = running !== undefined ? { replace: running } : { clear: true };
        } else {
            values[entry.key] = running !== undefined ? (row.applied.value as ServerConfigValue | null) : null;
        }
    }
    return { values, secrets };
}

/**
 * Applies one partial write under compare-and-set on `revision` (owners only, `manageHomeSettings`).
 * Every key is validated against the registry before anything is written; the first failing key is
 * reported. Each changed key is recorded in the audit trail in this transaction (`{key, from, to}`;
 * a secret reads only `unset → set`). With `discardPendingRestart` the write is derived from the
 * startup snapshot instead (`discardPendingRestartWrite`) and each key is recorded as a discard.
 */
export async function setHomeSettingsInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        write: HomeSettingsSetInputV1;
        registry?: ServerConfigRegistry;
        /** Set only by a domain owner that applies these routed keys itself (the reachability owner). */
        routedKeys?: ReadonlySet<string>;
    }>,
): Promise<HomeSettingsSetResult> {
    const registry = input.registry ?? SERVER_CONFIG_REGISTRY;
    const authorization = await authorizeHomeGovernanceMutationInTx(tx, {
        actorAccountId: input.actorAccountId,
        request: { operation: "manage_home_settings" },
    });
    if (authorization.status === "rejected") return { status: "forbidden" };

    const discard = input.write.discardPendingRestart === true;
    let requested: SettingsWrite = { values: input.write.values, secrets: input.write.secrets };
    if (discard) {
        if (Object.keys(input.write.values).length > 0 || Object.keys(input.write.secrets ?? {}).length > 0) {
            return { status: "invalid_input" };
        }
        requested = discardPendingRestartWrite(registry, await projectRecordInTx(tx, await readHomeSettingsInTx(tx), registry));
    }

    const validation = validateHomeSettingsWrite(registry, { values: requested.values, secrets: requested.secrets });
    if (!validation.ok) return { status: "invalid", key: validation.key, reason: validation.reason };
    for (const key of [...Object.keys(validation.values), ...Object.keys(validation.secrets)]) {
        if (isGovernanceRoutedEntry(registry[key]!)) return { status: "invalid", key, reason: "not_home_editable" };
        if (REACHABILITY_ROUTED_SETTING_KEYS.has(key) && !input.routedKeys?.has(key)) {
            return { status: "invalid", key, reason: "not_home_editable" };
        }
    }

    const current = await readHomeSettingsInTx(tx);
    if (input.write.expectedRevision !== current.revision) return { status: "revision_conflict" };

    const values: Record<string, unknown> = { ...current.values };
    const sealed: Record<string, string> = { ...current.sealedSecrets };
    const changes: SettingChange[] = [];
    for (const [key, next] of Object.entries(validation.values)) {
        const previous = hasOwn(values, key) ? (values[key] as ServerConfigValue) : null;
        if (next === null) delete values[key];
        else values[key] = next;
        if (JSON.stringify(previous) !== JSON.stringify(next)) changes.push({ secret: false, key, from: previous, to: next });
    }
    for (const [key, next] of Object.entries(validation.secrets)) {
        const wasSet = hasOwn(sealed, key);
        if (next === null) {
            delete sealed[key];
            if (wasSet) changes.push({ secret: true, key, from: "set", to: "unset" });
        } else {
            sealed[key] = sealSecret(key, next);
            changes.push({ secret: true, key, from: wasSet ? "set" : "unset", to: "set" });
        }
    }

    if (changes.length === 0) return { status: "applied", projection: await projectRecordInTx(tx, current, registry) };

    // The retention reader is strict (a deleting mode needs its days): refuse a write that would
    // leave the Home's retention policy unreadable, rather than break every sweep and `/v1/features`.
    if (changes.some((change) => registry[change.key]?.family?.startsWith("retention") === true)) {
        const problem = findRetentionPolicyEnvProblem(buildHomeConfigEnv(process.env, values, registry));
        if (problem) return { status: "invalid", key: problem.key, reason: problem.reason === "required" ? "required" : "invalid_type" };
    }

    const data = { values: values as object, encryptedSecrets: encodeSealedSecrets(sealed) };
    if (current.revision === 0) {
        try {
            await tx.homeSettings.create({ data: { id: HOME_SETTINGS_ID, revision: 1, ...data }, select: { id: true } });
        } catch (error) {
            if (isPrismaErrorCode(error, "P2002")) throw new HomeSettingsCreateConflictError();
            throw error;
        }
    } else {
        const updated = await tx.homeSettings.updateMany({
            where: { id: HOME_SETTINGS_ID, revision: current.revision },
            data: { revision: current.revision + 1, ...data },
        });
        if (updated.count === 0) return { status: "revision_conflict" };
    }

    const actor: HomeAdministrationActor = { kind: "account", accountId: input.actorAccountId };
    for (const change of changes) {
        await recordHomeAdministrationEventInTx(tx, {
            actor,
            target: { kind: "setting", id: change.key },
            detail: { action: discard ? "home.settings.discard" : "home.settings.set", summary: change },
        });
    }
    return { status: "applied", projection: await projectRecordInTx(tx, await readHomeSettingsInTx(tx), registry) };
}

/**
 * The transport entry: one serializable transaction that writes, audits and wakes every Home
 * administrator. A concurrent first write that loses the create race is settled by rereading the
 * winning revision in a fresh transaction, which reports the normal CAS conflict.
 */
export async function setHomeSettings(
    input: Readonly<{ actorAccountId: string; write: HomeSettingsSetInputV1; registry?: ServerConfigRegistry }>,
): Promise<HomeSettingsSetResult> {
    const attempt = async () => await inTx(async (tx) => {
        const result = await setHomeSettingsInTx(tx, input);
        if (result.status === "applied") await publishHomeGovernanceChangedInTx(tx);
        return result;
    }, { isolationLevel: "Serializable" });
    try {
        return await attempt();
    } catch (error) {
        if (!(error instanceof HomeSettingsCreateConflictError)) throw error;
        return await attempt();
    }
}
