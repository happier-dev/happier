import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { core } from 'zod/mini';
import {
    MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
    type MachinePresetHttpActionIdV1, type MachinePresetActionInputV1, type MachinePresetActionOutputV1,
} from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import {
    ManagedMachinePresetRecipientCensusInputV1Schema, ManagedMachinePresetRecipientCensusResultV1Schema,
    type ManagedMachinePresetV1, type ManagedMachinePresetRecipientCensusInputV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import {
    createManagedMachinePresetAcquireOverrideV1, createManagedMachinePresetLaunchNameOverrideV1,
    createManagedMachinePresetResizeOverrideV1,
    createManagedMachinePresetSetupOverrideV1,
    projectManagedMachinePresetForRecipientV1,
    replaceManagedMachinePresetAuthorContentV1,
    rewrapManagedMachinePresetRecipientsV1,
    sealManagedMachinePresetContentV1,
    ManagedMachinePresetContentV1Schema,
    ManagedMachinePresetRecipientProjectionV1Schema,
    type ManagedMachinePresetContentV1, type ManagedMachinePresetLaunchNameOverrideV1,
    type ManagedMachinePresetRecipientProjectionV1, type ManagedMachinePresetSavedSecretReferenceRewriteV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import {
    isManagedOpaquePresetReadV1, ManagedListOutputV1Schema, type ManagedMachineReadV1, type ManagedOpaquePresetReadV1,
    type ManagedMachineActionInputV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { isManagedOpaquePresetMachineV1, type ManagedMachineEnrollmentIdentityV1, type ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerSizeV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { mergeMachineSetupsV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import {
    admitManagedMachinePresetAuthorCensusV1,
    captureManagedMachinePresetSavedSecretReferencesV1,
    hydrateManagedOpaquePresetMachineV1,
    prepareManagedMachinePresetSavedSecretPromotionRewritesV1,
    type ManagedMachinePresetSavedSecretPromotionReaderV1,
} from '@happier-dev/cli-common/machines/managed';

import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { classifyHomeActionOutcome, observeHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { classifyAccountStorageReadFailure } from '@/sync/encryption/accountStorageContext';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ProfileAccountContext } from '@/sync/api/account/apiProfileCatalog';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import {
    captureManagedMachinePresetCustodyV1,
    captureManagedMachinePresetE2eeCustodyV1,
    createManagedMachinePresetReadCustodyV1,
    openManagedMachinePresetRecipientProjectionAtCustodyV1,
    type ManagedMachinePresetCustodyV1, type ManagedMachinePresetE2eeCustodyV1,
    type ManagedMachinePresetReadCustodyV1,
} from './managedMachinePresetCustody';
import {
    awaitActionApprovalResult,
    type ActionApprovalContinuation, type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';
import {
    machinePresetEditDraftContent, machinePresetEditDraftUpdatePatch,
    type MachinePresetCreateDraftInput, type MachinePresetEditDraft, type MachinePresetUpdateDraftInput,
} from '@/sync/domains/machines/presets/machinePresetEditDraft';

const PRESET_RECIPIENT_CENSUS_PATH = '/v1/machines/presets/recipient-census';

export type MachinePresetCollectionResult<T> =
    | Readonly<{ kind: 'succeeded'; value: T }>
    | Readonly<{ kind: 'approval_pending'; approval: ActionApprovalContinuation }>
    | Readonly<{ kind: 'failed'; code: string; diagnosticDetail?: string }>;
export type MachinePresetCollectionSettledResult<T> = Exclude<MachinePresetCollectionResult<T>, { kind: 'approval_pending' }>;
export type MachinePresetContentOverrideResult =
    | Readonly<{ kind: 'unchanged' }>
    | Readonly<{ kind: 'ready'; override: ManagedMachinePresetLaunchNameOverrideV1 }>
    | Readonly<{ kind: 'failed'; code: 'content_unavailable' }>;
export type MachinePresetLaunchNameOverrideResult = MachinePresetContentOverrideResult;
export type MachinePresetSetupOverrideResult = MachinePresetContentOverrideResult;
export type MachinePresetAcquireOverrideResult = Exclude<MachinePresetContentOverrideResult, { kind: 'unchanged' }>;
export type MachinePresetResizeOverrideResult = MachinePresetContentOverrideResult;

/**
 * The sole resize-sealing basis: an exact recipient projection already opened
 * at an Account custody boundary. It deliberately contains no audience list
 * and is never sent to Home.
 */
type ManagedMachinePresetResizeProjectionBasisV1 = Readonly<{
    presetId: string;
    contentEncryptionMode: 'plain' | 'e2ee';
    recipientProjection: ManagedMachinePresetRecipientProjectionV1;
    resize: ManagedMachinePresetContentV1['resize'];
}>;
type ManagedMachinePresetReadSnapshotBasisV1 = Readonly<{
    originalRead: ManagedOpaquePresetReadV1;
    resizeBasis?: ManagedMachinePresetResizeProjectionBasisV1;
    imageRevision?: number;
}>;
const managedMachinePresetReadSnapshotBasisV1: unique symbol = Symbol('managedMachinePresetReadSnapshotBasisV1');
type ManagedMachineReadSnapshotWithBasisV1 = ManagedMachineReadSnapshotV1 & Readonly<{
    [managedMachinePresetReadSnapshotBasisV1]?: ManagedMachinePresetReadSnapshotBasisV1;
}>;

/** Private preset fields become visible only after this client opens the persisted envelope. */
export type OpenedManagedMachinePresetV1 = Omit<ManagedMachinePresetV1, 'content' | 'recipients'> & ManagedMachinePresetContentV1 & Readonly<{
    /** Exact one-recipient basis for an acquire-time name override; never a latest-preset fetch or audience list. */
    recipientProjection: ManagedMachinePresetRecipientProjectionV1;
}>;
/** A listed row remains visible when this Account cannot open its private body. */
export type ManagedMachinePresetPrivateContentUnavailableV1 = Omit<ManagedMachinePresetV1, 'content' | 'recipients'> & Partial<Record<keyof ManagedMachinePresetContentV1, never>> & Readonly<{
    kind: 'private_content_unavailable';
}>;
export type ManagedMachinePresetListEntryV1 = OpenedManagedMachinePresetV1 | ManagedMachinePresetPrivateContentUnavailableV1;
export function isOpenedManagedMachinePresetV1(value: ManagedMachinePresetListEntryV1): value is OpenedManagedMachinePresetV1 {
    return !('kind' in value && value.kind === 'private_content_unavailable');
}
/** An opened launch is portable; the selected host/placement decides where it can execute. */
export type OpenedManagedMachinePresetCreationV1 = Omit<OpenedManagedMachinePresetV1, 'launch'> & Readonly<{
    launch: NonNullable<OpenedManagedMachinePresetV1['launch']>;
}>;
type OpenedMachinePreset = OpenedManagedMachinePresetV1;

/** Creation is a UI decision over opened content; placement remains a later host-owner decision. */
export function hasOpenedManagedMachinePresetCreationV1<T extends Readonly<{
    launch?: OpenedManagedMachinePresetV1['launch'] | null;
}>>(preset: T | null | undefined): preset is T & OpenedManagedMachinePresetCreationV1 {
    return preset?.launch != null;
}

type OpenedPresetActionOutput<T extends MachinePresetHttpActionIdV1> =
    T extends 'machines.presets.get' ? Omit<Extract<MachinePresetActionOutputV1<T>, { kind: 'found' }>, 'preset'> & Readonly<{ preset: OpenedMachinePreset }>
        | Exclude<MachinePresetActionOutputV1<T>, { kind: 'found' }>
    : T extends 'machines.presets.list' ? Omit<Extract<MachinePresetActionOutputV1<T>, { kind: 'listed' }>, 'presets'> & Readonly<{ presets: readonly ManagedMachinePresetListEntryV1[] }>
        | Exclude<MachinePresetActionOutputV1<T>, { kind: 'listed' }>
    : T extends 'machines.presets.create' | 'machines.presets.update' | 'machines.presets.archive' | 'machines.presets.restore'
        ? Omit<Extract<MachinePresetActionOutputV1<T>, { kind: 'saved' }>, 'preset'> & Readonly<{ preset: OpenedMachinePreset }>
            | Exclude<MachinePresetActionOutputV1<T>, { kind: 'saved' }>
        : never;
export type OpenedMachinePresetActionOutputV1<T extends MachinePresetHttpActionIdV1> = OpenedPresetActionOutput<T>;

type MachinePresetClientInput<T extends MachinePresetHttpActionIdV1> =
    T extends 'machines.presets.create' ? MachinePresetCreateDraftInput
        : T extends 'machines.presets.update' ? MachinePresetUpdateDraftInput
            : MachinePresetActionInputV1<T>;

export type MachinePresetCollectionFilter = Pick<MachinePresetActionInputV1<'machines.presets.list'>, 'sharedWithTeamId'>;

export type MachinePresetCollectionOptions<T> = Readonly<{
    signal?: AbortSignal;
    /** Client-side filter applied after the envelope has been opened. */
    search?: string;
    /** Exact visible structural basis for a content edit; no latest-record fetch is allowed. */
    preset?: Readonly<Partial<Pick<OpenedMachinePreset,
        'owner' | 'controller' | 'controllerPoolId' | 'teamAcquireDelegated' | 'name' | 'launch' | 'setup' | 'controllerDisplayName'
        | 'contentEncryptionMode' | 'recipientProjection'>>>;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
    onApprovalSettled?: () => void;
    onApprovalSucceeded?: (value: T) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;

export type MachinePresetHistoryData = Readonly<{ preset: OpenedMachinePreset; machines: readonly ManagedMachineReadSnapshotV1[] }>;
export type MachinePresetDraftSaveInput = Readonly<{ draft: MachinePresetEditDraft } & (
    | { preset: Readonly<Pick<OpenedMachinePreset, 'id' | 'revision'>
        & Partial<Pick<OpenedMachinePreset, 'owner' | 'controller' | 'controllerPoolId' | 'teamAcquireDelegated'>>> }
    | { id: string; owner: OpenedMachinePreset['owner'] }
)>;
export type MachinePresetCaptureInput = Omit<MachinePresetCreateDraftInput, 'privateContent'> & Readonly<{
    name: string;
    launch?: ManagedMachinePresetContentV1['launch'];
    controllerDisplayName?: string;
}>;

type WriterMode = 'plain' | 'e2ee';
type SealResult = Readonly<{ kind: 'sealed'; contentEncryptionMode: 'plain' | 'e2ee'; content: ManagedMachinePresetV1['content']; recipients: ManagedMachinePresetV1['recipients'] }>
    | Readonly<{ kind: 'failed'; code: string; diagnosticDetail?: string }>;

async function resolveReaderKey(scope: ServerAccountScope, signal?: AbortSignal): Promise<ManagedMachinePresetE2eeCustodyV1 | null> {
    let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
    let retainAccount = false;
    try {
        account = await captureLazyActionAccountContext(scope.serverId, signal);
        const custody = await captureManagedMachinePresetE2eeCustodyV1({ account, expectedAccountId: scope.accountId, signal });
        if (!custody) return null;
        const capturedAccount = account;
        let disposed = false;
        const ownedCustody: ManagedMachinePresetE2eeCustodyV1 = Object.freeze({
            ...custody,
            dispose: () => {
                if (disposed) return;
                disposed = true;
                custody.dispose();
                capturedAccount.dispose();
            },
        });
        retainAccount = true;
        return ownedCustody;
    } catch (error) {
        const reason = classifyAccountStorageReadFailure(error, signal);
        if (reason === 'cancelled' || reason === 'scope-retired') throw error;
        return null;
    } finally {
        if (!retainAccount) account?.dispose();
    }
}

/**
 * One list/get operation owns one captured Account lifetime. Plain rows use
 * that lifetime without asking for an E2EE key; E2EE rows lazily copy a key
 * from the same capture. This keeps stored resource mode authoritative while
 * making cancellation/currentness effective at every recipient projection.
 */
async function captureManagedMachinePresetReadCustodyV1(scope: ServerAccountScope,
    signal?: AbortSignal): Promise<ManagedMachinePresetReadCustodyV1 | null> {
    let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
    try {
        account = await captureLazyActionAccountContext(scope.serverId, signal);
        const custody = createManagedMachinePresetReadCustodyV1({ account,
            expectedAccountId: scope.accountId, signal });
        if (!custody) return null;
        const capturedAccount = account;
        account = null;
        return Object.freeze({
            open: custody.open,
            dispose: async () => {
                await custody.dispose();
                capturedAccount.dispose();
            },
        });
    } catch (error) {
        const reason = classifyAccountStorageReadFailure(error, signal);
        if (reason === 'cancelled' || reason === 'scope-retired') throw error;
        return null;
    } finally {
        account?.dispose();
    }
}

async function prepareManagedMachinePresetResizeOverrideFromProjection(scope: ServerAccountScope,
    basis: ManagedMachinePresetResizeProjectionBasisV1, size: MachineProvisionerSizeV1,
    signal?: AbortSignal): Promise<MachinePresetResizeOverrideResult> {
    if (sameStrictJsonValue(basis.resize, size)) return { kind: 'unchanged' };
    if (basis.contentEncryptionMode === 'plain') {
        const override = createManagedMachinePresetResizeOverrideV1({ presetId: basis.presetId, mode: 'plain',
            projection: basis.recipientProjection, size });
        return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
    }
    const reader = await resolveReaderKey(scope, signal);
    if (!reader) return { kind: 'failed', code: 'content_unavailable' };
    try {
        const override = reader.withAccountKey(({ accountId, accountKey }) => createManagedMachinePresetResizeOverrideV1({
            presetId: basis.presetId, mode: 'e2ee', projection: basis.recipientProjection, accountId, accountKey,
            size, randomBytes: getRandomBytes,
        }));
        return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
    } finally { reader.dispose(); }
}

function attachManagedMachineReadSnapshotBasis(machine: ManagedMachineReadSnapshotV1,
    basis: ManagedMachinePresetReadSnapshotBasisV1): ManagedMachineReadSnapshotV1 {
    const local = { ...machine } as ManagedMachineReadSnapshotWithBasisV1;
    Object.defineProperty(local, managedMachinePresetReadSnapshotBasisV1, {
        value: Object.freeze(basis), enumerable: false, configurable: false, writable: false,
    });
    return local;
}

function readManagedMachineReadSnapshotBasis(machine: ManagedMachineReadSnapshotV1): ManagedMachinePresetReadSnapshotBasisV1 | null {
    const candidate = Object.getOwnPropertyDescriptor(machine, managedMachinePresetReadSnapshotBasisV1)?.value;
    if (!candidate || typeof candidate !== 'object') return null;
    const basis = candidate as ManagedMachinePresetReadSnapshotBasisV1;
    const original = basis.originalRead.machine;
    const preset = machine.preset;
    if (machine.id !== original.id || machine.homeId !== original.homeId || !preset
        || preset.id !== original.preset.id || preset.revision !== original.preset.revision
        || preset.contentEncryptionMode !== original.preset.contentEncryptionMode) return null;
    const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse(basis.originalRead.presetContent);
    return projection.success ? basis : null;
}

/** Source revision of the prepared image actually selected at this Machine's admission. */
export function readManagedMachinePresetImageRevision(machine: ManagedMachineReadSnapshotV1): number | undefined {
    return readManagedMachineReadSnapshotBasis(machine)?.imageRevision;
}

/** The current Account mode, not a recipient census, owns the mode of a new private body. */
async function resolveWriterMode(scope: ServerAccountScope, signal?: AbortSignal): Promise<WriterMode | null> {
    let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
    try {
        account = await captureLazyActionAccountContext(scope.serverId, signal);
        if (account.accountId !== scope.accountId) return null;
        const { accountMode, encryption } = await account.resolveAccountEncryption(signal);
        account.assertCurrent();
        if (accountMode === 'plain') return 'plain';
        return encryption ? 'e2ee' : null;
    } catch {
        return null;
    } finally { account?.dispose(); }
}

async function openManagedMachineReadSnapshot(read: ManagedMachineReadV1,
    reader: () => Promise<ManagedMachinePresetReadCustodyV1 | null>): Promise<ManagedMachineReadSnapshotV1> {
    if (!isManagedOpaquePresetReadV1(read)) return read;
    const { machine, presetContent } = read;
    const mode = machine.preset.contentEncryptionMode;
    const custody = await (await reader())?.open(mode);
    const content = openManagedMachinePresetRecipientProjectionAtCustodyV1({ presetId: machine.preset.id,
        mode, projection: presetContent, custody });
    const hydrated = content ? hydrateManagedOpaquePresetMachineV1({ machine, opened: content }) : null;
    // Cold admissions may retain a ready image receipt without selecting it.
    const imageRevision = hydrated && content?.preparationExecution && content.prepared?.status === 'ready'
        ? content.prepared.builtFromRevision : undefined;
    return attachManagedMachineReadSnapshotBasis(hydrated ?? machine, {
        originalRead: read,
        ...(hydrated && content ? { resizeBasis: { presetId: machine.preset.id, contentEncryptionMode: mode,
            recipientProjection: presetContent, resize: content.resize } } : {}),
        ...(imageRevision === undefined ? {} : { imageRevision }),
    });
}

/**
 * Opens exact managed-row projections with the Action Account already captured
 * by the caller. The caller retains custody lifetime and disposal ownership.
 */
export async function openManagedMachineReadSnapshotsAtCustody(reads: readonly ManagedMachineReadV1[],
    custody: ManagedMachinePresetReadCustodyV1 | null): Promise<ManagedMachineReadSnapshotV1[]> {
    return await Promise.all(reads.map(read => openManagedMachineReadSnapshot(read, async () => custody)));
}

/** Open exact admitted managed-row projections once at the Account custody boundary. */
export async function openManagedMachineReadSnapshots(scope: ServerAccountScope, reads: readonly ManagedMachineReadV1[],
    signal?: AbortSignal): Promise<ManagedMachineReadSnapshotV1[]> {
    const readerState: { key: Promise<ManagedMachinePresetReadCustodyV1 | null> | null } = { key: null };
    const reader = () => readerState.key ??= captureManagedMachinePresetReadCustodyV1(scope, signal);
    try {
        return await Promise.all(reads.map(read => openManagedMachineReadSnapshot(read, reader)));
    } finally {
        const key = await readerState.key;
        await key?.dispose();
    }
}

/** Native control consumes the original public read rather than the opened private row. */
export function readManagedMachineReadForSnapshot(machine: ManagedMachineReadSnapshotV1): ManagedMachineReadV1 | undefined {
    return readManagedMachineReadSnapshotBasis(machine)?.originalRead
        ?? (isManagedOpaquePresetMachineV1(machine) || machine.preset?.contentEncryptionMode === 'e2ee'
            ? undefined : machine);
}

/**
 * Seals a private resize from the exact admitted/listed managed-row snapshot.
 * The retained recipient projection is local-only and binds this call to the
 * selected revision; this function never reads a newer Preset.
 */
export async function prepareManagedMachinePresetResizeOverrideForSnapshot(scope: ServerAccountScope,
    machine: ManagedMachineReadSnapshotV1, size: MachineProvisionerSizeV1,
    signal?: AbortSignal): Promise<MachinePresetResizeOverrideResult> {
    const basis = readManagedMachineReadSnapshotBasis(machine)?.resizeBasis;
    return basis ? await prepareManagedMachinePresetResizeOverrideFromProjection(scope, basis, size, signal)
        : { kind: 'failed', code: 'content_unavailable' };
}

/** The exact read snapshot decides the resize carrier; legacy full rows retain native size input. */
export async function prepareManagedMachineResizeInputForSnapshot(scope: ServerAccountScope,
    machine: ManagedMachineReadSnapshotV1, size: MachineProvisionerSizeV1, signal?: AbortSignal): Promise<
    Readonly<{ kind: 'ready'; input: ManagedMachineActionInputV1<'machines.managed.resize'> }>
    | Exclude<MachinePresetResizeOverrideResult, { kind: 'ready' }>
> {
    const hasOpenedBasis = Object.hasOwn(machine, managedMachinePresetReadSnapshotBasisV1);
    if (!isManagedOpaquePresetMachineV1(machine) && !hasOpenedBasis
        && machine.preset?.contentEncryptionMode !== 'e2ee') {
        return { kind: 'ready', input: { homeId: machine.homeId, managedId: machine.id, size } };
    }
    const prepared = await prepareManagedMachinePresetResizeOverrideForSnapshot(scope, machine, size, signal);
    return prepared.kind === 'ready' ? { kind: 'ready', input: {
        homeId: machine.homeId, managedId: machine.id, presetContentOverride: prepared.override,
    } } : prepared;
}

function readPresetDomainFailureResult<T extends MachinePresetHttpActionIdV1>(actionId: T, code: string,
    details: unknown): MachinePresetActionOutputV1<T> | null {
    const output = MachinePresetActionOutputSchemasV1[actionId].safeParse(details);
    if (!output.success) return null;
    const value = output.data;
    return value.kind === 'conflict' && code === 'conflict'
        || value.kind === 'refused' && value.code === code
        ? value as MachinePresetActionOutputV1<T> : null;
}

function sameRecipientEnvelopes(left: Readonly<ManagedMachinePresetV1['recipients']>, right: Readonly<ManagedMachinePresetV1['recipients']>) {
    return left.length === right.length && left.every((recipient, index) => recipient.accountId === right[index]?.accountId
        && JSON.stringify(recipient.envelope) === JSON.stringify(right[index]?.envelope));
}

type ManagedMachinePresetSavedSecretCaptureContext = Readonly<{
    scope: ServerAccountScope;
    homeId: string;
    account: ProfileAccountContext;
    signal?: AbortSignal;
}>;

function assertManagedMachinePresetSavedSecretCaptureCurrent(context: Pick<ManagedMachinePresetSavedSecretCaptureContext, 'account' | 'signal'>) {
    context.signal?.throwIfAborted();
    context.account.assertCurrent();
}

/** The Home's current preset audience and persisted Account mode for one captured Action Account. */
export async function requestManagedMachinePresetRecipientCensusInContext(
    context: Pick<ManagedMachinePresetSavedSecretCaptureContext, 'homeId' | 'account' | 'signal'>, input: unknown) {
    const parsed = ManagedMachinePresetRecipientCensusInputV1Schema.safeParse(input);
    if (!parsed.success || parsed.data.homeId !== context.homeId) return null;
    assertManagedMachinePresetSavedSecretCaptureCurrent(context);
    const response = await context.account.request(PRESET_RECIPIENT_CENSUS_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data), signal: context.signal,
    }, { retry: 'none' });
    assertManagedMachinePresetSavedSecretCaptureCurrent(context);
    const result = ManagedMachinePresetRecipientCensusResultV1Schema.safeParse(await response.json().catch(() => null));
    return response.ok && result.success ? result.data : null;
}

async function withManagedMachinePresetSavedSecretPromotionReader<T>(context: ManagedMachinePresetSavedSecretCaptureContext,
    operation: (reader: ManagedMachinePresetSavedSecretPromotionReaderV1) => Promise<T>): Promise<T | null> {
    if (context.account.accountId !== context.scope.accountId || context.account.serverIdentityId !== context.homeId) return null;
    const executeAction = scopedHomeActionExecutor(context.scope);
    const actionContext = { surface: 'ui' as const, authority: 'present_user' as const, serverId: context.scope.serverId,
        expectedAccountId: context.scope.accountId, ...(context.signal ? { signal: context.signal } : {}) };
    const captures: { plain: Promise<ManagedMachinePresetCustodyV1 | null> | null; e2ee: Promise<ManagedMachinePresetE2eeCustodyV1 | null> | null } = { plain: null, e2ee: null };
    const custody = async (mode: 'plain' | 'e2ee') => {
        if (mode === 'plain') {
            captures.plain ??= captureManagedMachinePresetCustodyV1({ account: context.account,
                expectedAccountId: context.scope.accountId, resourceMode: 'plain', signal: context.signal });
            return await captures.plain;
        }
        captures.e2ee ??= captureManagedMachinePresetE2eeCustodyV1({ account: context.account,
            expectedAccountId: context.scope.accountId, signal: context.signal });
        return await captures.e2ee;
    };
    const reader: ManagedMachinePresetSavedSecretPromotionReaderV1 = {
        accountId: context.account.accountId,
        listPresets: async cursor => {
            assertManagedMachinePresetSavedSecretCaptureCurrent(context);
            const input = MachinePresetActionInputSchemasV1['machines.presets.list'].safeParse({ homeId: context.homeId,
                includeArchived: true, ...(cursor ? { cursor } : {}) });
            if (!input.success) return null;
            const outcome = classifyHomeActionOutcome(await executeAction('machines.presets.list', input.data, actionContext),
                'machines.presets.list');
            assertManagedMachinePresetSavedSecretCaptureCurrent(context);
            if (outcome.kind !== 'completed') return null;
            const output = MachinePresetActionOutputSchemasV1['machines.presets.list'].safeParse(outcome.result);
            return output.success && output.data.kind === 'listed'
                ? { presets: output.data.presets, ...(output.data.cursor ? { cursor: output.data.cursor } : {}) } : null;
        },
        listManaged: async archived => {
            assertManagedMachinePresetSavedSecretCaptureCurrent(context);
            const outcome = classifyHomeActionOutcome(await executeAction('machines.managed.list', {
                homeId: context.homeId, ...(archived ? { archived: true } : {}),
            }, actionContext), 'machines.managed.list');
            assertManagedMachinePresetSavedSecretCaptureCurrent(context);
            if (outcome.kind !== 'completed') return null;
            const output = ManagedListOutputV1Schema.safeParse(outcome.result);
            return output.success ? output.data.machines : null;
        },
        readRecipientCensus: async input => await requestManagedMachinePresetRecipientCensusInContext(context, input),
        open: async input => {
            const captured = await custody(input.mode);
            assertManagedMachinePresetSavedSecretCaptureCurrent(context);
            return captured ? openManagedMachinePresetRecipientProjectionAtCustodyV1({ ...input, custody: captured }) : null;
        },
        withE2eeAccountKey: async operationWithKey => {
            const captured = await custody('e2ee');
            assertManagedMachinePresetSavedSecretCaptureCurrent(context);
            if (captured?.mode !== 'e2ee') return null;
            const result = captured.withAccountKey(operationWithKey);
            assertManagedMachinePresetSavedSecretCaptureCurrent(context);
            return await result;
        },
    };
    try {
        return await operation(reader);
    } finally {
        (await captures.plain)?.dispose();
        (await captures.e2ee)?.dispose();
    }
}

/** Open captured private rows through Account custody before classifying delete references. */
export async function captureManagedMachinePresetSavedSecretReferencesInContext(params: ManagedMachinePresetSavedSecretCaptureContext & Readonly<{ resourceRef: string }>) {
    try {
        const result = await withManagedMachinePresetSavedSecretPromotionReader(params,
            async reader => await captureManagedMachinePresetSavedSecretReferencesV1({ homeId: params.homeId, resourceRef: params.resourceRef, reader, signal: params.signal }));
        return result ?? { kind: 'unavailable' as const };
    } catch (error) {
        const reason = classifyAccountStorageReadFailure(error, params.signal);
        if (reason === 'cancelled' || reason === 'scope-retired') throw error;
        return { kind: 'unavailable' as const };
    }
}

/** Fresh-seal live Presets and same-DEK rewrite retained rows before a source promotion. */
export async function prepareManagedMachinePresetSavedSecretPromotionRewritesInContext(params: ManagedMachinePresetSavedSecretCaptureContext & Readonly<{
    rewrites: readonly ManagedMachinePresetSavedSecretReferenceRewriteV1[];
}>) {
    try {
        const result = await withManagedMachinePresetSavedSecretPromotionReader(params, async reader =>
            await prepareManagedMachinePresetSavedSecretPromotionRewritesV1({ homeId: params.homeId, rewrites: params.rewrites,
                reader, randomBytes: getRandomBytes, signal: params.signal }));
        return result ?? { kind: 'unavailable' as const };
    } catch (error) {
        const reason = classifyAccountStorageReadFailure(error, params.signal);
        if (reason === 'cancelled' || reason === 'scope-retired') throw error;
        return { kind: 'unavailable' as const };
    }
}

/** Settings reads and mutations all pass through the exact-Home Action front door. */
export function createMachinePresetCollectionClient(scope: ServerAccountScope, homeId: string) {
    const executeAction = scopedHomeActionExecutor(scope);
    const context = (signal?: AbortSignal) => ({ surface: 'ui' as const, authority: 'present_user' as const,
        serverId: scope.serverId, expectedAccountId: scope.accountId, ...(signal ? { signal } : {}) });

    async function requestRecipientCensus(input: unknown, signal?: AbortSignal) {
        const parsed = ManagedMachinePresetRecipientCensusInputV1Schema.safeParse(input);
        if (!parsed.success || parsed.data.homeId !== homeId) return null;
        const account = await captureLazyActionAccountContext(scope.serverId, signal);
        try {
            if (account.accountId !== scope.accountId) return null;
            const response = await account.request(PRESET_RECIPIENT_CENSUS_PATH, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data), signal,
            }, { retry: 'none' });
            account.assertCurrent();
            const result = ManagedMachinePresetRecipientCensusResultV1Schema.safeParse(await response.json().catch(() => null));
            return response.ok && result.success ? result.data : null;
        } catch {
            return null;
        } finally { account.dispose(); }
    }

    async function sealPrivateContent(input: Readonly<{
        presetId: string;
        writerMode: WriterMode;
        privateContent: ManagedMachinePresetContentV1;
        censusInput: ManagedMachinePresetRecipientCensusInputV1;
        current?: Readonly<Pick<OpenedMachinePreset, 'contentEncryptionMode' | 'recipientProjection'>>;
        teamAcquireDelegated?: boolean;
        signal?: AbortSignal;
    }>): Promise<SealResult> {
        const { writerMode } = input;
        const census = admitManagedMachinePresetAuthorCensusV1(writerMode, await requestRecipientCensus(input.censusInput, input.signal));
        if (census.kind === 'refused') return { kind: 'failed', code: census.code };
        const { controllerDisplayName: suppliedLabel, ...privateContent } = input.privateContent;
        let controllerDisplayName: string | null | undefined = suppliedLabel;
        if (writerMode === 'plain' && input.censusInput.owner.kind === 'team' && input.teamAcquireDelegated === true) {
            const controller = input.censusInput.controller;
            if (controller) {
                const machine = resolveServerScopedMachine(storage.getState(), scope.serverId, controller.machineId);
                if (machine?.installationId === controller.installationId) controllerDisplayName = readMachineName(machine);
            }
        }
        const content = { ...privateContent, ...(controllerDisplayName == null ? {} : { controllerDisplayName }) };
        try {
            if (input.current?.contentEncryptionMode === writerMode) {
                if (writerMode === 'plain') {
                    const envelope = replaceManagedMachinePresetAuthorContentV1({
                        presetId: input.presetId, mode: 'plain', projection: input.current.recipientProjection, content,
                    });
                    return envelope ? { kind: 'sealed', contentEncryptionMode: writerMode,
                        content: envelope.content, recipients: [...envelope.recipients] }
                        : { kind: 'failed', code: 'content_unavailable' };
                }
                const reader = await resolveReaderKey(scope, input.signal);
                if (!reader) return { kind: 'failed', code: 'content_unavailable' };
                try {
                    const envelope = reader.withAccountKey(({ accountId, accountKey }) =>
                        replaceManagedMachinePresetAuthorContentV1({
                            presetId: input.presetId, mode: 'e2ee', projection: input.current!.recipientProjection,
                            content, accountId, accountKey, recipientCensus: [...census.recipients],
                            randomBytes: getRandomBytes,
                        }));
                    return envelope ? { kind: 'sealed', contentEncryptionMode: writerMode,
                        content: envelope.content, recipients: [...envelope.recipients] }
                        : { kind: 'failed', code: 'content_unavailable' };
                } finally { reader.dispose(); }
            }
            const envelope = writerMode === 'plain'
                ? sealManagedMachinePresetContentV1({ presetId: input.presetId, mode: 'plain', content })
                : sealManagedMachinePresetContentV1({ presetId: input.presetId, mode: 'e2ee', content,
                    recipientCensus: [...census.recipients], randomBytes: getRandomBytes });
            return { kind: 'sealed', contentEncryptionMode: writerMode,
                content: envelope.content, recipients: [...envelope.recipients] };
        } catch (error) {
            if (error instanceof core.$ZodError) return { kind: 'failed', code: 'invalid_parameters',
                diagnosticDetail: JSON.stringify(actionInputValidationFailure(error), null, 2) };
            return { kind: 'failed', code: 'content_unavailable' };
        }
    }

    async function repairRecipientEnvelopes(raw: ManagedMachinePresetV1,
        reader: () => Promise<ManagedMachinePresetReadCustodyV1 | null>, signal?: AbortSignal): Promise<ManagedMachinePresetV1 | null> {
        if (raw.contentEncryptionMode !== 'e2ee') return null;
        const key = await (await reader())?.open('e2ee');
        if (key?.mode !== 'e2ee') return null;
        const census = await requestRecipientCensus({ homeId: raw.homeId, presetId: raw.id, owner: raw.owner,
            ...(raw.controller ? { controller: raw.controller } : {}),
            ...(raw.controllerPoolId ? { controllerPoolId: raw.controllerPoolId } : {}) }, signal);
        if (!census || census.kind !== 'ready' || census.contentEncryptionMode !== raw.contentEncryptionMode) return null;
        const rawRecipientIds = new Set(raw.recipients.map(recipient => recipient.accountId));
        const censusRecipientIds = new Set(census.recipients.map(recipient => recipient.account.accountId));
        const audienceIsPreparedAndCurrent = rawRecipientIds.size === raw.recipients.length
            && censusRecipientIds.size === census.recipients.length
            && rawRecipientIds.size === censusRecipientIds.size
            && census.recipients.every(recipient => recipient.envelopeStatus === 'prepared'
                && rawRecipientIds.has(recipient.account.accountId));
        if (audienceIsPreparedAndCurrent) return null;
        const recipients = key.withAccountKey(({ accountId, accountKey }) => rewrapManagedMachinePresetRecipientsV1({
            recipients: raw.recipients, accountId, accountKey, recipientCensus: [...census.recipients], randomBytes: getRandomBytes,
        }));
        if (!recipients || sameRecipientEnvelopes(raw.recipients, recipients)) return null;
        const input = MachinePresetActionInputSchemasV1['machines.presets.update'].safeParse({
            homeId: raw.homeId, id: raw.id, expectedRevision: raw.revision, patch: { recipients },
        });
        if (!input.success) return null;
        try {
            const outcome = classifyHomeActionOutcome(await executeAction('machines.presets.update', input.data, context(signal)),
                'machines.presets.update');
            if (outcome.kind !== 'completed') return null;
            const result = MachinePresetActionOutputSchemasV1['machines.presets.update'].safeParse(outcome.result);
            return result.success && result.data.kind === 'saved' ? result.data.preset : null;
        } catch {
            // A later keyholder read retries through the same owner.
            return null;
        }
    }

    async function openStoredPreset(raw: ManagedMachinePresetV1,
        reader: () => Promise<ManagedMachinePresetReadCustodyV1 | null>): Promise<Readonly<{
        content: ManagedMachinePresetContentV1;
        recipientProjection: ManagedMachinePresetRecipientProjectionV1;
    }> | null> {
        const custody = await (await reader())?.open(raw.contentEncryptionMode);
        if (!custody) return null;
        if (raw.contentEncryptionMode === 'plain') {
            const projection = ManagedMachinePresetRecipientProjectionV1Schema.safeParse({ content: raw.content, recipientEnvelope: null });
            const content = projection.success ? openManagedMachinePresetRecipientProjectionAtCustodyV1({ presetId: raw.id,
                mode: 'plain', projection: projection.data, custody }) : null;
            return content && projection.success ? { content, recipientProjection: projection.data } : null;
        }
        const projection = projectManagedMachinePresetForRecipientV1({ content: raw.content, recipients: raw.recipients,
            recipientAccountId: custody.accountId });
        const content = openManagedMachinePresetRecipientProjectionAtCustodyV1({ presetId: raw.id,
            mode: 'e2ee', projection, custody });
        return content ? { content, recipientProjection: projection } : null;
    }

    async function openPreset(raw: ManagedMachinePresetV1,
        reader: () => Promise<ManagedMachinePresetReadCustodyV1 | null>): Promise<OpenedMachinePreset | null> {
        const initiallyOpened = await openStoredPreset(raw, reader);
        if (!initiallyOpened) return null;
        // A current keyholder repairs newly owed Account envelopes on this normal read boundary. It cannot
        // expose content to a non-keyholder, and the server rechecks the live census/CAS before accepting it.
        const repaired = await repairRecipientEnvelopes(raw, reader);
        const selected = repaired ?? raw;
        const opened = selected === raw ? initiallyOpened : await openStoredPreset(selected, reader);
        if (!opened) return null;
        const { content: _stored, recipients: _recipients, ...structural } = selected;
        return { ...structural, ...opened.content, recipientProjection: opened.recipientProjection };
    }

    /**
     * Seal a requested launch name under the exact projection already opened for
     * this revision. The action caller receives only the opaque same-DEK carrier.
     */
    async function prepareLaunchNameOverride(preset: OpenedMachinePreset, launchName: string,
        signal?: AbortSignal): Promise<MachinePresetLaunchNameOverrideResult> {
        const normalizedName = launchName.trim();
        if (!preset.launch || !normalizedName) return { kind: 'failed', code: 'content_unavailable' };
        if (preset.launch.name === normalizedName) return { kind: 'unchanged' };
        if (preset.contentEncryptionMode === 'plain') {
            const override = createManagedMachinePresetLaunchNameOverrideV1({ presetId: preset.id, mode: 'plain',
                projection: preset.recipientProjection, launchName: normalizedName });
            return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
        }
        const reader = await resolveReaderKey(scope, signal);
        if (!reader) return { kind: 'failed', code: 'content_unavailable' };
        try {
            const override = reader.withAccountKey(({ accountId, accountKey }) => createManagedMachinePresetLaunchNameOverrideV1({
                presetId: preset.id, mode: 'e2ee', projection: preset.recipientProjection, accountId, accountKey,
                launchName: normalizedName, randomBytes: getRandomBytes,
            }));
            return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
        } finally { reader.dispose(); }
    }

    /**
     * Binds the selected Preset revision's private acquire choices into one
     * same-DEK carrier. The caller can persist/pass the opaque carrier, but
     * never receives an audience or a second content writer.
     */
    async function prepareAcquireOverride(preset: OpenedMachinePreset, input: Readonly<{
        enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
        launchName?: string;
    }>, signal?: AbortSignal): Promise<MachinePresetAcquireOverrideResult> {
        const requestedName = input.launchName?.trim();
        // Reviewed callers already bind an enrollment identity, so their unchanged
        // launch name need not become an override. A fresh author Preset has no
        // daemon-captured identity; its selected name is the required private
        // acquire choice and must remain in the same-DEK carrier.
        const launchName = preset.launch && requestedName
            && (input.enrollmentIdentity === undefined || requestedName !== preset.launch.name)
            ? requestedName
            : undefined;
        if (!launchName && !input.enrollmentIdentity) return { kind: 'failed', code: 'content_unavailable' };
        if (preset.contentEncryptionMode === 'plain') {
            const override = createManagedMachinePresetAcquireOverrideV1({ presetId: preset.id, mode: 'plain',
                projection: preset.recipientProjection, ...(launchName ? { launchName } : {}),
                ...(input.enrollmentIdentity ? { enrollmentIdentity: input.enrollmentIdentity } : {}) });
            return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
        }
        const reader = await resolveReaderKey(scope, signal);
        if (!reader) return { kind: 'failed', code: 'content_unavailable' };
        try {
            const override = reader.withAccountKey(({ accountId, accountKey }) => createManagedMachinePresetAcquireOverrideV1({
                presetId: preset.id, mode: 'e2ee', projection: preset.recipientProjection, accountId, accountKey,
                ...(launchName ? { launchName } : {}),
                ...(input.enrollmentIdentity ? { enrollmentIdentity: input.enrollmentIdentity } : {}), randomBytes: getRandomBytes,
            }));
            return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
        } finally { reader.dispose(); }
    }

    /**
     * Seals an edited setup under the exact opened revision. The caller receives only the carrier permitted on the
     * Action wire; the local opened copy never becomes a Home operand.
     */
    async function prepareSetupOverride(preset: Pick<OpenedMachinePreset, 'id' | 'setup' | 'contentEncryptionMode' | 'recipientProjection'>, setup: MachineSetupV1,
        signal?: AbortSignal): Promise<MachinePresetSetupOverrideResult> {
        if (!preset.setup || sameStrictJsonValue(preset.setup, setup)) return { kind: 'unchanged' };
        if (preset.contentEncryptionMode === 'plain') {
            const override = createManagedMachinePresetSetupOverrideV1({ presetId: preset.id, mode: 'plain',
                projection: preset.recipientProjection, setup });
            return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
        }
        const reader = await resolveReaderKey(scope, signal);
        if (!reader) return { kind: 'failed', code: 'content_unavailable' };
        try {
            const override = reader.withAccountKey(({ accountId, accountKey }) => createManagedMachinePresetSetupOverrideV1({
                presetId: preset.id, mode: 'e2ee', projection: preset.recipientProjection, accountId, accountKey,
                setup, randomBytes: getRandomBytes,
            }));
            return override ? { kind: 'ready', override } : { kind: 'failed', code: 'content_unavailable' };
        } finally { reader.dispose(); }
    }

    /**
     * Seals a private resize request from the exact selected revision. Home sees
     * only the existing opaque override carrier, never the requested size.
     */
    async function prepareResizeOverride(preset: OpenedMachinePreset, size: MachineProvisionerSizeV1,
        signal?: AbortSignal): Promise<MachinePresetResizeOverrideResult> {
        return await prepareManagedMachinePresetResizeOverrideFromProjection(scope, {
            presetId: preset.id, contentEncryptionMode: preset.contentEncryptionMode,
            recipientProjection: preset.recipientProjection, resize: preset.resize,
        }, size, signal);
    }

    async function openActionOutput<T extends MachinePresetHttpActionIdV1>(actionId: T, value: MachinePresetActionOutputV1<T>,
        signal?: AbortSignal): Promise<OpenedPresetActionOutput<T> | null> {
        const readerState: { key: Promise<ManagedMachinePresetReadCustodyV1 | null> | null } = { key: null };
        const reader = () => readerState.key ??= captureManagedMachinePresetReadCustodyV1(scope, signal);
        try {
            if (actionId === 'machines.presets.get' && value.kind === 'found') {
                const preset = await openPreset(value.preset, reader);
                return preset ? { ...value, preset } as OpenedPresetActionOutput<T> : null;
            }
            if (actionId === 'machines.presets.list' && value.kind === 'listed') {
                const presets = await Promise.all(value.presets.map(async raw => {
                    const preset = await openPreset(raw, reader);
                    if (preset) return preset;
                    const { content: _content, recipients: _recipients, ...structural } = raw;
                    return { ...structural, kind: 'private_content_unavailable' as const };
                }));
                return { ...value, presets } as OpenedPresetActionOutput<T>;
            }
            if ((actionId === 'machines.presets.create' || actionId === 'machines.presets.update'
                || actionId === 'machines.presets.archive' || actionId === 'machines.presets.restore') && value.kind === 'saved') {
                const preset = await openPreset(value.preset, reader);
                return preset ? { ...value, preset } as OpenedPresetActionOutput<T> : null;
            }
            return value as OpenedPresetActionOutput<T>;
        } finally {
            const key = await readerState.key;
            await key?.dispose();
        }
    }

    async function normalizedInput<T extends MachinePresetHttpActionIdV1>(actionId: T, input: MachinePresetClientInput<T>,
        options?: MachinePresetCollectionOptions<OpenedPresetActionOutput<T>>): Promise<MachinePresetActionInputV1<T> | SealResult> {
        if (actionId === 'machines.presets.create') {
            const draft = input as MachinePresetCreateDraftInput;
            const writerMode = await resolveWriterMode(scope, options?.signal);
            if (!writerMode) return { kind: 'failed', code: 'content_unavailable' };
            const censusInput = { homeId: draft.homeId, owner: draft.owner,
                ...(draft.controller ? { controller: draft.controller } : {}),
                ...(draft.controllerPoolId ? { controllerPoolId: draft.controllerPoolId } : {}) };
            const sealed = await sealPrivateContent({ presetId: draft.id, writerMode, privateContent: draft.privateContent, censusInput,
                teamAcquireDelegated: draft.teamAcquireDelegated, signal: options?.signal });
            if (sealed.kind === 'failed') return sealed;
            const { privateContent: _privateContent, ...structural } = draft;
            return { ...structural, contentEncryptionMode: sealed.contentEncryptionMode,
                content: sealed.content, recipients: sealed.recipients } as MachinePresetActionInputV1<T>;
        }
        if (actionId === 'machines.presets.update') {
            const draft = input as MachinePresetUpdateDraftInput;
            const { privateContent: editedContent, ...structuralPatch } = draft.patch;
            const current = options?.preset;
            if (editedContent === undefined && current?.contentEncryptionMode !== 'plain') {
                return { ...draft, patch: structuralPatch } as MachinePresetActionInputV1<T>;
            }
            const writerMode = await resolveWriterMode(scope, options?.signal);
            if (!writerMode) return { kind: 'failed', code: 'content_unavailable' };
            if (editedContent === undefined && writerMode === 'plain') {
                return { ...draft, patch: structuralPatch } as MachinePresetActionInputV1<T>;
            }
            if (!current?.owner) return { kind: 'failed', code: 'content_unavailable' };
            // Legacy rows read as Plain; their next save must seal for the saving Account's mode.
            let privateContent = editedContent;
            if (privateContent === undefined) {
                const retainedContent = current.recipientProjection?.content;
                const parsed = ManagedMachinePresetContentV1Schema.safeParse(retainedContent?.t === 'plain' ? retainedContent.v : undefined);
                if (!parsed.success) return { kind: 'failed', code: 'content_unavailable' };
                privateContent = parsed.data;
            }
            const controller = Object.hasOwn(structuralPatch, 'controller') ? structuralPatch.controller ?? undefined : current.controller;
            const controllerPoolId = Object.hasOwn(structuralPatch, 'controllerPoolId') ? structuralPatch.controllerPoolId ?? undefined : current.controllerPoolId;
            const censusInput = { homeId: draft.homeId, owner: current.owner,
                ...(controller ? { controller } : {}), ...(controllerPoolId ? { controllerPoolId } : {}) };
            const sealed = await sealPrivateContent({ presetId: draft.id, writerMode, privateContent, censusInput,
                ...(current.contentEncryptionMode && current.recipientProjection ? { current: {
                    contentEncryptionMode: current.contentEncryptionMode, recipientProjection: current.recipientProjection,
                } } : {}),
                teamAcquireDelegated: structuralPatch.teamAcquireDelegated ?? current.teamAcquireDelegated, signal: options?.signal });
            if (sealed.kind === 'failed') return sealed;
            return { ...draft, patch: { ...structuralPatch, contentEncryptionMode: sealed.contentEncryptionMode,
                content: sealed.content, recipients: sealed.recipients } } as MachinePresetActionInputV1<T>;
        }
        return input as MachinePresetActionInputV1<T>;
    }

    async function execute<T extends MachinePresetHttpActionIdV1>(actionId: T, input: MachinePresetClientInput<T>,
        options?: MachinePresetCollectionOptions<OpenedPresetActionOutput<T>>): Promise<MachinePresetCollectionResult<OpenedPresetActionOutput<T>>> {
        const normalized = await normalizedInput(actionId, input, options);
        if ('kind' in normalized && normalized.kind === 'failed') return normalized;
        const parsed = MachinePresetActionInputSchemasV1[actionId].safeParse(normalized);
        if (!parsed.success) return { kind: 'failed', code: 'invalid_parameters',
            diagnosticDetail: JSON.stringify(actionInputValidationFailure(parsed.error), null, 2) };
        if (parsed.data.homeId !== homeId) return { kind: 'failed', code: 'invalid_parameters' };
        const map = async (value: MachinePresetActionOutputV1<T>) => await openActionOutput(actionId, value, options?.signal);
        const outcome = observeHomeActionOutcome<MachinePresetActionOutputV1<T>, T>({
            result: await executeAction(actionId, parsed.data, context(options?.signal)),
            actionId, actionInput: parsed.data, scope, signal: options?.signal,
            onSucceeded: async value => {
                const opened = await map(value);
                if (!opened) { options?.onApprovalFailed?.('content_unavailable'); return; }
                await options?.onApprovalSucceeded?.(opened);
            },
            onFailed: (code, failure) => {
                const raw = readPresetDomainFailureResult(actionId, code, failure?.details);
                if (!raw) { options?.onApprovalFailed?.(code); return; }
                void map(raw).then(opened => opened ? options?.onApprovalSucceeded?.(opened)
                    : options?.onApprovalFailed?.('content_unavailable')).catch(() => options?.onApprovalFailed?.('content_unavailable'));
            },
        });
        if (outcome.kind === 'failed') {
            const code = homeDomainFailureCode(outcome.failure);
            const raw = readPresetDomainFailureResult(actionId, code, outcome.failure.details);
            if (!raw) return { kind: 'failed', code };
            const opened = await map(raw);
            return opened ? { kind: 'succeeded', value: opened } : { kind: 'failed', code: 'content_unavailable' };
        }
        if (outcome.kind === 'approval_pending') {
            options?.onApprovalPending?.(outcome.approval);
            return outcome;
        }
        const output = MachinePresetActionOutputSchemasV1[actionId].safeParse(outcome.result);
        if (!output.success) return { kind: 'failed', code: 'invalid_action_output' };
        const opened = await map(output.data as MachinePresetActionOutputV1<T>);
        return opened ? { kind: 'succeeded', value: opened } : { kind: 'failed', code: 'content_unavailable' };
    }

    function read<T extends 'machines.presets.get' | 'machines.presets.list'>(actionId: T, input: MachinePresetClientInput<T>,
        options?: MachinePresetCollectionOptions<OpenedPresetActionOutput<T>>) {
        let awaitingApproval = false;
        return awaitActionApprovalResult<OpenedPresetActionOutput<T>, MachinePresetCollectionSettledResult<OpenedPresetActionOutput<T>>>({
            execute: async callbacks => {
                const result = await execute(actionId, input, { ...options, ...callbacks, onApprovalPending: approval => {
                    awaitingApproval = true;
                    options?.onApprovalPending?.(approval);
                } });
                return result.kind === 'approval_pending' ? { approvalPending: true } : result;
            },
            succeeded: value => ({ kind: 'succeeded', value }), failed: code => ({ kind: 'failed', code }),
            aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
        }).finally(() => { if (awaitingApproval) options?.onApprovalSettled?.(); });
    }

    async function list(options?: MachinePresetCollectionOptions<readonly ManagedMachinePresetListEntryV1[]> & MachinePresetCollectionFilter): Promise<MachinePresetCollectionSettledResult<readonly ManagedMachinePresetListEntryV1[]>> {
        const presets: ManagedMachinePresetListEntryV1[] = [];
        let cursor: string | undefined;
        do {
            const result = await read('machines.presets.list', { homeId, includeArchived: true,
                ...(options?.sharedWithTeamId === undefined ? {} : { sharedWithTeamId: options.sharedWithTeamId }),
                ...(cursor ? { cursor } : {}) }, {
                signal: options?.signal, onApprovalPending: options?.onApprovalPending, onApprovalSettled: options?.onApprovalSettled,
            });
            if (result.kind === 'failed') return result;
            if (result.value.kind === 'refused') return { kind: 'failed', code: result.value.code };
            if (result.value.kind !== 'listed') return { kind: 'failed', code: 'invalid_action_output' };
            for (const preset of result.value.presets) {
                if (!isOpenedManagedMachinePresetV1(preset)
                    || !options?.search || preset.name.toLocaleLowerCase().includes(options.search.toLocaleLowerCase())) presets.push(preset);
            }
            cursor = result.value.cursor;
        } while (cursor);
        return { kind: 'succeeded', value: presets };
    }

    async function detail(id: string, options?: MachinePresetCollectionOptions<MachinePresetHistoryData>): Promise<MachinePresetCollectionSettledResult<MachinePresetHistoryData>> {
        const result = await read('machines.presets.get', { homeId, id }, { signal: options?.signal,
            onApprovalPending: options?.onApprovalPending, onApprovalSettled: options?.onApprovalSettled });
        if (result.kind === 'failed') return result;
        if (result.value.kind === 'refused') return { kind: 'failed', code: result.value.code };
        const preset = result.value.preset;
        const results = await Promise.all([false, true].map(async archived => {
            const input = { homeId, presetId: id, ...(archived ? { archived: true } : {}) };
            let awaitingApproval = false;
            return awaitActionApprovalResult<ManagedMachineReadSnapshotV1[], MachinePresetCollectionSettledResult<ManagedMachineReadSnapshotV1[]>>({
                execute: async callbacks => {
                    const openRows = (value: unknown) => {
                        const output = ManagedListOutputV1Schema.safeParse(value);
                        return output.success ? openManagedMachineReadSnapshots(scope, output.data.machines, options?.signal) : null;
                    };
                    const outcome = observeHomeActionOutcome<{ machines: ManagedMachineReadV1[] }, 'machines.managed.list'>({
                        result: await executeAction('machines.managed.list', input, context(options?.signal)),
                        actionId: 'machines.managed.list', actionInput: input, scope, signal: options?.signal,
                        onSucceeded: async value => {
                            const machines = openRows(value);
                            if (!machines) { callbacks.onApprovalFailed('invalid_action_output'); return; }
                            callbacks.onApprovalSucceeded(await machines);
                        }, onFailed: callbacks.onApprovalFailed,
                    });
                    if (outcome.kind === 'failed') return { kind: 'failed', code: homeDomainFailureCode(outcome.failure) };
                    if (outcome.kind === 'approval_pending') {
                        awaitingApproval = true;
                        options?.onApprovalPending?.(outcome.approval);
                        return { approvalPending: true };
                    }
                    const machines = openRows(outcome.result);
                    return machines ? { kind: 'succeeded', value: await machines }
                        : { kind: 'failed', code: 'invalid_action_output' };
                },
                succeeded: value => ({ kind: 'succeeded', value }), failed: code => ({ kind: 'failed', code }),
                aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
            }).finally(() => { if (awaitingApproval) options?.onApprovalSettled?.(); });
        }));
        const failed = results.find(item => item.kind === 'failed');
        if (failed?.kind === 'failed') return failed;
        const rows = results.flatMap(item => item.kind === 'succeeded' ? item.value : []);
        if (rows.some(machine => machine.homeId !== homeId || machine.preset?.id !== id)) return { kind: 'failed', code: 'invalid_action_output' };
        return { kind: 'succeeded', value: { preset, machines: [...new Map(rows.map(machine => [machine.id, machine])).values()] } };
    }

    function saveDraft(input: MachinePresetDraftSaveInput,
        options?: MachinePresetCollectionOptions<OpenedPresetActionOutput<'machines.presets.update'>>) {
        return 'preset' in input ? execute('machines.presets.update', {
            homeId, id: input.preset.id, expectedRevision: input.preset.revision,
            patch: machinePresetEditDraftUpdatePatch(input.draft),
        }, { ...options, preset: input.preset }) : execute('machines.presets.create', {
            homeId, id: input.id, owner: input.owner, ...machinePresetEditDraftContent(input.draft),
        }, options as MachinePresetCollectionOptions<OpenedPresetActionOutput<'machines.presets.create'>> | undefined);
    }

    function capture(input: MachinePresetCaptureInput, sources: MachineSetupSourceV1,
        options?: MachinePresetCollectionOptions<OpenedPresetActionOutput<'machines.presets.create'>>) {
        const merged = mergeMachineSetupsV1(sources.map(source => source.setup));
        const { name, launch, controllerDisplayName, ...structural } = input;
        return merged.ok ? execute('machines.presets.create', {
            ...structural,
            privateContent: { v: 1, name, ...(launch ? { launch } : {}),
                setup: merged.setup, ...(controllerDisplayName ? { controllerDisplayName } : {}) },
        }, options) : Promise.resolve<MachinePresetCollectionResult<OpenedPresetActionOutput<'machines.presets.create'>>>(
            { kind: 'failed', code: merged.errorCode });
    }

    return Object.freeze({ execute, read, list, detail, capture, saveDraft,
        prepareLaunchNameOverride, prepareAcquireOverride, prepareSetupOverride, prepareResizeOverride });
}
