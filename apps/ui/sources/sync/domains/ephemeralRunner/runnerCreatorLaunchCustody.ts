import {
    RunnerPreparedAuthoringV1Schema,
    type RunnerPreparedAuthoringV1,
    RunnerReviewedFileV1Schema,
    type RunnerReviewedFileV1,
} from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import {
    RunnerActivationBindingV1Schema,
} from '@happier-dev/protocol/ephemeralRunner/activation';
import {
    computeRunnerLaunchManifestCommitmentV1,
    RunnerLaunchManifestV1Schema,
} from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import { RunnerActivationReviewV1Schema } from '@happier-dev/protocol/ephemeralRunner/review';
import { readDeviceLocalStorageString, removeDeviceLocalStorageString, writeDeviceLocalStorageString } from '@/auth/storage/deviceLocalStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { digest } from '@/platform/digest';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { RunnerReviewCustodyV1 } from './runnerMaterialization';
import { assertRunnerMaterializationCurrentnessV1 } from './runnerMaterialization';
import {
    RunnerMaterializationRequestV1Schema,
    type RunnerMaterializationRequestV1,
} from '@happier-dev/protocol/ephemeralRunner/materialization';
import { RunnerActivationCreateRequestV1Schema } from '@happier-dev/protocol/ephemeralRunner/activation';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { SessionDraftAddressV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import {
    TeamCredentialProviderModelSelectionV1Schema,
    type TeamCredentialProviderModelSelectionV1,
} from '@happier-dev/protocol/teams';
import { RunnerActivationProjectionV1Schema, runnerActivationProjectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { isRunnerArtifactAcquisitionCustodyHandle } from './package/runnerArtifactAcquisitionSink';
import {
    removeStagedRunnerAttachmentCustody,
    reopenStagedRunnerAttachment,
    type StagedRunnerAttachmentCustodyFile,
} from './stageRunnerAttachments';

/**
 * One verified ordinary-upload result for an exact reviewed file. Retained
 * inside the incumbent activation custody so a partial multi-file failure is
 * resumed against the path the Session already has, instead of uploading the
 * same bytes again under a second randomized remote path.
 */
type StoredRunnerAttachmentUploadCheckpointV1 = Readonly<{
    id: string;
    name: string;
    mimeType: string | null;
    path: string;
    sizeBytes: number;
    sha256: string;
}>;

export type RunnerCreatorAttachmentUploadCheckpoint = Readonly<{
    id: string;
    name: string;
    mimeType?: string;
    path: string;
    sizeBytes: number;
    sha256: string;
}>;

export type StoredAttachmentUploadCustodyV1 = Readonly<{
    attachmentMessageLocalId: string;
    firstTurnLocalId: string;
    maxFileBytes: number;
    files: readonly StagedRunnerAttachmentCustodyFile[];
    verifiedUploads?: readonly StoredRunnerAttachmentUploadCheckpointV1[];
}>;

type StoredAttachmentStagingCustodyFileV1 = Readonly<{
    reviewedFile?: RunnerReviewedFileV1;
    custodyFile: StagedRunnerAttachmentCustodyFile;
}>;

type StoredAttachmentStagingCustodyV1 = Readonly<{
    attachmentMessageLocalId: string;
    firstTurnLocalId: string;
    maxFileBytes: number;
    files: readonly StoredAttachmentStagingCustodyFileV1[];
}>;

type StoredCreatorLaunchCustodyV1 = Readonly<{
    v: 1;
    preparedAuthoring?: RunnerPreparedAuthoringV1;
    /**
     * The exact Team model the creator submitted with this package. Review
     * binds this frozen choice (revalidated against the current catalog), never
     * whatever the composer shows later.
     */
    submittedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    attachmentStaging?: StoredAttachmentStagingCustodyV1;
    attachmentUpload?: StoredAttachmentUploadCustodyV1;
    binding?: RunnerReviewCustodyV1['binding'];
    reviewed?: Readonly<{
        binding: RunnerReviewCustodyV1['binding'];
        launchManifest: RunnerReviewCustodyV1['launchManifest'];
        review: RunnerReviewCustodyV1['review'];
        machineContentKeyBase64Url: string | null;
    }>;
    materializationRequest?: RunnerMaterializationRequestV1;
}>;

export type RunnerCreatorAttachmentUploadCustody = Readonly<{
    attachmentMessageLocalId: string;
    firstTurnLocalId: string;
    maxFileBytes: number;
    stagedFiles: readonly Readonly<{ id: string; source: AttachmentsUploadFileSource }>[];
    resumedUploads?: readonly RunnerCreatorAttachmentUploadCheckpoint[];
}>;

const materializationRequestWrites = new Map<string, Promise<RunnerMaterializationRequestV1>>();
const custodyMutations = new Map<string, Promise<void>>();

async function runCustodyMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = custodyMutations.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    custodyMutations.set(key, tail);
    try {
        return await result;
    } finally {
        if (custodyMutations.get(key) === tail) custodyMutations.delete(key);
    }
}

async function awaitCustodyMutation(key: string): Promise<void> {
    await custodyMutations.get(key);
}

export class RunnerCreatorLaunchCustodyUnavailableError extends Error {
    readonly code = 'runner_creator_launch_custody_unavailable' as const;
    constructor() {
        super('Runner creator launch custody is unavailable');
        this.name = 'RunnerCreatorLaunchCustodyUnavailableError';
    }
}

async function storageKey(scope: ServerAccountScope, activationId: string): Promise<string> {
    const scopeHash = await digest('SHA-256', new TextEncoder().encode(serverAccountScopeKeySuffix(scope)));
    return `happier-runner-creator-launch-v1.${encodeBase64(scopeHash, 'base64url')}.${activationId}`;
}

async function scopeIndexStorageKey(scope: ServerAccountScope): Promise<string> {
    const scopeHash = await digest('SHA-256', new TextEncoder().encode(serverAccountScopeKeySuffix(scope)));
    return `happier-runner-creator-scope-v1.${encodeBase64(scopeHash, 'base64url')}`;
}

type RunnerCreatorCustodyScopeEntry = Readonly<{
    activationId: string;
    draftId?: string;
}>;

function parseScopeCustodyEntries(raw: string | null): readonly RunnerCreatorCustodyScopeEntry[] {
    if (raw === null) return [];
    try {
        const value = JSON.parse(raw) as unknown;
        if (!Array.isArray(value)) throw new Error('invalid runner custody index');
        const entries = value.map((entry): RunnerCreatorCustodyScopeEntry => {
            if (typeof entry === 'string') {
                return { activationId: RunnerActivationCreateRequestV1Schema.shape.activationId.parse(entry) };
            }
            if (!entry || typeof entry !== 'object') throw new Error('invalid runner custody index entry');
            const candidate = entry as Record<string, unknown>;
            if (Object.keys(candidate).some((key) => key !== 'activationId' && key !== 'draftId')) {
                throw new Error('invalid runner custody index entry');
            }
            const activationId = RunnerActivationCreateRequestV1Schema.shape.activationId.parse(candidate.activationId);
            const draft = SessionDraftAddressV1Schema.parse({ kind: 'newSession', draftId: candidate.draftId });
            if (draft.kind !== 'newSession') throw new Error('invalid runner custody draft');
            return { activationId, draftId: draft.draftId };
        });
        if (new Set(entries.map((entry) => entry.activationId)).size !== entries.length) {
            throw new Error('duplicate runner custody index entry');
        }
        return entries;
    } catch {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
}

async function writeScopeCustodyEntries(scope: ServerAccountScope, entries: readonly RunnerCreatorCustodyScopeEntry[]): Promise<void> {
    const key = await scopeIndexStorageKey(scope);
    const encoded = JSON.stringify(entries.map((entry) => entry.draftId === undefined
        ? entry.activationId
        : { activationId: entry.activationId, draftId: entry.draftId }));
    if (entries.length === 0) {
        await removeDeviceLocalStorageString(key);
        return;
    }
    await writeDeviceLocalStorageString(key, encoded);
    if (await readDeviceLocalStorageString(key) !== encoded) {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
}

/**
 * The native protected-storage boundary cannot enumerate keys. This narrow
 * scope-qualified locator is part of the existing creator-custody owner and
 * contains only public activation IDs, allowing acknowledged Account erasure
 * to find every exact key/launch record without another lifecycle authority.
 */
export async function registerRunnerCreatorCustodyActivation(
    scope: ServerAccountScope,
    activationId: string,
    draftId?: string,
): Promise<void> {
    RunnerActivationCreateRequestV1Schema.shape.activationId.parse(activationId);
    const parsedDraftId = draftId === undefined
        ? undefined
        : (() => {
            const draft = SessionDraftAddressV1Schema.parse({ kind: 'newSession', draftId });
            if (draft.kind !== 'newSession') throw new RunnerCreatorLaunchCustodyUnavailableError();
            return draft.draftId;
        })();
    const key = await scopeIndexStorageKey(scope);
    await runCustodyMutation(key, async () => {
        const entries = parseScopeCustodyEntries(await readDeviceLocalStorageString(key));
        const existing = entries.find((entry) => entry.activationId === activationId);
        if (existing) {
            if (parsedDraftId === undefined || existing.draftId === parsedDraftId) return;
            if (existing.draftId !== undefined) throw new RunnerCreatorLaunchCustodyUnavailableError();
            await writeScopeCustodyEntries(scope, entries.map((entry) => entry.activationId === activationId
                ? { activationId, draftId: parsedDraftId }
                : entry));
            return;
        }
        await writeScopeCustodyEntries(scope, [...entries, {
            activationId,
            ...(parsedDraftId === undefined ? {} : { draftId: parsedDraftId }),
        }]);
    });
}

export async function listRunnerCreatorCustodyActivationIds(scope: ServerAccountScope): Promise<readonly string[]> {
    const key = await scopeIndexStorageKey(scope);
    await awaitCustodyMutation(key);
    return parseScopeCustodyEntries(await readDeviceLocalStorageString(key)).map((entry) => entry.activationId);
}

export async function listRunnerCreatorCustodyActivationIdsForDraft(
    scope: ServerAccountScope,
    draftId: string,
): Promise<readonly string[]> {
    const draft = SessionDraftAddressV1Schema.parse({ kind: 'newSession', draftId });
    if (draft.kind !== 'newSession') throw new RunnerCreatorLaunchCustodyUnavailableError();
    const key = await scopeIndexStorageKey(scope);
    await awaitCustodyMutation(key);
    return parseScopeCustodyEntries(await readDeviceLocalStorageString(key))
        .filter((entry) => entry.draftId === draft.draftId)
        .map((entry) => entry.activationId);
}

export async function forgetRunnerCreatorCustodyActivation(
    scope: ServerAccountScope,
    activationId: string,
): Promise<void> {
    const key = await scopeIndexStorageKey(scope);
    await runCustodyMutation(key, async () => {
        const entries = parseScopeCustodyEntries(await readDeviceLocalStorageString(key));
        if (!entries.some((entry) => entry.activationId === activationId)) return;
        await writeScopeCustodyEntries(scope, entries.filter((entry) => entry.activationId !== activationId));
    });
}

/**
 * A checkpoint is only ever reusable when it still matches the exact reviewed
 * file. Reviewed identity, not the stored copy, is authoritative here so a
 * rewritten record can never widen what the retry is allowed to reuse.
 */
function parseAttachmentUploadCheckpoints(
    value: unknown,
    preparedAuthoring: RunnerPreparedAuthoringV1,
): readonly StoredRunnerAttachmentUploadCheckpointV1[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error('invalid attachment checkpoint');
    const reviewedById = new Map(preparedAuthoring.files.map((file) => [file.id, file]));
    const checkpoints = value.map((rawCheckpoint) => {
        if (!rawCheckpoint || typeof rawCheckpoint !== 'object') throw new Error('invalid attachment checkpoint');
        const candidate = rawCheckpoint as Partial<StoredRunnerAttachmentUploadCheckpointV1>;
        const reviewed = typeof candidate.id === 'string' ? reviewedById.get(candidate.id) : undefined;
        if (!reviewed || typeof candidate.path !== 'string' || candidate.path.length === 0
            || candidate.name !== reviewed.name || (candidate.mimeType ?? null) !== reviewed.mimeType
            || candidate.sizeBytes !== reviewed.sizeBytes || candidate.sha256 !== reviewed.sha256) {
            throw new Error('attachment checkpoint mismatch');
        }
        reviewedById.delete(reviewed.id);
        return {
            id: reviewed.id,
            name: reviewed.name,
            mimeType: reviewed.mimeType,
            path: candidate.path,
            sizeBytes: reviewed.sizeBytes,
            sha256: reviewed.sha256,
        } satisfies StoredRunnerAttachmentUploadCheckpointV1;
    });
    return checkpoints.length > 0 ? checkpoints : undefined;
}

function parseAttachmentUploadCustody(
    value: unknown,
    preparedAuthoring: RunnerPreparedAuthoringV1,
): StoredAttachmentUploadCustodyV1 | undefined {
    if (value === undefined && preparedAuthoring.files.length === 0) return undefined;
    if (!value || typeof value !== 'object') throw new Error('invalid attachment custody');
    const candidate = value as Partial<StoredAttachmentUploadCustodyV1>;
    const maxFileBytes = candidate.maxFileBytes;
    if (typeof candidate.attachmentMessageLocalId !== 'string' || candidate.attachmentMessageLocalId.length === 0
        || typeof candidate.firstTurnLocalId !== 'string' || candidate.firstTurnLocalId.length === 0
        || typeof maxFileBytes !== 'number' || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0
        || !Array.isArray(candidate.files)) {
        throw new Error('invalid attachment custody');
    }
    const reviewedById = new Map(preparedAuthoring.files.map((file) => [file.id, file]));
    if (reviewedById.size !== preparedAuthoring.files.length || candidate.files.length !== preparedAuthoring.files.length) {
        throw new Error('attachment custody mismatch');
    }
    const files = candidate.files.map((rawFile) => {
        if (!rawFile || typeof rawFile !== 'object') throw new Error('invalid attachment custody');
        const file = rawFile as Partial<StagedRunnerAttachmentCustodyFile>;
        const reviewed = typeof file.id === 'string' ? reviewedById.get(file.id) : undefined;
        if (!reviewed || file.name !== reviewed.name
            || (file.mimeType ?? null) !== reviewed.mimeType || file.sizeBytes !== reviewed.sizeBytes
            || !isRunnerArtifactAcquisitionCustodyHandle(file.custody)) {
            throw new Error('attachment custody mismatch');
        }
        reviewedById.delete(reviewed.id);
        return {
            id: reviewed.id,
            name: reviewed.name,
            mimeType: reviewed.mimeType,
            sizeBytes: reviewed.sizeBytes,
            custody: file.custody,
        } satisfies StagedRunnerAttachmentCustodyFile;
    });
    if (reviewedById.size !== 0) throw new Error('attachment custody mismatch');
    const verifiedUploads = parseAttachmentUploadCheckpoints(candidate.verifiedUploads, preparedAuthoring);
    return {
        attachmentMessageLocalId: candidate.attachmentMessageLocalId,
        firstTurnLocalId: candidate.firstTurnLocalId,
        maxFileBytes,
        files,
        ...(verifiedUploads ? { verifiedUploads } : {}),
    };
}

function parseAttachmentStagingCustody(value: unknown): StoredAttachmentStagingCustodyV1 {
    if (!value || typeof value !== 'object') throw new Error('invalid attachment staging custody');
    const candidate = value as Partial<StoredAttachmentStagingCustodyV1>;
    const maxFileBytes = candidate.maxFileBytes;
    if (typeof candidate.attachmentMessageLocalId !== 'string' || candidate.attachmentMessageLocalId.length === 0
        || typeof candidate.firstTurnLocalId !== 'string' || candidate.firstTurnLocalId.length === 0
        || typeof maxFileBytes !== 'number' || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0
        || !Array.isArray(candidate.files)) {
        throw new Error('invalid attachment staging custody');
    }
    const ids = new Set<string>();
    const files = candidate.files.map((rawEntry) => {
        if (!rawEntry || typeof rawEntry !== 'object') throw new Error('invalid attachment staging custody');
        const entry = rawEntry as Partial<StoredAttachmentStagingCustodyFileV1>;
        const custodyFile = entry.custodyFile;
        if (!custodyFile || typeof custodyFile !== 'object'
            || !isRunnerArtifactAcquisitionCustodyHandle(custodyFile.custody)
            || typeof custodyFile.id !== 'string' || custodyFile.id.length === 0
            || typeof custodyFile.name !== 'string'
            || (custodyFile.mimeType !== null && typeof custodyFile.mimeType !== 'string')
            || !Number.isSafeInteger(custodyFile.sizeBytes) || custodyFile.sizeBytes < 0
            || ids.has(custodyFile.id)) {
            throw new Error('invalid attachment staging custody');
        }
        const reviewedFile = entry.reviewedFile === undefined
            ? undefined
            : RunnerReviewedFileV1Schema.parse(entry.reviewedFile);
        if (reviewedFile && (custodyFile.id !== reviewedFile.id
            || custodyFile.name !== reviewedFile.name
            || custodyFile.mimeType !== reviewedFile.mimeType
            || custodyFile.sizeBytes !== reviewedFile.sizeBytes)) {
            throw new Error('invalid attachment staging custody');
        }
        ids.add(custodyFile.id);
        return { ...(reviewedFile ? { reviewedFile } : {}), custodyFile } satisfies StoredAttachmentStagingCustodyFileV1;
    });
    return {
        attachmentMessageLocalId: candidate.attachmentMessageLocalId,
        firstTurnLocalId: candidate.firstTurnLocalId,
        maxFileBytes,
        files,
    };
}

function parseStored(raw: string | null): StoredCreatorLaunchCustodyV1 {
    try {
        const value = JSON.parse(raw ?? 'null') as Partial<StoredCreatorLaunchCustodyV1> | null;
        if (!value || value.v !== 1) throw new Error('invalid custody');
        if (value.preparedAuthoring === undefined) {
            if (value.binding !== undefined || value.reviewed !== undefined || value.materializationRequest !== undefined) {
                throw new Error('invalid pre-preparation custody');
            }
            return { v: 1, attachmentStaging: parseAttachmentStagingCustody(value.attachmentStaging) };
        }
        const preparedAuthoring = RunnerPreparedAuthoringV1Schema.parse(value.preparedAuthoring);
        if (value.attachmentStaging !== undefined) throw new Error('invalid prepared custody');
        const attachmentUpload = parseAttachmentUploadCustody(value.attachmentUpload, preparedAuthoring);
        const acceptedBinding = value.binding === undefined ? undefined : RunnerActivationBindingV1Schema.parse(value.binding);
        const submittedTeamCredentialModel = value.submittedTeamCredentialModel === undefined
            ? undefined
            : TeamCredentialProviderModelSelectionV1Schema.parse(value.submittedTeamCredentialModel);
        if (!value.reviewed) return { v: 1, preparedAuthoring, submittedTeamCredentialModel, binding: acceptedBinding, attachmentUpload };
        const binding = RunnerActivationBindingV1Schema.parse(value.reviewed.binding);
        const launchManifest = RunnerLaunchManifestV1Schema.parse(value.reviewed.launchManifest);
        const review = RunnerActivationReviewV1Schema.parse(value.reviewed.review);
        const encoded = value.reviewed.machineContentKeyBase64Url;
        if (encoded !== null && (typeof encoded !== 'string' || decodeBase64(encoded, 'base64url').length !== 32)) {
            throw new Error('invalid machine key');
        }
        if (!acceptedBinding || createCanonicalJsonSigningInput(acceptedBinding) !== createCanonicalJsonSigningInput(binding)
            || createCanonicalJsonSigningInput(binding) !== createCanonicalJsonSigningInput(launchManifest.binding)
            || review.launchManifestCommitment !== computeRunnerLaunchManifestCommitmentV1(launchManifest)
            || createCanonicalJsonSigningInput(review.machineContentKeyBinding) !== createCanonicalJsonSigningInput(launchManifest.machineContentKeyBinding)
            || createCanonicalJsonSigningInput(review.credentialSelectionBinding) !== createCanonicalJsonSigningInput(launchManifest.credentialSelectionBinding)
            || createCanonicalJsonSigningInput(review.displayFacts) !== createCanonicalJsonSigningInput(launchManifest.displayFacts)) throw new Error('binding mismatch');
        const materializationRequest = value.materializationRequest === undefined
            ? undefined
            : RunnerMaterializationRequestV1Schema.parse(value.materializationRequest);
        if (materializationRequest && materializationRequest.activationId !== binding.activationId) throw new Error('materialization binding mismatch');
        return { v: 1, preparedAuthoring, submittedTeamCredentialModel, binding: acceptedBinding, attachmentUpload, reviewed: { binding, launchManifest, review, machineContentKeyBase64Url: encoded }, materializationRequest };
    } catch {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
}

async function writeAndVerify(
    scope: ServerAccountScope,
    activationId: string,
    value: StoredCreatorLaunchCustodyV1,
    restoreRawOnFailure?: string | null,
): Promise<void> {
    const key = await storageKey(scope, activationId);
    const encoded = JSON.stringify(value);
    try {
        await writeDeviceLocalStorageString(key, encoded);
        const stored = await readDeviceLocalStorageString(key);
        if (stored !== encoded) throw new Error('custody write mismatch');
        parseStored(stored);
    } catch {
        if (restoreRawOnFailure === undefined || restoreRawOnFailure === null) {
            await removeDeviceLocalStorageString(key).catch(() => undefined);
        } else {
            await writeDeviceLocalStorageString(key, restoreRawOnFailure).catch(() => undefined);
        }
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
}

function requirePreparedAuthoring(stored: StoredCreatorLaunchCustodyV1): RunnerPreparedAuthoringV1 {
    if (!stored.preparedAuthoring) throw new RunnerCreatorLaunchCustodyUnavailableError();
    return stored.preparedAuthoring;
}

/** Establish the existing activation-scoped custody record before copying bytes. */
export async function beginRunnerCreatorAttachmentStagingCustody(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    attachmentMessageLocalId: string;
    firstTurnLocalId: string;
    maxFileBytes: number;
}>): Promise<void> {
    RunnerActivationCreateRequestV1Schema.shape.activationId.parse(input.activationId);
    const staging = parseAttachmentStagingCustody({
        attachmentMessageLocalId: input.attachmentMessageLocalId,
        firstTurnLocalId: input.firstTurnLocalId,
        maxFileBytes: input.maxFileBytes,
        files: [],
    });
    await registerRunnerCreatorCustodyActivation(input.scope, input.activationId);
    const key = await storageKey(input.scope, input.activationId);
    await runCustodyMutation(key, async () => {
        const raw = await readDeviceLocalStorageString(key);
        if (raw !== null) {
            const existing = parseStored(raw);
            if (existing.preparedAuthoring) return;
            const current = existing.attachmentStaging;
            if (!current
                || current.attachmentMessageLocalId !== staging.attachmentMessageLocalId
                || current.firstTurnLocalId !== staging.firstTurnLocalId
                || current.maxFileBytes !== staging.maxFileBytes) {
                throw new RunnerCreatorLaunchCustodyUnavailableError();
            }
            return;
        }
        await writeAndVerify(input.scope, input.activationId, { v: 1, attachmentStaging: staging });
    });
}

/** Persist the exact sink handle before its first durable byte is copied. */
export async function recordRunnerCreatorStagingCustodyHandle(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    custodyFile: StagedRunnerAttachmentCustodyFile;
}>): Promise<void> {
    const key = await storageKey(input.scope, input.activationId);
    await runCustodyMutation(key, async () => {
        const raw = await readDeviceLocalStorageString(key);
        const stored = parseStored(raw);
        const staging = stored.attachmentStaging;
        if (!staging || stored.preparedAuthoring) throw new RunnerCreatorLaunchCustodyUnavailableError();
        const entry = parseAttachmentStagingCustody({ ...staging, files: [{ custodyFile: input.custodyFile }] }).files[0]!;
        const existing = staging.files.find((candidate) => candidate.custodyFile.id === entry.custodyFile.id);
        if (existing) {
            if (createCanonicalJsonSigningInput(existing.custodyFile) !== createCanonicalJsonSigningInput(entry.custodyFile)) {
                throw new RunnerCreatorLaunchCustodyUnavailableError();
            }
            return;
        }
        await writeAndVerify(input.scope, input.activationId, {
            v: 1,
            attachmentStaging: { ...staging, files: [...staging.files, entry] },
        }, raw);
    });
}

/** Bind reviewed digest facts to the already-indexed exact sink handle. */
export async function recordRunnerCreatorStagedAttachmentCustody(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    reviewedFile: RunnerReviewedFileV1;
    custodyFile: StagedRunnerAttachmentCustodyFile;
}>): Promise<void> {
    const key = await storageKey(input.scope, input.activationId);
    await runCustodyMutation(key, async () => {
        const raw = await readDeviceLocalStorageString(key);
        const stored = parseStored(raw);
        const staging = stored.attachmentStaging;
        if (!staging || stored.preparedAuthoring) throw new RunnerCreatorLaunchCustodyUnavailableError();
        const existingIndex = staging.files.findIndex((candidate) => candidate.custodyFile.id === input.custodyFile.id);
        if (existingIndex < 0) throw new RunnerCreatorLaunchCustodyUnavailableError();
        const entry = parseAttachmentStagingCustody({
            ...staging,
            files: [{ reviewedFile: input.reviewedFile, custodyFile: input.custodyFile }],
        }).files[0]!;
        const existing = staging.files[existingIndex]!;
        if (existing.reviewedFile) {
            if (createCanonicalJsonSigningInput(existing) !== createCanonicalJsonSigningInput(entry)) {
                throw new RunnerCreatorLaunchCustodyUnavailableError();
            }
            return;
        }
        const files = staging.files.slice();
        files[existingIndex] = entry;
        await writeAndVerify(input.scope, input.activationId, {
            v: 1,
            attachmentStaging: { ...staging, files },
        }, raw);
    });
}

export async function writePreparedRunnerCreatorLaunchCustody(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    preparedAuthoring: RunnerPreparedAuthoringV1;
    /**
     * The Team model admitted at Send. Absent means none was frozen, and review
     * then fails closed as unselected rather than reading the composer.
     */
    submittedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    attachmentUpload?: StoredAttachmentUploadCustodyV1;
}>): Promise<void> {
    const preparedAuthoring = RunnerPreparedAuthoringV1Schema.parse(input.preparedAuthoring);
    const submittedTeamCredentialModel = input.submittedTeamCredentialModel == null
        ? undefined
        : TeamCredentialProviderModelSelectionV1Schema.parse(input.submittedTeamCredentialModel);
    await registerRunnerCreatorCustodyActivation(input.scope, input.activationId);
    const key = await storageKey(input.scope, input.activationId);
    await runCustodyMutation(key, async () => {
        const raw = await readDeviceLocalStorageString(key);
        const attachmentUpload = parseAttachmentUploadCustody(input.attachmentUpload, preparedAuthoring);
        if (raw !== null) {
            const existing = parseStored(raw);
            if (existing.attachmentStaging) {
                const staged = existing.attachmentStaging;
                if (!attachmentUpload
                    || staged.attachmentMessageLocalId !== attachmentUpload.attachmentMessageLocalId
                    || staged.firstTurnLocalId !== attachmentUpload.firstTurnLocalId
                    || staged.maxFileBytes !== attachmentUpload.maxFileBytes
                    || staged.files.some((entry) => !entry.reviewedFile)
                    || createCanonicalJsonSigningInput(staged.files.map((entry) => entry.reviewedFile))
                        !== createCanonicalJsonSigningInput(preparedAuthoring.files)
                    || createCanonicalJsonSigningInput(staged.files.map((entry) => entry.custodyFile))
                        !== createCanonicalJsonSigningInput(attachmentUpload.files)) {
                    throw new RunnerCreatorLaunchCustodyUnavailableError();
                }
            }
        }
        await writeAndVerify(input.scope, input.activationId, {
            v: 1,
            preparedAuthoring,
            submittedTeamCredentialModel,
            attachmentUpload,
        }, raw);
    });
}

/** Accept server-selected identities once, from the correlated create response only. */
export async function acceptRunnerCreatorActivationBinding(scope: ServerAccountScope, projection: unknown): Promise<void> {
    const parsed = RunnerActivationProjectionV1Schema.parse(projection);
    const binding = runnerActivationProjectionBindingV1(parsed);
    if (binding.creatorAccountId !== scope.accountId) throw new RunnerCreatorLaunchCustodyUnavailableError();
    const stored = parseStored(await readDeviceLocalStorageString(await storageKey(scope, binding.activationId)));
    if (stored.binding && createCanonicalJsonSigningInput(stored.binding) !== createCanonicalJsonSigningInput(binding)) {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
    await writeAndVerify(scope, binding.activationId, { ...stored, binding });
}

export async function readAcceptedRunnerCreatorActivationBinding(scope: ServerAccountScope, activationId: string, projection?: unknown): Promise<RunnerReviewCustodyV1['binding']> {
    const stored = parseStored(await readDeviceLocalStorageString(await storageKey(scope, activationId)));
    const binding = stored.binding;
    if (!binding || binding.activationId !== activationId || binding.creatorAccountId !== scope.accountId
        || (projection !== undefined && createCanonicalJsonSigningInput(runnerActivationProjectionBindingV1(RunnerActivationProjectionV1Schema.parse(projection))) !== createCanonicalJsonSigningInput(binding))) {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
    return binding;
}

export async function writeReviewedRunnerCreatorLaunchCustody(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    custody: RunnerReviewCustodyV1;
}>): Promise<void> {
    const binding = await readAcceptedRunnerCreatorActivationBinding(input.scope, input.activationId);
    if (createCanonicalJsonSigningInput(binding) !== createCanonicalJsonSigningInput(input.custody.binding)
        || createCanonicalJsonSigningInput(binding) !== createCanonicalJsonSigningInput(input.custody.launchManifest.binding)) {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
    const stored = parseStored(await readDeviceLocalStorageString(await storageKey(input.scope, input.activationId)));
    await writeAndVerify(input.scope, input.activationId, {
        v: 1,
        binding,
        preparedAuthoring: input.custody.preparedAuthoring,
        submittedTeamCredentialModel: stored.submittedTeamCredentialModel,
        attachmentUpload: stored.attachmentUpload,
        reviewed: {
            binding: input.custody.binding,
            launchManifest: input.custody.launchManifest,
            review: input.custody.review,
            machineContentKeyBase64Url: input.custody.machineContentKey
                ? encodeBase64(input.custody.machineContentKey, 'base64url')
                : null,
        },
    });
}

export async function readPreparedRunnerCreatorLaunchCustody(scope: ServerAccountScope, activationId: string): Promise<RunnerPreparedAuthoringV1> {
    const key = await storageKey(scope, activationId);
    await awaitCustodyMutation(key);
    return requirePreparedAuthoring(parseStored(await readDeviceLocalStorageString(key)));
}

/**
 * The Team model frozen with the submitted package, or `null` when the package
 * was prepared without one (review then reports the model unselected).
 */
export async function readSubmittedRunnerCreatorTeamCredentialModel(
    scope: ServerAccountScope,
    activationId: string,
): Promise<TeamCredentialProviderModelSelectionV1 | null> {
    const key = await storageKey(scope, activationId);
    await awaitCustodyMutation(key);
    const stored = parseStored(await readDeviceLocalStorageString(key));
    requirePreparedAuthoring(stored);
    return stored.submittedTeamCredentialModel ?? null;
}

export async function readRunnerCreatorAttachmentUploadCustody(
    scope: ServerAccountScope,
    activationId: string,
): Promise<RunnerCreatorAttachmentUploadCustody> {
    const key = await storageKey(scope, activationId);
    await awaitCustodyMutation(key);
    const stored = parseStored(await readDeviceLocalStorageString(key));
    requirePreparedAuthoring(stored);
    const upload = stored.attachmentUpload;
    if (!upload) {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
    try {
        // Reopening staged bytes has one owner; this reader never reimplements it.
        const stagedFiles = await Promise.all(upload.files.map(reopenStagedRunnerAttachment));
        const resumedUploads = upload.verifiedUploads?.map((checkpoint): RunnerCreatorAttachmentUploadCheckpoint => ({
            id: checkpoint.id,
            name: checkpoint.name,
            ...(checkpoint.mimeType ? { mimeType: checkpoint.mimeType } : {}),
            path: checkpoint.path,
            sizeBytes: checkpoint.sizeBytes,
            sha256: checkpoint.sha256,
        }));
        return {
            attachmentMessageLocalId: upload.attachmentMessageLocalId,
            firstTurnLocalId: upload.firstTurnLocalId,
            maxFileBytes: upload.maxFileBytes,
            stagedFiles,
            ...(resumedUploads && resumedUploads.length > 0 ? { resumedUploads } : {}),
        };
    } catch {
        throw new RunnerCreatorLaunchCustodyUnavailableError();
    }
}

/**
 * Retains one already-verified ordinary-upload result inside the incumbent
 * activation custody. The caller has already matched the returned size and
 * digest against the reviewed manifest; this owner re-checks that fact against
 * its own retained reviewed authoring before persisting, and is idempotent so a
 * replayed per-file completion cannot record the same file twice.
 */
export async function recordRunnerCreatorAttachmentUploadCheckpoint(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    upload: RunnerCreatorAttachmentUploadCheckpoint;
}>): Promise<void> {
    const key = await storageKey(input.scope, input.activationId);
    await runCustodyMutation(key, async () => {
        const raw = await readDeviceLocalStorageString(key);
        const stored = parseStored(raw);
        const preparedAuthoring = requirePreparedAuthoring(stored);
        const attachmentUpload = stored.attachmentUpload;
        if (!attachmentUpload) throw new RunnerCreatorLaunchCustodyUnavailableError();
        const reviewed = preparedAuthoring.files.find((file) => file.id === input.upload.id);
        if (!reviewed || reviewed.name !== input.upload.name
            || reviewed.mimeType !== (input.upload.mimeType ?? null)
            || reviewed.sizeBytes !== input.upload.sizeBytes
            || reviewed.sha256 !== input.upload.sha256
            || input.upload.path.length === 0) {
            throw new Error('runner_attachment_checkpoint_mismatch');
        }
        const retained = attachmentUpload.verifiedUploads ?? [];
        if (retained.some((existing) => existing.id === reviewed.id)) return;
        await writeAndVerify(input.scope, input.activationId, {
            ...stored,
            attachmentUpload: {
                ...attachmentUpload,
                verifiedUploads: [...retained, {
                    id: reviewed.id,
                    name: reviewed.name,
                    mimeType: reviewed.mimeType,
                    path: input.upload.path,
                    sizeBytes: reviewed.sizeBytes,
                    sha256: reviewed.sha256,
                }],
            },
        }, raw);
    });
}

export async function readReviewedRunnerCreatorLaunchCustody(scope: ServerAccountScope, activationId: string): Promise<RunnerReviewCustodyV1> {
    const stored = parseStored(await readDeviceLocalStorageString(await storageKey(scope, activationId)));
    if (!stored.reviewed) throw new RunnerCreatorLaunchCustodyUnavailableError();
    return {
        binding: stored.reviewed.binding,
        preparedAuthoring: requirePreparedAuthoring(stored),
        launchManifest: stored.reviewed.launchManifest,
        review: stored.reviewed.review,
        machineContentKey: stored.reviewed.machineContentKeyBase64Url
            ? decodeBase64(stored.reviewed.machineContentKeyBase64Url, 'base64url')
            : null,
    };
}

export async function getOrCreateRunnerMaterializationRequest(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    projection: unknown;
    build: (custody: RunnerReviewCustodyV1) => Promise<RunnerMaterializationRequestV1>;
}>): Promise<RunnerMaterializationRequestV1> {
    const key = await storageKey(input.scope, input.activationId);
    const existing = materializationRequestWrites.get(key);
    if (existing) return existing;
    const pending = (async () => {
        const stored = parseStored(await readDeviceLocalStorageString(key));
        if (!stored.reviewed || !stored.binding) throw new RunnerCreatorLaunchCustodyUnavailableError();
        const custody: RunnerReviewCustodyV1 = {
            binding: stored.reviewed.binding,
            preparedAuthoring: requirePreparedAuthoring(stored),
            launchManifest: stored.reviewed.launchManifest,
            review: stored.reviewed.review,
            machineContentKey: stored.reviewed.machineContentKeyBase64Url
                ? decodeBase64(stored.reviewed.machineContentKeyBase64Url, 'base64url')
                : null,
        };
        let projection: ReturnType<typeof assertRunnerMaterializationCurrentnessV1>;
        try {
            projection = assertRunnerMaterializationCurrentnessV1({ projection: input.projection, custody });
        } catch {
            throw new RunnerCreatorLaunchCustodyUnavailableError();
        }
        const validateRequest = (request: RunnerMaterializationRequestV1): RunnerMaterializationRequestV1 => {
            if (!projection.review || !projection.consent || !projection.readiness
                || request.activationId !== input.activationId
                || request.launchManifestCommitment !== projection.review.launchManifestCommitment
                || createCanonicalJsonSigningInput(request.consent) !== createCanonicalJsonSigningInput(projection.consent)
                || createCanonicalJsonSigningInput(request.readiness) !== createCanonicalJsonSigningInput(projection.readiness)
                || createCanonicalJsonSigningInput(request.machine.runnerContentKeyBinding)
                    !== createCanonicalJsonSigningInput(projection.review.machineContentKeyBinding)) {
                throw new RunnerCreatorLaunchCustodyUnavailableError();
            }
            return request;
        };
        if (stored.materializationRequest) return validateRequest(stored.materializationRequest);
        const request = validateRequest(RunnerMaterializationRequestV1Schema.parse(await input.build(custody)));
        await writeAndVerify(input.scope, input.activationId, { ...stored, materializationRequest: request });
        return request;
    })();
    materializationRequestWrites.set(key, pending);
    try {
        return await pending;
    } finally {
        if (materializationRequestWrites.get(key) === pending) materializationRequestWrites.delete(key);
    }
}

export async function removeRunnerCreatorLaunchCustody(scope: ServerAccountScope, activationId: string): Promise<void> {
    const key = await storageKey(scope, activationId);
    await runCustodyMutation(key, async () => {
        let stored: StoredCreatorLaunchCustodyV1 | null = null;
        try {
            const raw = await readDeviceLocalStorageString(key);
            if (raw !== null) stored = parseStored(raw);
        } catch {
            // A transient read/parse failure cannot prove that no staged bytes
            // remain. Preserve the only exact locator and surface retry.
            throw new RunnerCreatorLaunchCustodyUnavailableError();
        }
        if (stored?.attachmentUpload) {
            await removeStagedRunnerAttachmentCustody(stored.attachmentUpload.files);
        }
        if (stored?.attachmentStaging) {
            await removeStagedRunnerAttachmentCustody(stored.attachmentStaging.files.map((entry) => entry.custodyFile));
        }
        await removeDeviceLocalStorageString(key);
    });
}
