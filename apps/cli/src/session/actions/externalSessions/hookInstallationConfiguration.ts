import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
    chmod,
    lstat,
    mkdir,
    open,
    opendir,
    realpath,
    rm,
    rmdir,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
} from 'node:path';

import {
    PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES,
} from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
    type AgentExternalSessionHookInstallationVariant,
} from '@happier-dev/plugin-sdk/sessions/external';

import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import {
    resolveCanonicalAbsolutePathComparisonIdentity,
} from '@/utils/path/expandHomeDirPath';
import { writeBytesAtomic, writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

type JsonPrimitive = string | number | boolean | null;
export type ExternalSessionHookJsonValue =
    | JsonPrimitive
    | readonly ExternalSessionHookJsonValue[]
    | Readonly<{ [key: string]: ExternalSessionHookJsonValue }>;
type JsonObject = Readonly<{ [key: string]: ExternalSessionHookJsonValue }>;

export type ExternalSessionHookInstallationVariant = AgentExternalSessionHookInstallationVariant;

type QualifiedAgent = Readonly<{ pluginId: string; localId: string }>;

type InstallationRecordOwnedEntry = Readonly<{
    targetId: string;
    collectionId: string;
    eventId: string;
    nativeEventName: string;
    entryIdentity: string;
    entry: JsonObject;
    occurrenceCount: number;
    entryIndex: number;
    identicalEntriesBefore: number;
}>;

type InstallationRecordTarget = Readonly<{
    targetId: string;
    absolutePath: string;
    collectionId: string;
    inputIdentity: string;
}>;

export type ExternalSessionHookInstallationRecord = Readonly<{
    schemaVersion: 1;
    machineId: string;
    qualifiedAgent: QualifiedAgent;
    hostInstallationId: string;
    installationIdentity: string;
    executableIdentity: string;
    variantId: string;
    targets: readonly InstallationRecordTarget[];
    ownedEntries: readonly InstallationRecordOwnedEntry[];
    state: 'preparing' | 'active' | 'disabled' | 'revoked';
    ingressPrincipalRef: string;
    updatedAtMs: number;
    revision: number;
}>;

export type ExternalSessionHookInstallationInventoryRecord = Readonly<{
    machineId: string;
    qualifiedAgent: QualifiedAgent;
    installationId: string;
    variantId: string;
    state: ExternalSessionHookInstallationRecord['state'];
    updatedAtMs: number;
    revision: number;
}>;

export type ExternalSessionHookInstallationInventoryDiagnostic = Readonly<{
    code: 'invalid_record' | 'record_read_failed';
    recordRef: string;
}>;

export type ExternalSessionHookInstallationInventoryPageResult =
    | Readonly<{
        ok: true;
        records: readonly ExternalSessionHookInstallationInventoryRecord[];
        diagnostics: readonly ExternalSessionHookInstallationInventoryDiagnostic[];
        nextCursor?: string;
    }>
    | Readonly<{
        ok: false;
        code: 'invalid_cursor' | 'invalid_limit' | 'inventory_read_failed';
    }>;

export type ExternalSessionHookInstallationActionErrorCode =
    | 'invalid_target_path'
    | 'invalid_config'
    | 'concurrent_edit'
    | 'generation_mismatch'
    | 'installation_not_found'
    | 'installation_record_mismatch'
    | 'write_failed'
    | 'post_write_verification_failed'
    | 'reconciliation_required';

export type ExternalSessionHookInstallationActionResult =
    | Readonly<{
        ok: true;
        state: 'installed_enabled' | 'installed_disabled' | 'not_installed';
        changedConfiguration: boolean;
        revision: number;
    }>
    | Readonly<{
        ok: false;
        code: ExternalSessionHookInstallationActionErrorCode;
    }>;

type ConfigurationPersistence = Readonly<{
    readConfiguration?: (path: string) => Promise<Buffer>;
    readConfigurationForVerification?: (path: string) => Promise<Buffer>;
    writeConfigurationAtomic?: (path: string, value: unknown) => Promise<void>;
    writeConfigurationBytesAtomic?: (path: string, value: Uint8Array) => Promise<void>;
    writeInstallationRecordAtomic?: (path: string, value: unknown) => Promise<void>;
}>;

export type ApplyExternalSessionHookInstallationActionInput = Readonly<{
    action: 'install' | 'disable' | 'enable' | 'revoke' | 'uninstall';
    activeServerDir: string;
    machineId: string;
    qualifiedAgent: QualifiedAgent;
    hostInstallationId: string;
    installationIdentity: string;
    executableIdentity: string;
    ingressPrincipalRef: string;
    selectedVariant?: ExternalSessionHookInstallationVariant;
    targets?: readonly Readonly<{ targetId: string; absolutePath: string }>[];
    expectedInputIdentities?: readonly Readonly<{
        targetId: string;
        inputIdentity: string;
    }>[];
    generation?: Readonly<{ expected: string; current: string }>;
    materializeOwnedEntry?: (input: Readonly<{
        event: ExternalSessionHookInstallationVariant['events'][number];
        installationIdentity: string;
    }>) => JsonObject;
    persistence?: ConfigurationPersistence;
    now?: () => number;
    isCurrent?: () => boolean | Promise<boolean>;
    testHooks?: Readonly<{
        beforeCompareAndSwap?: (targetId: string) => Promise<void>;
    }>;
}>;

type ParsedConfiguration = Readonly<{
    document: Record<string, ExternalSessionHookJsonValue>;
    hooks: Record<string, ExternalSessionHookJsonValue[]>;
    inputIdentity: string;
    originalBytes: Buffer;
}>;

type TargetReadResult =
    | Readonly<{ kind: 'found'; parsed: ParsedConfiguration }>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'invalid' }>;

type ResolvedTarget = Readonly<{
    targetId: string;
    /** The physical file this target resolves to; the custody identity. */
    absolutePath: string;
    collectionId: string;
    /**
     * The path the caller declared, present only when this target came from a
     * caller declaration rather than from durable custody. It is re-resolved
     * immediately before the compare-and-swap so a target alias retargeted
     * mid-operation cannot be written past.
     */
    declaredPath?: string;
}>;

type TargetMutation = Readonly<{
    target: ResolvedTarget;
    originalBytes: Buffer | null;
    originalIdentity: string | null;
    candidateDocument: Record<string, ExternalSessionHookJsonValue>;
    candidateBytes: Buffer;
    candidateIdentity: string;
    ownedEntries: readonly InstallationRecordOwnedEntry[];
}>;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_TARGET_PATH_UTF8_BYTES = 4_096;
const MAX_INSTALLATION_INVENTORY_PAGE_SIZE = 50;
const MAX_INSTALLATION_INVENTORY_CURSOR_LENGTH = 4_096;
const MAX_INSTALLATION_INVENTORY_DIRECTORY_ENTRIES = 10_000;
const MAX_INSTALLATION_RECORD_BYTES =
    PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES;
const MAX_AGENT_HOOK_CONFIGURATION_BYTES =
    PLUGIN_SESSION_HOOK_STATUS_INVENTORY_MAX_SERIALIZED_BYTES;

