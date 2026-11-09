import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import type { Encryption, MachineEncryptionContext, MachineEncryptionContextInput } from '@/sync/encryption/encryption';
import { areMachineEncryptionContextInputsEqual, readMachineEncryptionContextInput } from '@/sync/encryption/machineEncryption';
import { MachineKeyBasisStoredReadV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import {
    isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import {
    isPlainMachineDataKeyMarker,
    resolvePublishedMachineDataEncryptionKeyV1,
    type ExpectedRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol/machines/machineStoredContent';

import { getOrCreateScopedCacheTokenKey, resetScopedCacheTokenKeysForTests } from './scopedCacheTokenKey';
import type { CapturedServerReadTransport } from './capturedServerReadTransport';
import { readExplicitMachineTransportRow, readMachineRows, resetMachineRowReadsForTests, type PreparedMachineRows } from '@/sync/api/machines/machineRowsApi';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { admitMachineRowPlainMode, type AccountE2eeCustody } from '@happier-dev/sync-client';

type MachineContextAuthority = Pick<Encryption, 'captureMachineEncryptionContext' | 'captureMachineEncryptionContextForRead' | 'getMachineEncryptionContext' | 'removeMachineEncryption'>;

function machineRowTimeoutError() {
    return Object.assign(createRpcCallError({ error: 'Machine row request timed out', errorCode: 'MACHINE_RPC_TIMEOUT' }),
        { code: 'MACHINE_RPC_TIMEOUT' as const });
}

type MachineInstallationTransportIdentity = Readonly<{
    installationId?: string | null;
    installationPublicKey?: string | null;
    /** Existing retained key/access selection, not a new lifetime or an allow verdict. */
    readScope?: object;
}>;

export type ScopedMachineTransport =
    | Readonly<{ mode: 'plain'; context?: MachineEncryptionContext } & MachineInstallationTransportIdentity>
    | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array | null; context?: MachineEncryptionContext } & MachineInstallationTransportIdentity>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function toMachineTransportCacheKey(serverId: string, machineId: string, token: string): string {
    const tokenKey = getOrCreateScopedCacheTokenKey(token);
    return `${serverId}::${machineId}::${tokenKey}`;
}

type MachineTransportSelection = Readonly<{
    machine: Parameters<typeof resolvePublishedMachineDataEncryptionKeyV1>[0]['machine'] & MachineInstallationTransportIdentity;
    identity: MachineEncryptionContextInput;
    selectedContext?: MachineEncryptionContext;
    metadataVersion?: number;
    daemonStateVersion?: number;
}>;

type MachineTransportEvidence = MachineTransportSelection & Readonly<{
    openedDataEncryptionKey: Uint8Array | null;
}>;

const machineTransportCache = new Map<string, MachineTransportSelection>();

async function fetchMachineTransport(params: Readonly<{
    serverUrl: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    token: string;
    machineId: string;
    serverId: string;
    accountId?: string;
    cacheKey: string;
    encryption?: MachineContextAuthority;
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs: number;
    readTransport?: CapturedServerReadTransport;
    preparedMachineRows?: PreparedMachineRows;
    signal?: AbortSignal;
}>): Promise<MachineTransportEvidence | null> {
    const incumbentContext = params.encryption?.getMachineEncryptionContext(params.machineId);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs))
        : null;
    const cancellation = mergeAbortSignals([params.signal, controller?.signal]);

    try {
        const payload = params.readTransport
            ? { machine: (await (params.preparedMachineRows
                ? params.preparedMachineRows.read([params.machineId], cancellation.signal)
                : readMachineRows({ readTransport: params.readTransport, machineIds: [params.machineId],
                    signal: cancellation.signal }))).get(params.machineId) }
            : await readExplicitMachineTransportRow({ ...params, authorityKey: params.cacheKey,
                signal: cancellation.signal ?? new AbortController().signal });
        throwIfAborted(params.signal);
        const body = payload as {
            machine?: {
                id?: unknown;
                kind?: 'persistent' | 'ephemeral_session_runner';
                installationId?: string | null;
                installationPublicKey?: string | null;
                dataEncryptionKey?: unknown;
                runnerContentKeyBinding?: unknown;
                access?: unknown;
                keyBasis?: unknown;
                metadataVersion?: number;
                daemonStateVersion?: number;
            };
        };
        const machine = body?.machine;
        if (!machine) {
            // Home deliberately conceals inaccessible and absent Machines alike.
            // Preserve that access refusal before attempting any key opening.
            params.encryption?.removeMachineEncryption(params.machineId);
            throw createRpcCallError({ error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN });
        }
        if (normalizeId(machine.id) !== params.machineId) {
            return null;
        }
        const published = machine?.dataEncryptionKey;
        const input = readMachineEncryptionContextInput(machine ?? {}, params.accountId ?? null);
        const cached = machineTransportCache.get(params.cacheKey);
        const basis = MachineKeyBasisStoredReadV1Schema.safeParse(machine?.keyBasis);
        const metadataVersion = basis.success ? basis.data.metadataVersion : machine?.metadataVersion;
        const daemonStateVersion = basis.success ? basis.data.daemonStateVersion : machine?.daemonStateVersion;
        if ((metadataVersion !== undefined && cached?.metadataVersion !== undefined && metadataVersion < cached.metadataVersion)
            || (daemonStateVersion !== undefined && cached?.daemonStateVersion !== undefined && daemonStateVersion < cached.daemonStateVersion)) return null;
        const unchanged = cached && areMachineEncryptionContextInputsEqual(cached.identity, input);
        const identity = unchanged ? cached.identity : input;
        const context = params.encryption?.captureMachineEncryptionContextForRead(
            params.machineId,
            input,
            { incumbent: incumbentContext, observation: machine },
        );
        if (params.encryption && !context) return null;
        const selected: MachineTransportSelection = {
            machine: {
                id: params.machineId, kind: machine?.kind, installationId: machine?.installationId,
                installationPublicKey: machine?.installationPublicKey,
                dataEncryptionKey: published, runnerContentKeyBinding: machine?.runnerContentKeyBinding,
                access: machine?.access,
            },
            identity, metadataVersion, daemonStateVersion,
            selectedContext: context ?? undefined,
        };
        // Publish selection before opening yields so a changed key/access
        // identity retires pending work, including same-key access withdrawal.
        machineTransportCache.set(params.cacheKey, selected);
        // The caller's Encryption owner alone retains openings under its own material.
        const dataKey = typeof published === 'string'
            && !isPlainMachineDataKeyMarker(published)
            && params.decryptEncryptionKey
            ? await params.decryptEncryptionKey(published)
            : null;
        throwIfAborted(params.signal);
        const current = machineTransportCache.get(params.cacheKey);
        if (context?.isCurrent() === false || current?.identity !== selected.identity) return null;
        // A fresh row with the same key/access identity does not retire an
        // in-flight opening. Keep its newer row/version facts in the cache,
        // while this caller retains its own crypto context for currentness.
        return { ...current, openedDataEncryptionKey: dataKey, selectedContext: context ?? undefined };
    } catch (error) {
        // An unavailable transport is not evidence that the Machine has no key.
        throwIfAborted(params.signal);
        if (isTerminalAuthError(error)) throw error;
        if (controller?.signal.aborted) throw machineRowTimeoutError();
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        cancellation.dispose();
    }
}