function sha256Hex(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function stableDigest(prefix: string, value: string | Buffer): string {
    return `${prefix}:${sha256Hex(value)}`;
}

function entryIdentity(value: ExternalSessionHookJsonValue): string {
    return stableDigest('entry-v1', createCanonicalJsonSigningInput(value));
}

function configurationIdentity(bytes: Buffer): string {
    return stableDigest('input-v1', bytes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isJsonValueWithinLimits(
    value: unknown,
    limits: Readonly<{ maxDepth: number; maxNodes: number }>,
): value is ExternalSessionHookJsonValue {
    const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{
        value,
        depth: 0,
    }];
    let nodes = 0;
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (current.depth > limits.maxDepth) return false;
        nodes += 1;
        if (nodes > limits.maxNodes) return false;
        if (
            current.value === null
            || typeof current.value === 'string'
            || typeof current.value === 'boolean'
        ) {
            continue;
        }
        if (typeof current.value === 'number') {
            if (!Number.isFinite(current.value)) return false;
            continue;
        }
        const children = Array.isArray(current.value)
            ? current.value
            : isPlainObject(current.value)
                ? Object.values(current.value)
                : null;
        if (!children) return false;
        for (const child of children) {
            pending.push({ value: child, depth: current.depth + 1 });
        }
    }
    return true;
}

function isJsonValue(value: unknown): value is ExternalSessionHookJsonValue {
    return isJsonValueWithinLimits(value, {
        maxDepth: 64,
        maxNodes: 65_536,
    });
}

function isJsonObject(value: unknown): value is JsonObject {
    return isPlainObject(value) && isJsonValue(value);
}

function parseConfiguration(rawBytes: Buffer): ParsedConfiguration | null {
    if (!isUtf8(rawBytes)) return null;
    let value: unknown;
    try {
        value = JSON.parse(rawBytes.toString('utf8')) as unknown;
    } catch {
        return null;
    }
    if (!isPlainObject(value) || !isJsonValue(value)) return null;
    const rawHooks = value.hooks;
    if (rawHooks !== undefined && !isPlainObject(rawHooks)) return null;
    const hooks: Record<string, ExternalSessionHookJsonValue[]> = {};
    for (const [eventName, entries] of Object.entries(rawHooks ?? {})) {
        if (!Array.isArray(entries) || !entries.every(isJsonValue)) return null;
        hooks[eventName] = [...entries];
    }
    return {
        document: { ...value, hooks } as Record<string, ExternalSessionHookJsonValue>,
        hooks,
        inputIdentity: configurationIdentity(rawBytes),
        originalBytes: Buffer.from(rawBytes),
    };
}

function normalizedSegment(value: string, fallback: string): string {
    const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
    const label = normalized || fallback;
    return `${label}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function resolveExternalSessionHookInstallationRecordsRoot(activeServerDir: string): string {
    return join(
        activeServerDir,
        'external-sessions',
        'hook-installations',
        'v1',
    );
}

function resolveExternalSessionHookInstallationAgentDirectory(input: Readonly<{
    activeServerDir: string;
    qualifiedAgent: QualifiedAgent;
}>): string {
    const qualifiedAgentKey = normalizedSegment(
        `${input.qualifiedAgent.pluginId}--${input.qualifiedAgent.localId}`,
        'agent',
    );
    return join(
        resolveExternalSessionHookInstallationRecordsRoot(input.activeServerDir),
        qualifiedAgentKey,
    );
}

export function resolveExternalSessionHookInstallationRecordPath(input: Readonly<{
    activeServerDir: string;
    qualifiedAgent: QualifiedAgent;
    hostInstallationId: string;
}>): string {
    const installationKey = normalizedSegment(input.hostInstallationId, 'installation');
    return join(
        resolveExternalSessionHookInstallationAgentDirectory(input),
        `${installationKey}.json`,
    );
}

function resolveConfigurationLockPath(activeServerDir: string): string {
    return join(
        activeServerDir,
        'external-sessions',
        'hook-installations',
        'v1',
        'configuration.lock',
    );
}

async function removeEmptyInstallationRecordAgentDirectory(recordPath: string): Promise<void> {
    await rmdir(dirname(recordPath)).catch(() => {});
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length
        && keys.every((key, index) => key === [...expected].sort()[index]);
}

function isBoundedRecordString(value: unknown, maxCodeUnits: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxCodeUnits
        && !value.includes('\0');
}

function isBoundedRecordJsonObject(value: unknown): value is JsonObject {
    if (
        !isPlainObject(value)
        || !isJsonValueWithinLimits(value, {
            maxDepth: AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonDepth,
            maxNodes: AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonNodes,
        })
    ) {
        return false;
    }
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limits.maxJsonUtf8Bytes;
}

function isOwnedEntry(value: unknown): value is InstallationRecordOwnedEntry {
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    return isPlainObject(value)
        && hasExactKeys(value, [
            'targetId',
            'collectionId',
            'eventId',
            'nativeEventName',
            'entryIdentity',
            'entry',
            'occurrenceCount',
            'entryIndex',
            'identicalEntriesBefore',
        ])
        && isBoundedRecordString(value.targetId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.collectionId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.eventId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.nativeEventName, limits.maxNativeNameCodeUnits)
        && isBoundedRecordString(value.entryIdentity, limits.maxIdCodeUnits)
        && isBoundedRecordJsonObject(value.entry)
        && Number.isSafeInteger(value.occurrenceCount)
        && Number(value.occurrenceCount) > 0
        && Number(value.occurrenceCount) <= limits.maxEventsPerVariant
        && Number.isSafeInteger(value.entryIndex)
        && Number(value.entryIndex) >= 0
        && Number.isSafeInteger(value.identicalEntriesBefore)
        && Number(value.identicalEntriesBefore) >= 0
        && Number(value.identicalEntriesBefore) <= Number(value.entryIndex);
}

function isRecordTarget(value: unknown): value is InstallationRecordTarget {
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    return isPlainObject(value)
        && hasExactKeys(value, [
            'targetId',
            'absolutePath',
            'collectionId',
            'inputIdentity',
        ])
        && isBoundedRecordString(value.targetId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.absolutePath, MAX_TARGET_PATH_UTF8_BYTES)
        && Buffer.byteLength(value.absolutePath, 'utf8') <= MAX_TARGET_PATH_UTF8_BYTES
        && isAbsolute(value.absolutePath)
        && isBoundedRecordString(value.collectionId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.inputIdentity, limits.maxIdCodeUnits);
}

function isInstallationRecord(value: unknown): value is ExternalSessionHookInstallationRecord {
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    if (
        !isPlainObject(value)
        || !hasExactKeys(value, [
            'schemaVersion',
            'machineId',
            'qualifiedAgent',
            'hostInstallationId',
            'installationIdentity',
            'executableIdentity',
            'variantId',
            'targets',
            'ownedEntries',
            'state',
            'ingressPrincipalRef',
            'updatedAtMs',
            'revision',
        ])
        || !isPlainObject(value.qualifiedAgent)
        || !hasExactKeys(value.qualifiedAgent, ['pluginId', 'localId'])
    ) {
        return false;
    }
    if (!(value.schemaVersion === 1
        && isBoundedRecordString(value.machineId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.qualifiedAgent.pluginId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.qualifiedAgent.localId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.hostInstallationId, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.installationIdentity, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.executableIdentity, limits.maxIdCodeUnits)
        && isBoundedRecordString(value.variantId, limits.maxIdCodeUnits)
        && Array.isArray(value.targets)
        && value.targets.length > 0
        && value.targets.length <= limits.maxTargetsPerVariant
        && value.targets.every(isRecordTarget)
        && Array.isArray(value.ownedEntries)
        && value.ownedEntries.length <= limits.maxEventsPerVariant
        && value.ownedEntries.every(isOwnedEntry)
        && (
            value.state === 'preparing'
            || value.state === 'active'
            || value.state === 'disabled'
            || value.state === 'revoked'
        )
        && isBoundedRecordString(value.ingressPrincipalRef, limits.maxIdCodeUnits)
        && Number.isSafeInteger(value.updatedAtMs)
        && Number(value.updatedAtMs) >= 0
        && Number.isSafeInteger(value.revision)
        && Number(value.revision) > 0)) {
        return false;
    }
    const targets = value.targets as InstallationRecordTarget[];
    const targetIds = new Set(targets.map((target) => target.targetId));
    const targetPaths = new Set(targets.map((target) => target.absolutePath));
    if (targetIds.size !== targets.length || targetPaths.size !== targets.length) return false;
    const ownedEntries = value.ownedEntries as InstallationRecordOwnedEntry[];
    if (ownedEntries.some((owned) => !targetIds.has(owned.targetId))) return false;
    const ownedKeys = new Set(ownedEntries.map((owned) => [
        owned.targetId,
        owned.nativeEventName,
        owned.entryIdentity,
    ].join('\u0000')));
    return ownedKeys.size === ownedEntries.length;
}

type InstallationRecordReadResult =
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'read_failed' }>
    | Readonly<{ kind: 'found'; record: ExternalSessionHookInstallationRecord }>;

type BoundedFileReadResult =
    | Readonly<{ kind: 'found'; bytes: Buffer }>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'too_large' }>
    | Readonly<{ kind: 'read_failed' }>;

async function readBoundedFile(path: string, maximumBytes: number): Promise<BoundedFileReadResult> {
    let handle;
    try {
        handle = await open(path, 'r');
    } catch (error) {
        return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
            ? { kind: 'missing' }
            : { kind: 'read_failed' };
    }
    let raw: Buffer;
    try {
        const information = await handle.stat();
        if (!information.isFile()) return { kind: 'read_failed' };
        if (information.size > maximumBytes) {
            return { kind: 'too_large' };
        }
        const buffer = Buffer.allocUnsafe(maximumBytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(
                buffer,
                length,
                buffer.length - length,
                null,
            );
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length > maximumBytes) return { kind: 'too_large' };
        raw = buffer.subarray(0, length);
    } catch {
        return { kind: 'read_failed' };
    } finally {
        await handle.close().catch(() => {});
    }
    return { kind: 'found', bytes: raw };
}

async function readInstallationRecordResult(path: string): Promise<InstallationRecordReadResult> {
    const result = await readBoundedFile(path, MAX_INSTALLATION_RECORD_BYTES);
    if (result.kind === 'missing' || result.kind === 'read_failed') return result;
    if (result.kind === 'too_large') return { kind: 'invalid' };
    if (!isUtf8(result.bytes)) return { kind: 'invalid' };
    try {
        const parsed = JSON.parse(result.bytes.toString('utf8')) as unknown;
        return isInstallationRecord(parsed)
            ? { kind: 'found', record: parsed }
            : { kind: 'invalid' };
    } catch {
        return { kind: 'invalid' };
    }
}

export async function readExternalSessionHookInstallationRecord(
    path: string,
): Promise<ExternalSessionHookInstallationRecord | null> {
    const result = await readInstallationRecordResult(path);
    return result.kind === 'found' ? result.record : null;
}

type InstallationInventoryCursorPayload = Readonly<{
    v: 1;
    s: string;
    a: string;
}>;

type InstallationInventoryDescriptor = Readonly<{
    recordRef: string;
    path?: string;
    diagnostic?: ExternalSessionHookInstallationInventoryDiagnostic['code'];
}>;

type InstallationInventoryTraversalBudget = {
    directoryEntriesRead: number;
};

type InstallationInventoryDirectoryReadResult =
    | Readonly<{ kind: 'found'; entries: readonly Dirent[] }>
    | Readonly<{ kind: 'missing' | 'read_failed' | 'too_large' }>;

function installationInventoryScopeDigest(input: Readonly<{
    activeServerDir: string;
    qualifiedAgent?: QualifiedAgent;
}>): string {
    const filter = input.qualifiedAgent
        ? `${input.qualifiedAgent.pluginId}\u0000${input.qualifiedAgent.localId}`
        : '*';
    return sha256Hex(
        `external-session-hook-installation-inventory-scope-v1\u0000`
        + `${input.activeServerDir}\u0000${filter}`,
    );
}

function encodeInstallationInventoryCursor(
    payload: InstallationInventoryCursorPayload,
): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeInstallationInventoryCursor(
    cursor: string,
    expectedScopeDigest: string,
): InstallationInventoryCursorPayload | null {
    if (
        cursor.length === 0
        || cursor.length > MAX_INSTALLATION_INVENTORY_CURSOR_LENGTH
    ) {
        return null;
    }
    try {
        const decoded = Buffer.from(cursor, 'base64url');
        if (decoded.toString('base64url') !== cursor) return null;
        const value = JSON.parse(decoded.toString('utf8')) as unknown;
        if (
            !isPlainObject(value)
            || !hasExactKeys(value, ['v', 's', 'a'])
            || value.v !== 1
            || value.s !== expectedScopeDigest
            || typeof value.a !== 'string'
            || !/^[a-f0-9]{64}$/u.test(value.a)
        ) {
            return null;
        }
        return {
            v: 1,
            s: expectedScopeDigest,
            a: value.a,
        };
    } catch {
        return null;
    }
}

function installationInventoryDescriptorRef(
    kind: 'agent-directory' | 'record',
    agentDirectoryName: string,
    recordFileName = '',
): string {
    return sha256Hex(
        `external-session-hook-installation-${kind}-v1\u0000`
        + `${agentDirectoryName}\u0000${recordFileName}`,
    );
}

async function readInstallationInventoryDirectory(
    path: string,
    budget: InstallationInventoryTraversalBudget,
): Promise<InstallationInventoryDirectoryReadResult> {
    let directory;
    try {
        directory = await opendir(path);
    } catch (error) {
        return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
            ? { kind: 'missing' }
            : { kind: 'read_failed' };
    }
    const entries: Dirent[] = [];
    try {
        while (true) {
            const entry = await directory.read();
            if (!entry) break;
            budget.directoryEntriesRead += 1;
            if (
                budget.directoryEntriesRead
                > MAX_INSTALLATION_INVENTORY_DIRECTORY_ENTRIES
            ) {
                return { kind: 'too_large' };
            }
            entries.push(entry);
        }
        return { kind: 'found', entries };
    } catch {
        return { kind: 'read_failed' };
    } finally {
        await directory.close().catch(() => {});
    }
}

async function readInstallationInventoryAgentDirectory(
    rootPath: string,
    agentDirectoryName: string,
    budget: InstallationInventoryTraversalBudget,
): Promise<
    | Readonly<{
        ok: true;
        descriptors: readonly InstallationInventoryDescriptor[];
    }>
    | Readonly<{ ok: false }>
> {
    const result = await readInstallationInventoryDirectory(
        join(rootPath, agentDirectoryName),
        budget,
    );
    if (result.kind === 'too_large') return { ok: false };
    if (result.kind !== 'found') {
        return {
            ok: true,
            descriptors: [{
                recordRef: installationInventoryDescriptorRef(
                    'agent-directory',
                    agentDirectoryName,
                ),
                diagnostic: 'record_read_failed',
            }],
        };
    }
    return {
        ok: true,
        descriptors: result.entries
            .filter((entry) =>
                entry.name.endsWith('.json')
                && !entry.name.startsWith('.tmp-'))
            .map((entry): InstallationInventoryDescriptor => {
                const recordRef = installationInventoryDescriptorRef(
                    'record',
                    agentDirectoryName,
                    entry.name,
                );
                return entry.isFile()
                    ? {
                        recordRef,
                        path: join(rootPath, agentDirectoryName, entry.name),
                    }
                    : {
                        recordRef,
                        diagnostic: 'invalid_record',
                    };
            }),
    };
}

async function readInstallationInventoryDescriptors(input: Readonly<{
    activeServerDir: string;
    qualifiedAgent?: QualifiedAgent;
}>): Promise<
    | Readonly<{ ok: true; descriptors: readonly InstallationInventoryDescriptor[] }>
    | Readonly<{ ok: false }>
> {
    const rootPath = resolveExternalSessionHookInstallationRecordsRoot(input.activeServerDir);
    const traversalBudget: InstallationInventoryTraversalBudget = {
        directoryEntriesRead: 0,
    };
    let agentDirectoryNames: readonly string[];
    if (input.qualifiedAgent) {
        const directoryPath = resolveExternalSessionHookInstallationAgentDirectory({
            activeServerDir: input.activeServerDir,
            qualifiedAgent: input.qualifiedAgent,
        });
        const directoryName = basename(directoryPath);
        try {
            const directory = await lstat(directoryPath);
            if (!directory.isDirectory()) {
                return {
                    ok: true,
                    descriptors: [{
                        recordRef: installationInventoryDescriptorRef(
                            'agent-directory',
                            directoryName,
                        ),
                        diagnostic: 'record_read_failed',
                    }],
                };
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
                return { ok: true, descriptors: [] };
            }
            return {
                ok: true,
                descriptors: [{
                    recordRef: installationInventoryDescriptorRef(
                        'agent-directory',
                        directoryName,
                    ),
                    diagnostic: 'record_read_failed',
                }],
            };
        }
        agentDirectoryNames = [directoryName];
    } else {
        const result = await readInstallationInventoryDirectory(
            rootPath,
            traversalBudget,
        );
        if (result.kind === 'missing') {
            return { ok: true, descriptors: [] };
        }
        if (result.kind !== 'found') {
            return { ok: false };
        }
        const configurationLockName = basename(
            resolveConfigurationLockPath(input.activeServerDir),
        );
        agentDirectoryNames = result.entries
            .filter((entry) =>
                entry.isDirectory()
                && entry.name !== configurationLockName
                && !entry.name.startsWith(`${configurationLockName}.`))
            .map((entry) => entry.name);
    }

    // Custody v1 admits at most one bounded descriptor inventory before sorting.
    // Record bytes remain deferred until after page slicing below.
    const descriptors: InstallationInventoryDescriptor[] = [];
    for (const agentDirectoryName of [...agentDirectoryNames].sort()) {
        const result = await readInstallationInventoryAgentDirectory(
            rootPath,
            agentDirectoryName,
            traversalBudget,
        );
        if (!result.ok) return { ok: false };
        descriptors.push(...result.descriptors);
    }
    descriptors.sort((left, right) =>
        left.recordRef < right.recordRef ? -1 : left.recordRef > right.recordRef ? 1 : 0);
    return { ok: true, descriptors };
}

export async function readExternalSessionHookInstallationInventoryPage(input: Readonly<{
    activeServerDir: string;
    qualifiedAgent?: QualifiedAgent;
    cursor?: string;
    limit?: number;
}>): Promise<ExternalSessionHookInstallationInventoryPageResult> {
    const limit = input.limit ?? MAX_INSTALLATION_INVENTORY_PAGE_SIZE;
    if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAX_INSTALLATION_INVENTORY_PAGE_SIZE
    ) {
        return { ok: false, code: 'invalid_limit' };
    }
    const scopeDigest = installationInventoryScopeDigest(input);
    const cursor = input.cursor === undefined
        ? null
        : decodeInstallationInventoryCursor(input.cursor, scopeDigest);
    if (input.cursor !== undefined && !cursor) {
        return { ok: false, code: 'invalid_cursor' };
    }
    const descriptorResult = await readInstallationInventoryDescriptors(input);
    if (!descriptorResult.ok) {
        return { ok: false, code: 'inventory_read_failed' };
    }
    const afterRef = cursor?.a;
    const candidates = descriptorResult.descriptors
        .filter((descriptor) => afterRef === undefined || descriptor.recordRef > afterRef)
        .slice(0, limit + 1);
    const page = candidates.slice(0, limit);
    const records: ExternalSessionHookInstallationInventoryRecord[] = [];
    const diagnostics: ExternalSessionHookInstallationInventoryDiagnostic[] = [];
    for (const descriptor of page) {
        if (descriptor.diagnostic) {
            diagnostics.push({
                code: descriptor.diagnostic,
                recordRef: descriptor.recordRef,
            });
            continue;
        }
        const result = await readInstallationRecordResult(descriptor.path!);
        if (result.kind !== 'found') {
            diagnostics.push({
                code: result.kind === 'invalid' ? 'invalid_record' : 'record_read_failed',
                recordRef: descriptor.recordRef,
            });
            continue;
        }
        const record = result.record;
        const expectedPath = resolveExternalSessionHookInstallationRecordPath({
            activeServerDir: input.activeServerDir,
            qualifiedAgent: record.qualifiedAgent,
            hostInstallationId: record.hostInstallationId,
        });
        if (
            expectedPath !== descriptor.path
            || (
                input.qualifiedAgent
                && (
                    record.qualifiedAgent.pluginId !== input.qualifiedAgent.pluginId
                    || record.qualifiedAgent.localId !== input.qualifiedAgent.localId
                )
            )
        ) {
            diagnostics.push({
                code: 'invalid_record',
                recordRef: descriptor.recordRef,
            });
            continue;
        }
        records.push({
            machineId: record.machineId,
            qualifiedAgent: record.qualifiedAgent,
            installationId: record.hostInstallationId,
            variantId: record.variantId,
            state: record.state,
            updatedAtMs: record.updatedAtMs,
            revision: record.revision,
        });
    }
    return {
        ok: true,
        records,
        diagnostics,
        ...(candidates.length > limit && page.length > 0
            ? {
                nextCursor: encodeInstallationInventoryCursor({
                    v: 1,
                    s: scopeDigest,
                    a: page[page.length - 1]!.recordRef,
                }),
            }
            : {}),
    };
}

async function writeInstallationRecord(
    path: string,
    record: ExternalSessionHookInstallationRecord,
    persistence: ConfigurationPersistence,
): Promise<void> {
    if (
        !isInstallationRecord(record)
        || Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8')
            > MAX_INSTALLATION_RECORD_BYTES
    ) {
        throw new Error('invalid external-session hook installation record');
    }
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform !== 'win32') await chmod(parent, PRIVATE_DIRECTORY_MODE);
    await (persistence.writeInstallationRecordAtomic ?? writeJsonAtomic)(path, record);
    if (process.platform !== 'win32') await chmod(path, PRIVATE_FILE_MODE);
}

function recordMatchesInput(
    record: ExternalSessionHookInstallationRecord,
    input: ApplyExternalSessionHookInstallationActionInput,
): boolean {
    return record.machineId === input.machineId
        && record.qualifiedAgent.pluginId === input.qualifiedAgent.pluginId
        && record.qualifiedAgent.localId === input.qualifiedAgent.localId
        && record.hostInstallationId === input.hostInstallationId
        && record.installationIdentity === input.installationIdentity;
}

/**
 * The one physical identity for an Agent hook configuration target.
 *
 * Agents declare configuration paths through aliases — macOS resolves `/var`
 * to `/private/var`, and users point `~/.claude` at a managed directory — so
 * the declared path is an input, not an identity. Custody, comparison and the
 * compare-and-swap fence all use the physical file this resolves to, and the
 * declared path is only ever re-resolved to prove it still names that file.
 */
export async function resolveExternalSessionHookPhysicalTargetPath(
    absolutePath: string,
): Promise<string | null> {
    const unresolvedSegments: string[] = [];
    let existingPath = absolutePath;
    while (true) {
        try {
            const physicalPath = await realpath(existingPath);
            return join(physicalPath, ...unresolvedSegments.reverse());
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return null;
            // `realpath` reports both an ordinary absent path and a dangling
            // final symlink/reparse alias as ENOENT. Only the former is a
            // creation target: replacing the latter atomically would destroy
            // the caller's declared indirection instead of writing its target.
            try {
                if ((await lstat(existingPath)).isSymbolicLink()) return null;
            } catch (lstatError) {
                if ((lstatError as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
                    return null;
                }
            }
            const parent = dirname(existingPath);
            if (parent === existingPath) return null;
            unresolvedSegments.push(basename(existingPath));
            existingPath = parent;
        }
    }
}

async function resolveInstallTargets(
    variant: ExternalSessionHookInstallationVariant,
    targets: ApplyExternalSessionHookInstallationActionInput['targets'],
): Promise<readonly ResolvedTarget[] | null> {
    if (!targets || targets.length !== variant.targets.length) return null;
    const targetById = new Map(targets.map((target) => [target.targetId, target]));
    if (targetById.size !== targets.length) return null;
    const seenPathIdentities = new Set<string>();
    const resolved: ResolvedTarget[] = [];
    for (const declared of variant.targets) {
        if (declared.format !== 'hook_event_json_arrays_v1') return null;
        const target = targetById.get(declared.targetId);
        if (
            !target
            || !target.absolutePath
            || target.absolutePath.includes('\0')
            || Buffer.byteLength(target.absolutePath, 'utf8') > MAX_TARGET_PATH_UTF8_BYTES
            || !isAbsolute(target.absolutePath)
        ) {
            return null;
        }
        const physicalPath =
            await resolveExternalSessionHookPhysicalTargetPath(target.absolutePath);
        if (physicalPath === null) return null;
        const physicalPathIdentity = resolveCanonicalAbsolutePathComparisonIdentity(
            physicalPath,
            { platform: process.platform },
        );
        if (!physicalPathIdentity || seenPathIdentities.has(physicalPathIdentity)) {
            return null;
        }
        seenPathIdentities.add(physicalPathIdentity);
        resolved.push({
            targetId: declared.targetId,
            absolutePath: physicalPath,
            collectionId: declared.collectionId,
            declaredPath: target.absolutePath,
        });
    }
    return resolved;
}

function targetsFromRecord(record: ExternalSessionHookInstallationRecord): readonly ResolvedTarget[] {
    return record.targets.map((target) => ({
        targetId: target.targetId,
        absolutePath: target.absolutePath,
        collectionId: target.collectionId,
    }));
}

function installTargetsMatchRecord(
    record: ExternalSessionHookInstallationRecord,
    targets: readonly ResolvedTarget[],
): boolean {
    if (record.targets.length !== targets.length) return false;
    const priorById = new Map(record.targets.map((target) => [target.targetId, target]));
    return priorById.size === record.targets.length
        && targets.every((target) => {
            const prior = priorById.get(target.targetId);
            if (prior === undefined) return false;
            const priorPathIdentity = resolveCanonicalAbsolutePathComparisonIdentity(
                prior.absolutePath,
                { platform: process.platform },
            );
            const targetPathIdentity = resolveCanonicalAbsolutePathComparisonIdentity(
                target.absolutePath,
                { platform: process.platform },
            );
            return priorPathIdentity !== null
                && priorPathIdentity === targetPathIdentity
                && prior.collectionId === target.collectionId;
        });
}

async function readTarget(
    target: ResolvedTarget,
    persistence: ConfigurationPersistence,
): Promise<TargetReadResult> {
    let result: BoundedFileReadResult;
    if (persistence.readConfiguration) {
        try {
            const bytes = await persistence.readConfiguration(target.absolutePath);
            result = bytes.byteLength <= MAX_AGENT_HOOK_CONFIGURATION_BYTES
                ? { kind: 'found', bytes }
                : { kind: 'too_large' };
        } catch (error) {
            result = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
                ? { kind: 'missing' }
                : { kind: 'read_failed' };
        }
    } else {
        result = await readBoundedFile(
            target.absolutePath,
            MAX_AGENT_HOOK_CONFIGURATION_BYTES,
        );
    }
    if (result.kind === 'missing') return result;
    if (result.kind !== 'found') return { kind: 'invalid' };
    try {
        const parsed = parseConfiguration(result.bytes);
        return parsed ? { kind: 'found', parsed } : { kind: 'invalid' };
    } catch {
        return { kind: 'invalid' };
    }
}

function targetReadInputIdentity(
    target: ResolvedTarget,
    read: Exclude<TargetReadResult, Readonly<{ kind: 'invalid' }>>,
): string {
    return read.kind === 'found'
        ? read.parsed.inputIdentity
        : stableDigest('input-missing-v1', target.absolutePath);
}

export type ExternalSessionHookInstallationConfigSnapshot = Readonly<{
    targets: readonly Readonly<{
        targetId: string;
        absolutePath: string;
        collectionId: string;
        inputIdentity: string;
    }>[];
}>;

export async function readExternalSessionHookInstallationConfigSnapshot(
    input: Readonly<{
        selectedVariant: ExternalSessionHookInstallationVariant;
        targets: readonly Readonly<{
            targetId: string;
            absolutePath: string;
        }>[];
        persistence?: Readonly<{
            readConfiguration?: (path: string) => Promise<Buffer>;
        }>;
    }>,
): Promise<
    | Readonly<{
        ok: true;
        snapshot: ExternalSessionHookInstallationConfigSnapshot;
    }>
    | Readonly<{
        ok: false;
        code: 'invalid_target_path' | 'invalid_config';
    }>
> {
    const targets = await resolveInstallTargets(
        input.selectedVariant,
        input.targets,
    );
    if (!targets) return { ok: false, code: 'invalid_target_path' };
    const snapshotTargets: ExternalSessionHookInstallationConfigSnapshot[
        'targets'
    ][number][] = [];
    for (const target of targets) {
        const read = await readTarget(target, input.persistence ?? {});
        if (read.kind === 'invalid') {
            return { ok: false, code: 'invalid_config' };
        }
        snapshotTargets.push({
            targetId: target.targetId,
            absolutePath: target.absolutePath,
            collectionId: target.collectionId,
            inputIdentity: targetReadInputIdentity(target, read),
        });
    }
    return {
        ok: true,
        snapshot: { targets: snapshotTargets },
    };
}

async function readTargetForVerification(
    path: string,
    persistence: ConfigurationPersistence,
): Promise<BoundedFileReadResult> {
    if (!persistence.readConfigurationForVerification) {
        return await readBoundedFile(path, MAX_AGENT_HOOK_CONFIGURATION_BYTES);
    }
    try {
        const bytes = await persistence.readConfigurationForVerification(path);
        return bytes.byteLength <= MAX_AGENT_HOOK_CONFIGURATION_BYTES
            ? { kind: 'found', bytes }
            : { kind: 'too_large' };
    } catch (error) {
        return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
            ? { kind: 'missing' }
            : { kind: 'read_failed' };
    }
}

function emptyConfigurationForMissingTarget(): ParsedConfiguration {
    const parsed = parseConfiguration(Buffer.from('{"hooks":{}}', 'utf8'));
    if (!parsed) throw new Error('canonical empty hook configuration is invalid');
    return parsed;
}

function removeRecordedOccurrences(input: Readonly<{
    entries: readonly ExternalSessionHookJsonValue[];
    owned: readonly InstallationRecordOwnedEntry[];
    requireEveryOccurrence: boolean;
}>): ExternalSessionHookJsonValue[] | null {
    const retained = [...input.entries];
    for (const owned of [...input.owned].sort(
        (left, right) => right.entryIndex - left.entryIndex,
    )) {
        const matchingIndices = retained.flatMap((entry, index) =>
            entryIdentity(entry) === owned.entryIdentity ? [index] : []);
        if (
            !input.requireEveryOccurrence
            && matchingIndices.length === owned.identicalEntriesBefore
        ) {
            continue;
        }
        if (
            matchingIndices.length
                < owned.identicalEntriesBefore + owned.occurrenceCount
        ) {
            return null;
        }
        const ownedIndices = Array.from(
            { length: owned.occurrenceCount },
            (_, offset) => owned.entryIndex + offset,
        );
        if (
            ownedIndices.some(
                (index) =>
                    index >= retained.length
                    || entryIdentity(retained[index]!) !== owned.entryIdentity,
            )
        ) {
            return null;
        }
        for (const index of [...ownedIndices].reverse()) {
            retained.splice(index, 1);
        }
    }
    return retained;
}

function priorOwnedForEvent(
    record: ExternalSessionHookInstallationRecord | null,
    targetId: string,
    nativeEventName: string,
): readonly InstallationRecordOwnedEntry[] {
    return record?.ownedEntries.filter((owned) =>
        owned.targetId === targetId && owned.nativeEventName === nativeEventName) ?? [];
}

function buildInstallMutation(input: Readonly<{
    target: ResolvedTarget;
    parsed: ParsedConfiguration;
    variant: ExternalSessionHookInstallationVariant;
    prior: ExternalSessionHookInstallationRecord | null;
    materializeOwnedEntry: NonNullable<
        ApplyExternalSessionHookInstallationActionInput['materializeOwnedEntry']
    >;
    installationIdentity: string;
}>): TargetMutation | null {
    const document = structuredClone(input.parsed.document);
    const hooks = document.hooks as Record<string, ExternalSessionHookJsonValue[]>;
    const nextOwned: InstallationRecordOwnedEntry[] = [];
    for (const event of input.variant.events.filter((candidate) =>
        candidate.targetId === input.target.targetId)) {
        const retained = removeRecordedOccurrences({
            entries: hooks[event.nativeEventName] ?? [],
            owned: priorOwnedForEvent(input.prior, input.target.targetId, event.nativeEventName),
            requireEveryOccurrence: input.prior?.state === 'active'
                || input.prior?.state === 'disabled',
        });
        if (!retained) return null;
        const entry = input.materializeOwnedEntry({
            event,
            installationIdentity: input.installationIdentity,
        });
        const identity = entryIdentity(entry);
        const entryIndex = retained.length;
        const identicalEntriesBefore = retained.filter(
            (candidate) => entryIdentity(candidate) === identity,
        ).length;
        retained.push(entry);
        hooks[event.nativeEventName] = retained;
        nextOwned.push({
            targetId: input.target.targetId,
            collectionId: input.target.collectionId,
            eventId: event.eventId,
            nativeEventName: event.nativeEventName,
            entryIdentity: identity,
            entry,
            occurrenceCount: 1,
            entryIndex,
            identicalEntriesBefore,
        });
    }
    document.hooks = hooks;
    const candidateBytes = Buffer.from(JSON.stringify(document, null, 2), 'utf8');
    return {
        target: input.target,
        originalBytes: input.parsed.originalBytes,
        originalIdentity: input.parsed.inputIdentity,
        candidateDocument: document,
        candidateBytes,
        candidateIdentity: configurationIdentity(candidateBytes),
        ownedEntries: nextOwned,
    };
}

function buildUninstallMutation(input: Readonly<{
    target: ResolvedTarget;
    parsed: ParsedConfiguration;
    record: ExternalSessionHookInstallationRecord;
}>): TargetMutation | null {
    const document = structuredClone(input.parsed.document);
    const hooks = document.hooks as Record<string, ExternalSessionHookJsonValue[]>;
    const ownedByEvent = new Map<string, InstallationRecordOwnedEntry[]>();
    for (const owned of input.record.ownedEntries.filter((entry) =>
        entry.targetId === input.target.targetId)) {
        const entries = ownedByEvent.get(owned.nativeEventName) ?? [];
        entries.push(owned);
        ownedByEvent.set(owned.nativeEventName, entries);
    }
    for (const [nativeEventName, owned] of ownedByEvent) {
        const retained = removeRecordedOccurrences({
            entries: hooks[nativeEventName] ?? [],
            owned,
            requireEveryOccurrence: input.record.state === 'active'
                || input.record.state === 'disabled',
        });
        if (!retained) return null;
        hooks[nativeEventName] = retained;
    }
    document.hooks = hooks;
    const candidateBytes = Buffer.from(JSON.stringify(document, null, 2), 'utf8');
    return {
        target: input.target,
        originalBytes: input.parsed.originalBytes,
        originalIdentity: input.parsed.inputIdentity,
        candidateDocument: document,
        candidateBytes,
        candidateIdentity: configurationIdentity(candidateBytes),
        ownedEntries: [],
    };
}

async function prepareMutations(input: Readonly<{
    action: 'install' | 'uninstall';
    targets: readonly ResolvedTarget[];
    variant?: ExternalSessionHookInstallationVariant;
    record: ExternalSessionHookInstallationRecord | null;
    actionInput: ApplyExternalSessionHookInstallationActionInput;
}>): Promise<
    | Readonly<{
        ok: true;
        mutations: readonly TargetMutation[];
        inputIdentities: readonly Readonly<{
            targetId: string;
            inputIdentity: string;
        }>[];
    }>
    | Readonly<{ ok: false; code: ExternalSessionHookInstallationActionErrorCode }>
> {
    const persistence = input.actionInput.persistence ?? {};
    const mutations: TargetMutation[] = [];
    const inputIdentities: Array<Readonly<{
        targetId: string;
        inputIdentity: string;
    }>> = [];
    for (const target of input.targets) {
        const targetRead = await readTarget(target, persistence);
        if (targetRead.kind === 'invalid') {
            return { ok: false, code: 'invalid_config' };
        }
        if (targetRead.kind === 'missing' && input.action === 'uninstall') {
            continue;
        }
        inputIdentities.push({
            targetId: target.targetId,
            inputIdentity: targetReadInputIdentity(target, targetRead),
        });
        const parsed = targetRead.kind === 'found'
            ? targetRead.parsed
            : emptyConfigurationForMissingTarget();
        const builtMutation = input.action === 'install'
            ? buildInstallMutation({
                target,
                parsed,
                variant: input.variant!,
                prior: input.record,
                materializeOwnedEntry: input.actionInput.materializeOwnedEntry!,
                installationIdentity: input.actionInput.installationIdentity,
            })
            : buildUninstallMutation({
                target,
                parsed,
                record: input.record!,
            });
        if (!builtMutation) return { ok: false, code: 'reconciliation_required' };
        mutations.push(targetRead.kind === 'missing'
            ? {
                ...builtMutation,
                originalBytes: null,
                originalIdentity: null,
            }
            : builtMutation);
    }
    return { ok: true, mutations, inputIdentities };
}

function mergePreparingOwnedEntries(
    prior: ExternalSessionHookInstallationRecord | null,
    next: readonly InstallationRecordOwnedEntry[],
): readonly InstallationRecordOwnedEntry[] {
    const byKey = new Map<string, InstallationRecordOwnedEntry>();
    for (const owned of [...(prior?.ownedEntries ?? []), ...next]) {
        const key = [
            owned.targetId,
            owned.nativeEventName,
            owned.entryIdentity,
        ].join('\u0000');
        const existing = byKey.get(key);
        byKey.set(key, existing
            ? { ...owned, occurrenceCount: Math.max(existing.occurrenceCount, owned.occurrenceCount) }
            : owned);
    }
    return [...byKey.values()];
}

function makeRecord(input: Readonly<{
    actionInput: ApplyExternalSessionHookInstallationActionInput;
    variantId: string;
    targets: readonly InstallationRecordTarget[];
    ownedEntries: readonly InstallationRecordOwnedEntry[];
    state: ExternalSessionHookInstallationRecord['state'];
    revision: number;
}>): ExternalSessionHookInstallationRecord {
    return {
        schemaVersion: 1,
        machineId: input.actionInput.machineId,
        qualifiedAgent: input.actionInput.qualifiedAgent,
        hostInstallationId: input.actionInput.hostInstallationId,
        installationIdentity: input.actionInput.installationIdentity,
        executableIdentity: input.actionInput.executableIdentity,
        variantId: input.variantId,
        targets: input.targets,
        ownedEntries: input.ownedEntries,
        state: input.state,
        ingressPrincipalRef: input.actionInput.ingressPrincipalRef,
        updatedAtMs: (input.actionInput.now ?? Date.now)(),
        revision: input.revision,
    };
}

async function rollbackWrittenTargets(input: Readonly<{
    written: readonly TargetMutation[];
    persistence: ConfigurationPersistence;
}>): Promise<'rolled_back' | 'newer_edit'> {
    const writeAtomic = input.persistence.writeConfigurationBytesAtomic ?? writeBytesAtomic;
    let newerEdit = false;
    for (const mutation of [...input.written].reverse()) {
        const current = await readTargetForVerification(
            mutation.target.absolutePath,
            input.persistence,
        );
        if (current.kind !== 'found') {
            newerEdit = true;
            continue;
        }
        if (configurationIdentity(current.bytes) !== mutation.candidateIdentity) {
            newerEdit = true;
            continue;
        }
        try {
            if (mutation.originalBytes === null) {
                await rm(mutation.target.absolutePath);
            } else {
                await writeAtomic(mutation.target.absolutePath, mutation.originalBytes);
            }
        } catch {
            newerEdit = true;
        }
    }
    return newerEdit ? 'newer_edit' : 'rolled_back';
}

async function isInstallationActionCurrent(
    input: ApplyExternalSessionHookInstallationActionInput,
): Promise<boolean> {
    try {
        return input.isCurrent === undefined || await input.isCurrent();
    } catch {
        return false;
    }
}

async function applyMutations(input: Readonly<{
    mutations: readonly TargetMutation[];
    actionInput: ApplyExternalSessionHookInstallationActionInput;
}>): Promise<
    | Readonly<{ ok: true; written: readonly TargetMutation[] }>
    | Readonly<{ ok: false; code: ExternalSessionHookInstallationActionErrorCode }>
> {
    const persistence = input.actionInput.persistence ?? {};
    const written: TargetMutation[] = [];
    for (const mutation of input.mutations) {
        await input.actionInput.testHooks?.beforeCompareAndSwap?.(mutation.target.targetId);
        if (mutation.target.declaredPath !== undefined) {
            // The declared path was resolved to this physical file when the
            // mutation was planned. Re-resolve it here so a target alias moved
            // since then fails instead of writing a file the Agent no longer
            // reads.
            const physicalPath =
                await resolveExternalSessionHookPhysicalTargetPath(
                    mutation.target.declaredPath,
                );
            const physicalPathIdentity = physicalPath === null
                ? null
                : resolveCanonicalAbsolutePathComparisonIdentity(physicalPath, {
                    platform: process.platform,
                });
            const targetPathIdentity = resolveCanonicalAbsolutePathComparisonIdentity(
                mutation.target.absolutePath,
                { platform: process.platform },
            );
            if (physicalPathIdentity === null || physicalPathIdentity !== targetPathIdentity) {
                const rollback = await rollbackWrittenTargets({ written, persistence });
                return {
                    ok: false,
                    code: rollback === 'newer_edit' ? 'reconciliation_required' : 'concurrent_edit',
                };
            }
        }
        const beforeWrite = await readTarget(mutation.target, persistence);
        const inputStillMatches = mutation.originalIdentity === null
            ? beforeWrite.kind === 'missing'
            : (
                beforeWrite.kind === 'found'
                && beforeWrite.parsed.inputIdentity === mutation.originalIdentity
            );
        if (!inputStillMatches) {
            const rollback = await rollbackWrittenTargets({ written, persistence });
            return {
                ok: false,
                code: rollback === 'newer_edit' ? 'reconciliation_required' : 'concurrent_edit',
            };
        }
        if (
            mutation.candidateBytes.byteLength > MAX_AGENT_HOOK_CONFIGURATION_BYTES
            || !parseConfiguration(mutation.candidateBytes)
        ) {
            const rollback = await rollbackWrittenTargets({ written, persistence });
            return {
                ok: false,
                code: rollback === 'newer_edit' ? 'reconciliation_required' : 'invalid_config',
            };
        }
        if (!await isInstallationActionCurrent(input.actionInput)) {
            await rollbackWrittenTargets({ written, persistence });
            return { ok: false, code: 'reconciliation_required' };
        }
        try {
            await (persistence.writeConfigurationAtomic ?? writeJsonAtomic)(
                mutation.target.absolutePath,
                mutation.candidateDocument,
            );
        } catch {
            const rollback = await rollbackWrittenTargets({ written, persistence });
            return {
                ok: false,
                code: rollback === 'newer_edit' ? 'reconciliation_required' : 'write_failed',
            };
        }
        written.push(mutation);
        const verified = await readTargetForVerification(
            mutation.target.absolutePath,
            persistence,
        );
        if (verified.kind !== 'found') {
            const rollback = await rollbackWrittenTargets({ written, persistence });
            return {
                ok: false,
                code: rollback === 'newer_edit'
                    ? 'reconciliation_required'
                    : 'post_write_verification_failed',
            };
        }
        if (configurationIdentity(verified.bytes) !== mutation.candidateIdentity) {
            await rollbackWrittenTargets({ written, persistence });
            return { ok: false, code: 'reconciliation_required' };
        }
    }
    return { ok: true, written };
}

export async function applyExternalSessionHookInstallationAction(
    input: ApplyExternalSessionHookInstallationActionInput,
): Promise<ExternalSessionHookInstallationActionResult> {
    const recordPath = resolveExternalSessionHookInstallationRecordPath(input);
    return await withJsonOwnerFileLock({
        lockPath: resolveConfigurationLockPath(input.activeServerDir),
        timeoutMs: 15_000,
        staleAfterMs: 30_000,
        errorCode: 'external_session_hook_installation_lock_timeout',
    }, async () => {
        const persistence = input.persistence ?? {};
        const recordRead = await readInstallationRecordResult(recordPath);
        if (recordRead.kind === 'invalid' || recordRead.kind === 'read_failed') {
            return { ok: false, code: 'reconciliation_required' };
        }
        const record = recordRead.kind === 'found' ? recordRead.record : null;
        if (record && !recordMatchesInput(record, input)) {
            return { ok: false, code: 'installation_record_mismatch' };
        }
        if (
            (input.action === 'install' || input.action === 'enable')
            && input.generation
            && input.generation.expected !== input.generation.current
        ) {
            return { ok: false, code: 'generation_mismatch' };
        }
        if (
            input.action === 'disable'
            || input.action === 'enable'
            || input.action === 'revoke'
        ) {
            if (!record) return { ok: false, code: 'installation_not_found' };
            if (record.state === 'preparing' || record.state === 'revoked') {
                // `revoke` is the reconciliation writer for exactly this
                // non-enablable custody and is already satisfied there; the
                // user-facing toggles refuse transitional custody.
                return input.action === 'revoke'
                    ? {
                        ok: true as const,
                        state: 'installed_disabled' as const,
                        changedConfiguration: false,
                        revision: record.revision,
                    }
                    : { ok: false, code: 'reconciliation_required' };
            }
            if (!await isInstallationActionCurrent(input)) {
                return { ok: false, code: 'generation_mismatch' };
            }
            const state = input.action === 'enable'
                ? 'active'
                : input.action === 'disable'
                    ? 'disabled'
                    : 'revoked';
            const updated = {
                ...record,
                state,
                updatedAtMs: (input.now ?? Date.now)(),
                revision: record.revision + 1,
            } satisfies ExternalSessionHookInstallationRecord;
            try {
                await writeInstallationRecord(recordPath, updated, persistence);
            } catch {
                return { ok: false, code: 'write_failed' };
            }
            return {
                ok: true,
                state: state === 'active' ? 'installed_enabled' : 'installed_disabled',
                changedConfiguration: false,
                revision: updated.revision,
            };
        }
        if (input.action === 'uninstall' && !record) {
            await removeEmptyInstallationRecordAgentDirectory(recordPath);
            return {
                ok: true,
                state: 'not_installed',
                changedConfiguration: false,
                revision: 0,
            };
        }

        let targets: readonly ResolvedTarget[];
        let variantId: string;
        if (input.action === 'install') {
            if (!input.selectedVariant || !input.materializeOwnedEntry) {
                return { ok: false, code: 'invalid_target_path' };
            }
            const resolved = await resolveInstallTargets(input.selectedVariant, input.targets);
            if (!resolved) return { ok: false, code: 'invalid_target_path' };
            if (record && !installTargetsMatchRecord(record, resolved)) {
                return { ok: false, code: 'reconciliation_required' };
            }
            targets = resolved;
            variantId = input.selectedVariant.variantId;
        } else {
            targets = targetsFromRecord(record!);
            variantId = record!.variantId;
        }

        const prepared = await prepareMutations({
            action: input.action,
            targets,
            ...(input.selectedVariant ? { variant: input.selectedVariant } : {}),
            record,
            actionInput: input,
        });
        if (!prepared.ok) return prepared;
        if (
            input.action === 'install'
            && input.expectedInputIdentities !== undefined
            && (
                input.expectedInputIdentities.length !== prepared.inputIdentities.length
                || input.expectedInputIdentities.some((expected, index) => {
                    const current = prepared.inputIdentities[index];
                    return current?.targetId !== expected.targetId
                        || current.inputIdentity !== expected.inputIdentity;
                })
            )
        ) {
            return { ok: false, code: 'concurrent_edit' };
        }
        const nextOwnedEntries = input.action === 'install'
            ? prepared.mutations.flatMap((mutation) => mutation.ownedEntries)
            : record!.ownedEntries;
        const nextRecordTargets = input.action === 'install'
            ? prepared.mutations.map((mutation): InstallationRecordTarget => ({
                targetId: mutation.target.targetId,
                absolutePath: mutation.target.absolutePath,
                collectionId: mutation.target.collectionId,
                inputIdentity: mutation.candidateIdentity,
            }))
            : record!.targets;
        const revision = (record?.revision ?? 0) + 1;
        const preparing = makeRecord({
            actionInput: input,
            variantId,
            targets: nextRecordTargets,
            ownedEntries: mergePreparingOwnedEntries(record, nextOwnedEntries),
            state: input.action === 'install' ? 'preparing' : 'revoked',
            revision,
        });
        if (!await isInstallationActionCurrent(input)) {
            return { ok: false, code: 'generation_mismatch' };
        }
        try {
            await writeInstallationRecord(recordPath, preparing, persistence);
        } catch {
            return { ok: false, code: 'write_failed' };
        }

        const mutation = await applyMutations({
            mutations: prepared.mutations,
            actionInput: input,
        });
        if (!mutation.ok) return mutation;

        if (input.action === 'uninstall') {
            if (!await isInstallationActionCurrent(input)) {
                return { ok: false, code: 'reconciliation_required' };
            }
            try {
                await rm(recordPath);
                await removeEmptyInstallationRecordAgentDirectory(recordPath);
            } catch {
                return { ok: false, code: 'write_failed' };
            }
            return {
                ok: true,
                state: 'not_installed',
                changedConfiguration: prepared.mutations.length > 0,
                revision,
            };
        }

        const disabled = makeRecord({
            actionInput: input,
            variantId,
            targets: nextRecordTargets,
            ownedEntries: nextOwnedEntries,
            state: 'disabled',
            revision,
        });
        if (!await isInstallationActionCurrent(input)) {
            await rollbackWrittenTargets({
                written: mutation.written,
                persistence,
            });
            return { ok: false, code: 'reconciliation_required' };
        }
        try {
            await writeInstallationRecord(recordPath, disabled, persistence);
        } catch {
            return { ok: false, code: 'write_failed' };
        }
        if (!await isInstallationActionCurrent(input)) {
            const compensation = {
                ...disabled,
                state: 'preparing',
                updatedAtMs: (input.now ?? Date.now)(),
                revision: disabled.revision + 1,
            } satisfies ExternalSessionHookInstallationRecord;
            try {
                await writeInstallationRecord(recordPath, compensation, persistence);
            } catch {
                await rollbackWrittenTargets({
                    written: mutation.written,
                    persistence,
                });
                return { ok: false, code: 'reconciliation_required' };
            }
            await rollbackWrittenTargets({
                written: mutation.written,
                persistence,
            });
            return { ok: false, code: 'reconciliation_required' };
        }
        return {
            ok: true,
            state: 'installed_disabled',
            changedConfiguration: true,
            revision,
        };
    });
}