export async function resolveScopedMachineTransport(params: Readonly<{
    serverId: string;
    serverUrl: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    token: string;
    machineId: string;
    accountId?: string;
    /** This credential's E2EE custody, for the Account downgrade pin on Home-reported plain rows. */
    accountE2eeCustody?: AccountE2eeCustody;
    encryption?: MachineContextAuthority;
    expectedAccountMode?: 'plain' | 'e2ee';
    readAccountMode?: () => Promise<'plain' | 'e2ee'>;
    expectedRunnerBinding?: ExpectedRunnerMachineContentKeyBindingV1;
    trustedMachineKind?: 'ephemeral_session_runner';
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs?: number;
    readTransport?: CapturedServerReadTransport;
    preparedMachineRows?: PreparedMachineRows;
    signal?: AbortSignal;
}>): Promise<ScopedMachineTransport | null> {
    const machineId = normalizeId(params.machineId);
    const serverId = normalizeId(params.serverId);
    const token = String(params.token ?? '');
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
    const keyCacheKey = toMachineTransportCacheKey(serverId, machineId, token);
    const incumbentContext = params.encryption?.getMachineEncryptionContext(machineId);
    // Refresh the Home row each call to confirm the exact envelope and authenticated access identity.
    // Only physical row work is shared. Every caller still selects and fences
    // its own crypto context; settled observations never authorize another read.
    const evidence = await fetchMachineTransport({
            serverId,
            serverUrl: params.serverUrl,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
            ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
            token,
            machineId,
            cacheKey: keyCacheKey,
            ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(params.encryption ? { encryption: params.encryption } : {}),
            decryptEncryptionKey: params.decryptEncryptionKey,
            timeoutMs,
            readTransport: params.readTransport,
            preparedMachineRows: params.preparedMachineRows,
            signal: params.signal,
        });
    if (!evidence) return null;
    const isLocalReadCurrent = () => {
        if (!params.encryption) return true;
        const current = params.encryption.getMachineEncryptionContext(machineId);
        return current === incumbentContext || current === evidence.selectedContext;
    };
    const isEvidenceCurrent = () => machineTransportCache.get(keyCacheKey)?.identity === evidence.identity;
    if (!isEvidenceCurrent() || !isLocalReadCurrent()) return null;
    const expectedAccountMode = params.expectedAccountMode ?? (evidence.machine.access === undefined ? await params.readAccountMode?.() : undefined);
    throwIfAborted(params.signal);
    if (!isEvidenceCurrent() || !isLocalReadCurrent()) return null;
    const resolution = resolvePublishedMachineDataEncryptionKeyV1({
        ...evidence,
        ...(params.accountId ? { viewerAccountId: params.accountId } : {}),
        ...(expectedAccountMode ? { expectedAccountMode } : {}),
        ...(params.expectedRunnerBinding ? { expectedRunnerBinding: params.expectedRunnerBinding } : {}),
        ...(params.trustedMachineKind ? { trustedMachineKind: params.trustedMachineKind } : {}),
    });
    if (resolution.status === 'unavailable') {
        return null;
    }
    if (resolution.status === 'plain') {
        // The same Home serves the row: an own-Account Machine reported plain while this
        // device holds active E2EE custody is a downgrade, never a plaintext transport.
        try {
            admitMachineRowPlainMode({ access: evidence.machine.access, viewerAccountId: params.accountId,
                custody: params.accountE2eeCustody ?? 'absent' });
        } catch {
            return null;
        }
    }
    const localContext = params.encryption?.captureMachineEncryptionContext(machineId, evidence.identity);
    const context: MachineEncryptionContext = {
        ...evidence.identity,
        isCurrent: () => isEvidenceCurrent() && localContext?.isCurrent() !== false,
    };
    const installation = { readScope: evidence.identity, installationId: evidence.machine.installationId ?? null,
        installationPublicKey: evidence.machine.installationPublicKey ?? null };
    if (resolution.status === 'legacy') return { mode: 'e2ee', dataKey: null, context, ...installation };
    return resolution.status === 'plain'
        ? { mode: 'plain', context, ...installation }
        : { mode: 'e2ee', dataKey: resolution.dataKey, context, ...installation };
}

export function resetScopedMachineTransportCacheForTests(): void {
    machineTransportCache.clear();
    resetMachineRowReadsForTests();
    resetScopedCacheTokenKeysForTests();
}
