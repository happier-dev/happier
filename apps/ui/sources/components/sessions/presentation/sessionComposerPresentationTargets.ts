import * as React from 'react';

import {
    buildQualifiedPluginContributionKey,
    ComposerContentHandleV1Schema,
    ComposerInstanceIdSchema,
    ComposerOperationV1Schema,
    ComposerTransactionV1Schema,
    MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
    type ComposerAttachmentViewV1,
    type ComposerContentHandleV1,
    type ComposerDecorationSetV1,
    type ComposerRefV1,
    type ComposerSnapshotV1,
    type ComposerTransactionResultV1,
    type ComposerInputLockRequestV1,
    type PluginContributionIdentityV1,
    type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import {
    PluginUiApplyComposerRequestV1Schema,
    PluginUiAcquireComposerInputLockRequestV1Schema,
    PluginUiDisposeHostResourceRequestV1Schema,
    PluginUiFocusComposerRequestV1Schema,
    PluginUiInspectComposerContentRequestV1Schema,
    PluginUiInspectComposerContentResultV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiPickComposerMediaRequestV1Schema,
    PluginUiReadComposerRequestV1Schema,
    PluginUiReleaseComposerContentRequestV1Schema,
    PluginUiSetComposerDecorationsRequestV1Schema,
    PluginUiWatchComposerRequestV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiRequestOptions,
} from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { projectComposerDocumentSnapshot } from '@/components/sessions/composer/composerSnapshotProjection';
import { createExistingSessionComposerDocumentOwner } from '@/components/sessions/composer/existingSessionComposerDocumentOwner';
import type { ComposerPresentationDocumentMutation } from '@/components/sessions/composer/composerDocumentOwner';
export type { ComposerPresentationDocumentMutation } from '@/components/sessions/composer/composerDocumentOwner';
import { randomUUID } from '@/platform/randomUUID';
import { pickAndStageComposerMedia } from '@/sync/domains/transfers/ops/pickAndStageComposerMedia';
import {
    getComposerMediaContentAvailability,
    inspectComposerContent,
    releaseComposerContent,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { subscribeSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { PluginUiComposerAttachmentProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

type ComposerMentionRef = ComposerSnapshotV1['references'][number];

/**
 * A mounted Composer control's exact admitted identity. The presentation host
 * supplies this static fact with a transaction; it never supplies an
 * attachment resolver, attachment identity, label, or cardinality.
 */
export type ComposerPresentationAdmittedContributor = Readonly<{
    identity: PluginContributionIdentityV1;
    immutableGenerationId: string;
}>;

/**
 * Host-stamped identity for ephemeral Composer effects. It combines the
 * contribution, immutable generation, and physical surface instance so two
 * concurrent mounts cannot replace or retain one another's effects.
 */
export type ComposerPresentationHostOwner = Readonly<{
    identity: PluginContributionIdentityV1;
    immutableGenerationId: string;
    surfaceInstanceKey: string;
}>;

export type ComposerPresentationDecorationUpdate = Readonly<{
    owner: ComposerPresentationHostOwner;
    key: string;
    decorations: ComposerDecorationSetV1 | null;
}>;

export type ComposerPresentationInputLockLease = Readonly<{
    owner: ComposerPresentationHostOwner;
    /** The existing generic host-resource subscription id, never a new lease id. */
    subscriptionId: string;
    request: ComposerInputLockRequestV1;
}>;

export type ComposerPresentationTransactionRequest = Readonly<{
    ref: ComposerRefV1;
    transaction: unknown;
}>;

export type ComposerPresentationTransactionApplier = Readonly<{
    apply: (request: Readonly<{
        ref: ComposerRefV1;
        admittedContributor: ComposerPresentationAdmittedContributor;
        transaction: unknown;
        /**
         * The exact target stamped by the currently mounted host. It is not
         * part of the Plugin UI request and cannot be supplied by an author.
         */
        executionTarget?: SessionExecutionTargetV1;
    }>) => ComposerTransactionResultV1;
    /**
     * Resolves only a declaration admitted to this exact contribution and
     * generation. Media staging uses the resulting attachment identity as
     * custody owner; callers cannot supply or reconstruct it themselves.
     */
    resolveAttachmentIdentity: (request: Readonly<{
        attachmentLocalId: string;
        admittedContributor: ComposerPresentationAdmittedContributor;
    }>) => PluginContributionIdentityV1 | null;
}>;

type ComposerPresentationAttachmentAuthority = Readonly<{
    identity: PluginContributionIdentityV1;
    immutableGenerationId: string;
    typeLabel: string;
    cardinality: 'one' | 'many';
    valueValidator: PluginUiComposerAttachmentProjection['valueValidator'];
}>;

type ComposerPresentationAttachmentAuthorityResolver = (input: Readonly<{
    attachmentLocalId: string;
    admittedContributor: ComposerPresentationAdmittedContributor | null;
}>) => ComposerPresentationAttachmentAuthority | null;

/**
 * Scope-local adapter port. This is deliberately an adapter over incumbent
 * draft owners, not another persisted composer store. The legacy revision /
 * replace pair stays until the daemon presentation command migrates through
 * the same transaction grammar.
 */
export type ComposerPresentationTarget = Readonly<{
    readRevision: () => number;
    replace: (text: string, expectedRevision: number) => number;
    /**
     * Keeps this registered adapter scoped to its incumbent mounted owner.
     * A false or throwing check makes the target unavailable before another
     * Account, replaced scope, or unmounted input can be observed or focused.
     */
    isCurrent?: () => boolean;
    readSnapshot?: () => ComposerSnapshotV1;
    commitDocument?: (input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>) => ComposerTransactionResultV1;
    /**
     * The incumbent document owner emits its own exact change notification.
     * The transaction grammar must not publish a duplicate observation after
     * an atomic persistence-backed commit.
     */
    commitDocumentEmitsChange?: boolean;
    /** Host-created opaque attachment ids keep drafts from inventing identity. */
    createAttachmentInstanceId?: () => string;
    /** Focuses the exact visual input; `false` means this target is not editable. */
    focusComposer?: () => boolean | void;
    /**
     * Projects an ephemeral, owner-scoped decoration into the incumbent input.
     * The owner plus key is the visual identity; it must not mutate text,
     * persistence, or editor-private nodes.
     */
    setComposerDecorations?: (input: ComposerPresentationDecorationUpdate) => void;
    /**
     * Applies one bounded input-lock lease to the exact visual input and returns
     * its idempotent release. The adapter owns strictest-mode aggregation and
     * synchronously projects it into both its input affordance and snapshot.
     * The owner plus subscription id is the lease identity, so one mount cannot
     * release another mount's generic transport id.
     */
    acquireComposerInputLock?: (input: ComposerPresentationInputLockLease) => () => void;
}>;

/**
 * Keeps the registered adapter identity scoped to one exact Composer ref while
 * forwarding every render's current draft/projection facts through the
 * incumbent adapter port. A projection update may rerender its mounted input;
 * that must not unregister the target and retire its own ephemeral effects.
 */
export function useStableComposerPresentationTarget(
    ref: ComposerRefV1,
    target: ComposerPresentationTarget,
): ComposerPresentationTarget {
    const latestTargetRef = React.useRef(target);
    latestTargetRef.current = target;
    const targetKey = composerRefV1Key(ref);
    const stableTargetRef = React.useRef<Readonly<{
        targetKey: string;
        target: ComposerPresentationTarget;
    }> | null>(null);

    if (stableTargetRef.current?.targetKey !== targetKey) {
        const readCurrent = () => latestTargetRef.current;
        stableTargetRef.current = {
            targetKey,
            target: {
                readRevision: () => readCurrent().readRevision(),
                replace: (text, expectedRevision) => readCurrent().replace(text, expectedRevision),
                ...(target.isCurrent ? {
                    isCurrent: () => readCurrent().isCurrent?.() ?? true,
                } : {}),
                ...(target.readSnapshot ? {
                    readSnapshot: () => readCurrent().readSnapshot!(),
                } : {}),
                ...(target.commitDocument ? {
                    commitDocument: (input) => readCurrent().commitDocument!(input),
                } : {}),
                ...(target.commitDocumentEmitsChange ? {
                    commitDocumentEmitsChange: true,
                } : {}),
                ...(target.createAttachmentInstanceId ? {
                    createAttachmentInstanceId: () => readCurrent().createAttachmentInstanceId!(),
                } : {}),
                ...(target.focusComposer ? {
                    focusComposer: () => readCurrent().focusComposer!(),
                } : {}),
                ...(target.setComposerDecorations ? {
                    setComposerDecorations: (input) => readCurrent().setComposerDecorations!(input),
                } : {}),
                ...(target.acquireComposerInputLock ? {
                    acquireComposerInputLock: (input) => readCurrent().acquireComposerInputLock!(input),
                } : {}),
            },
        };
    }

    return stableTargetRef.current.target;
}

export type ComposerPresentationTargetRead = Readonly<{
    revision: number;
    replace: ComposerPresentationTarget['replace'];
}>;

const targets = new Map<string, ComposerPresentationTarget>();
const listeners = new Set<() => void>();
const listenersByTargetKey = new Map<string, Set<() => void>>();

function emit(ref?: ComposerRefV1): void {
    for (const listener of listeners) listener();
    if (!ref) return;
    for (const listener of listenersByTargetKey.get(composerRefV1Key(ref)) ?? []) {
        listener();
    }
}

function encodePart(value: string): string {
    return `${value.length}:${value}`;
}

function readRegisteredTarget(ref: ComposerRefV1): ComposerPresentationTarget | null {
    const target = targets.get(composerRefV1Key(ref)) ?? null;
    return target && isComposerPresentationTargetCurrent(target) ? target : null;
}

function isComposerPresentationTargetCurrent(target: ComposerPresentationTarget): boolean {
    try {
        return target.isCurrent?.() !== false;
    } catch {
        return false;
    }
}

function readPersistentSessionId(ref: ComposerRefV1): string | null {
    if (ref.kind !== 'session') return null;
    const sessionId = ref.sessionId.trim();
    return sessionId.length > 0 ? sessionId : null;
}

function isPersistentSessionDraftCurrent(
    scope: ServerAccountScope,
    sessionId: string,
): boolean {
    const state = storage.getState();
    return state.deletedSessionIds[sessionId] !== true
        && areServerAccountScopesEqual(state.sessionLocalStateScope, scope)
        && areServerAccountScopesEqual(getActiveServerAccountScope(), scope);
}

function capturePersistentSessionDraftScope(ref: ComposerRefV1): ServerAccountScope | null {
    const sessionId = readPersistentSessionId(ref);
    if (!sessionId) return null;
    const scope = storage.getState().sessionLocalStateScope;
    if (!scope || !isPersistentSessionDraftCurrent(scope, sessionId)) return null;
    return scope;
}

function persistentSessionDraftStateSignature(
    scope: ServerAccountScope,
    sessionId: string,
): string {
    const state = storage.getState();
    if (!isPersistentSessionDraftCurrent(scope, sessionId)) return 'unavailable';
    const accessLevel = state.sessions[sessionId]?.accessLevel ?? 'unknown';
    return `available:${accessLevel}`;
}

function createPersistentSessionComposerTarget(
    ref: Extract<ComposerRefV1, Readonly<{ kind: 'session' }>>,
): ComposerPresentationTarget | null {
    const scope = capturePersistentSessionDraftScope(ref);
    const sessionId = readPersistentSessionId(ref);
    if (!scope || !sessionId) return null;

    const isCurrent = () => isPersistentSessionDraftCurrent(scope, sessionId);
    const owner = createExistingSessionComposerDocumentOwner({ scope, ref, isCurrent });
    const readSnapshot = (): ComposerSnapshotV1 => {
    const state = storage.getState();
        const editable = state.sessions[sessionId]?.accessLevel !== 'view';
        return projectComposerDocumentSnapshot({
            owner,
            attachmentCatalog: { entriesById: null },
            presentation: {
                layout: 'wrap',
                focused: false,
                editable,
                submittable: editable,
                submitting: false,
                running: state.sessions[sessionId]?.active === true,
            },
        });
    };

    return Object.freeze({
        readRevision: () => owner.read().revision,
        replace: (text, expectedRevision) => {
            const snapshot = readSnapshot();
            if (snapshot.revision !== expectedRevision) return snapshot.revision;
            const result = owner.apply(expectedRevision, {
                text,
                references: snapshot.references,
                attachments: snapshot.attachments,
            });
            return result.status === 'applied' ? result.revision : owner.read().revision;
        },
        isCurrent,
        readSnapshot,
        commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
        commitDocumentEmitsChange: true,
        createAttachmentInstanceId: randomUUID,
    });
}

function readTarget(ref: ComposerRefV1): ComposerPresentationTarget | null {
    const registered = readRegisteredTarget(ref);
    if (registered) return registered;
    return ref.kind === 'session' ? createPersistentSessionComposerTarget(ref) : null;
}

function equalContributionIdentity(
    left: PluginContributionIdentityV1,
    right: PluginContributionIdentityV1,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function invalidOperation(operationIndex: number, reason: string): ComposerTransactionResultV1 {
    return { status: 'invalidOperation', operationIndex, reason };
}

function rangeIsWithinText(
    range: Readonly<{ start: number; end: number }>,
    text: string,
): boolean {
    return range.start >= 0 && range.end >= range.start && range.end <= text.length;
}

function clampSelection(
    selection: ComposerSnapshotV1['selection'],
    textLength: number,
): ComposerSnapshotV1['selection'] {
    if (!selection) return undefined;
    const start = Math.min(Math.max(0, selection.start), textLength);
    const end = Math.min(Math.max(start, selection.end), textLength);
    return { start, end };
}

type TextEdit = Readonly<{
    start: number;
    end: number;
    text: string;
    operationIndex: number;
}>;

function findSingleTextEdit(previousText: string, nextText: string): TextEdit | null {
    if (previousText === nextText) return null;

    let prefix = 0;
    const prefixLimit = Math.min(previousText.length, nextText.length);
    while (prefix < prefixLimit && previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
        prefix += 1;
    }

    let suffix = 0;
    const previousRemaining = previousText.length - prefix;
    const nextRemaining = nextText.length - prefix;
    while (
        suffix < previousRemaining
        && suffix < nextRemaining
        && previousText.charCodeAt(previousText.length - 1 - suffix) === nextText.charCodeAt(nextText.length - 1 - suffix)
    ) {
        suffix += 1;
    }

    return {
        start: prefix,
        end: previousText.length - suffix,
        text: nextText.slice(prefix, nextText.length - suffix),
        operationIndex: 0,
    };
}

function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
    let nextText = text;
    const ordered = [...edits].sort((left, right) => (
        right.start - left.start
        || right.end - left.end
        // Applying later inserts first preserves authored array order at one offset.
        || right.operationIndex - left.operationIndex
    ));
    for (const edit of ordered) {
        nextText = `${nextText.slice(0, edit.start)}${edit.text}${nextText.slice(edit.end)}`;
    }
    return nextText;
}

function rebaseExistingReference(
    reference: ComposerMentionRef,
    edits: readonly TextEdit[],
    nextText: string,
): ComposerMentionRef | null {
    let delta = 0;
    for (const edit of edits) {
        // An insertion exactly at the reference start belongs before the token;
        // one exactly at the end belongs after it. Any interior edit invalidates
        // the token-bound reference rather than silently moving a partial token.
        if (edit.end <= reference.start) {
            delta += edit.text.length - (edit.end - edit.start);
            continue;
        }
        if (edit.start >= reference.end) continue;
        return null;
    }
    const rebased = {
        ...reference,
        start: reference.start + delta,
        end: reference.end + delta,
    };
    return nextText.slice(rebased.start, rebased.end) === rebased.token ? rebased : null;
}

function readReferenceKey(reference: Pick<ComposerMentionRef, 'ref' | 'start' | 'end'>): string {
    return `${reference.ref}\u0000${reference.start}\u0000${reference.end}`;
}

function validateReferenceOrder(references: readonly ComposerMentionRef[]): number | null {
    let boundary = 0;
    for (let index = 0; index < references.length; index += 1) {
        const reference = references[index]!;
        if (reference.start < boundary) return index;
        boundary = reference.end;
    }
    return null;
}

function resolveTextMutation(input: Readonly<{
    snapshot: ComposerSnapshotV1;
    operations: readonly ReturnType<typeof ComposerOperationV1Schema.parse>[];
}>):
    | Readonly<{ ok: true; text: string; edits: readonly TextEdit[] }>
    | Readonly<{ ok: false; result: ComposerTransactionResultV1 }> {
    const textOperations = input.operations.flatMap((operation, operationIndex) => (
        operation.kind.startsWith('text.') ? [{ operation, operationIndex }] : []
    ));
    if (textOperations.length === 0) {
        return { ok: true, text: input.snapshot.text, edits: [] };
    }
    if (!input.snapshot.capabilities.text) {
        return { ok: false, result: invalidOperation(textOperations[0]!.operationIndex, 'text_unsupported') };
    }

    const exclusive = textOperations.find(({ operation }) => operation.kind === 'text.set' || operation.kind === 'text.clear');
    if (exclusive && textOperations.length > 1) {
        return { ok: false, result: invalidOperation(exclusive.operationIndex, 'exclusive_text_operation') };
    }

    if (exclusive) {
        const nextText = exclusive.operation.kind === 'text.set' ? exclusive.operation.text : '';
        const edit = findSingleTextEdit(input.snapshot.text, nextText);
        return { ok: true, text: nextText, edits: edit ? [{ ...edit, operationIndex: exclusive.operationIndex }] : [] };
    }

    const edits: TextEdit[] = [];
    for (const { operation, operationIndex } of textOperations) {
        if (operation.kind === 'text.insert') {
            if (operation.position.offset > input.snapshot.text.length) {
                return { ok: false, result: invalidOperation(operationIndex, 'text_position_out_of_bounds') };
            }
            edits.push({
                start: operation.position.offset,
                end: operation.position.offset,
                text: operation.text,
                operationIndex,
            });
            continue;
        }
        if (operation.kind === 'text.replaceRange') {
            if (!rangeIsWithinText(operation.range, input.snapshot.text)) {
                return { ok: false, result: invalidOperation(operationIndex, 'text_range_out_of_bounds') };
            }
            edits.push({
                start: operation.range.start,
                end: operation.range.end,
                text: operation.text,
                operationIndex,
            });
        }
    }

    const replacements = edits.filter((edit) => edit.start < edit.end).sort((left, right) => left.start - right.start);
    for (let index = 1; index < replacements.length; index += 1) {
        if (replacements[index]!.start < replacements[index - 1]!.end) {
            return { ok: false, result: invalidOperation(replacements[index]!.operationIndex, 'overlapping_text_ranges') };
        }
    }
    for (const insertion of edits.filter((edit) => edit.start === edit.end)) {
        if (replacements.some((replacement) => insertion.start > replacement.start && insertion.start < replacement.end)) {
            return { ok: false, result: invalidOperation(insertion.operationIndex, 'insert_inside_replaced_range') };
        }
    }

    return { ok: true, text: applyTextEdits(input.snapshot.text, edits), edits };
}

function resolveReferences(input: Readonly<{
    snapshot: ComposerSnapshotV1;
    operations: readonly ReturnType<typeof ComposerOperationV1Schema.parse>[];
    nextText: string;
    edits: readonly TextEdit[];
}>):
    | Readonly<{ ok: true; references: readonly ComposerMentionRef[] }>
    | Readonly<{ ok: false; result: ComposerTransactionResultV1 }> {
    const referenceOperations = input.operations.flatMap((operation, operationIndex) => (
        operation.kind.startsWith('reference.') ? [{ operation, operationIndex }] : []
    ));
    if (referenceOperations.length === 0 && input.edits.length === 0) {
        return { ok: true, references: input.snapshot.references };
    }
    if (!input.snapshot.capabilities.references && referenceOperations.length > 0) {
        return { ok: false, result: invalidOperation(referenceOperations[0]!.operationIndex, 'references_unsupported') };
    }

    const removed = new Set<string>();
    for (const { operation, operationIndex } of referenceOperations) {
        if (operation.kind !== 'reference.remove') continue;
        const key = readReferenceKey(operation.reference);
        if (!input.snapshot.references.some((reference) => readReferenceKey(reference) === key) || removed.has(key)) {
            return { ok: false, result: invalidOperation(operationIndex, 'reference_not_found') };
        }
        removed.add(key);
    }

    const rebased = input.snapshot.references.flatMap((reference) => {
        if (removed.has(readReferenceKey(reference))) return [];
        const next = rebaseExistingReference(reference, input.edits, input.nextText);
        return next ? [next] : [];
    });
    const inserted: Array<Readonly<{ reference: ComposerMentionRef; operationIndex: number }>> = [];
    for (const { operation, operationIndex } of referenceOperations) {
        if (operation.kind !== 'reference.insert') continue;
        if (
            operation.reference.end > input.nextText.length
            || input.nextText.slice(operation.reference.start, operation.reference.end) !== operation.reference.token
        ) {
            return { ok: false, result: invalidOperation(operationIndex, 'reference_token_mismatch') };
        }
        inserted.push({ reference: operation.reference, operationIndex });
    }

    const ordered = [
        ...rebased.map((reference) => ({ reference, operationIndex: -1 })),
        ...inserted,
    ].sort((left, right) => (
        left.reference.start - right.reference.start
        || left.reference.end - right.reference.end
        || left.operationIndex - right.operationIndex
    ));
    const overlapIndex = validateReferenceOrder(ordered.map((entry) => entry.reference));
    if (overlapIndex !== null) {
        const offending = ordered[overlapIndex]!;
        return {
            ok: false,
            result: invalidOperation(offending.operationIndex >= 0 ? offending.operationIndex : 0, 'overlapping_references'),
        };
    }
    return { ok: true, references: ordered.map((entry) => entry.reference) };
}

/**
 * The attachment's type label, resolved ONCE at admission.
 *
 * 03d1 freezes this string into the persisted record deliberately: replay must
 * not depend on which plugin translations happen to be installed later. That
 * makes resolving the CURRENT locale here the whole point — persisting the raw
 * declaration fallback froze every reader's attachment into the plugin author's
 * English instead of the language they were using when they added it.
 */
function readAttachmentTypeLabel(
    entry: PluginUiComposerAttachmentProjection,
    localize: PluginLocalizedTextResolver | undefined,
): string | null {
    const title = entry.definition.title;
    const resolved = localize
        ? localize(entry.identity.pluginId, title).trim()
        : (typeof title === 'string'
            ? title.trim()
            : typeof title?.fallback === 'string'
                ? title.fallback.trim()
                : '');
    return resolved.length > 0 ? resolved : null;
}

function createAttachmentAuthorityResolver(input: Readonly<{
    composerAttachmentsById: Readonly<Record<string, PluginUiComposerAttachmentProjection>>;
    localize?: PluginLocalizedTextResolver;
}>): ComposerPresentationAttachmentAuthorityResolver {
    const authoritiesByQualifiedId = new Map<string, ComposerPresentationAttachmentAuthority>();
    for (const [mapKey, entry] of Object.entries(input.composerAttachmentsById)) {
        const identity = entry.identity;
        const qualifiedId = buildQualifiedPluginContributionKey(identity);
        const typeLabel = readAttachmentTypeLabel(entry, input.localize);
        if (
            mapKey !== entry.id
            || entry.id !== qualifiedId
            || entry.pluginId !== identity.pluginId
            || entry.definition.id !== identity.localId
            || typeof entry.immutableGenerationId !== 'string'
            || entry.immutableGenerationId.trim().length === 0
            || !typeLabel
        ) {
            continue;
        }
        authoritiesByQualifiedId.set(qualifiedId, Object.freeze({
            identity: Object.freeze({ ...identity }),
            immutableGenerationId: entry.immutableGenerationId,
            typeLabel,
            cardinality: entry.definition.cardinality,
            valueValidator: entry.valueValidator,
        }));
    }

    return ({ attachmentLocalId, admittedContributor }) => {
        if (!admittedContributor) return null;
        const authority = authoritiesByQualifiedId.get(buildQualifiedPluginContributionKey({
            pluginId: admittedContributor.identity.pluginId,
            localId: attachmentLocalId,
        }));
        if (
            !authority
            || authority.identity.pluginId !== admittedContributor.identity.pluginId
            || authority.immutableGenerationId !== admittedContributor.immutableGenerationId
        ) {
            return null;
        }
        return authority;
    };
}

function attachmentValueIsValid(
    authority: ComposerPresentationAttachmentAuthority,
    value: unknown,
): boolean {
    try {
        return authority.valueValidator?.(value) === true;
    } catch {
        return false;
    }
}

function validateAttachmentOperationValues(input: Readonly<{
    snapshot: ComposerSnapshotV1;
    operations: readonly ReturnType<typeof ComposerOperationV1Schema.parse>[];
    attachmentAuthorityResolver: ComposerPresentationAttachmentAuthorityResolver | null;
    admittedContributor: ComposerPresentationAdmittedContributor | null;
}>):
    | Readonly<{ ok: true; authoritiesByOperationIndex: ReadonlyMap<number, ComposerPresentationAttachmentAuthority> }>
    | Readonly<{ ok: false; result: ComposerTransactionResultV1 }> {
    const authoritiesByOperationIndex = new Map<number, ComposerPresentationAttachmentAuthority>();
    for (let operationIndex = 0; operationIndex < input.operations.length; operationIndex += 1) {
        const operation = input.operations[operationIndex]!;
        if (operation.kind === 'attachment.add') {
            const authority = input.attachmentAuthorityResolver?.({
                attachmentLocalId: operation.attachmentLocalId,
                admittedContributor: input.admittedContributor,
            }) ?? null;
            if (!authority || authority.identity.localId !== operation.attachmentLocalId) {
                return { ok: false, result: invalidOperation(operationIndex, 'attachment_authority_mismatch') };
            }
            if (!attachmentValueIsValid(authority, operation.value.value)) {
                return { ok: false, result: invalidOperation(operationIndex, 'attachment_value_invalid') };
            }
            authoritiesByOperationIndex.set(operationIndex, authority);
            continue;
        }
        if (operation.kind !== 'attachment.update') continue;
        const existing = input.snapshot.attachments.find((attachment) => attachment.instanceId === operation.instanceId);
        if (!existing) {
            return { ok: false, result: invalidOperation(operationIndex, 'attachment_not_found') };
        }
        const authority = input.attachmentAuthorityResolver?.({
            attachmentLocalId: existing.attachment.localId,
            admittedContributor: input.admittedContributor,
        }) ?? null;
        if (!authority || !equalContributionIdentity(existing.attachment, authority.identity)) {
            return { ok: false, result: invalidOperation(operationIndex, 'attachment_authority_mismatch') };
        }
        if (!attachmentValueIsValid(authority, operation.update.value)) {
            return { ok: false, result: invalidOperation(operationIndex, 'attachment_value_invalid') };
        }
        authoritiesByOperationIndex.set(operationIndex, authority);
    }
    return { ok: true, authoritiesByOperationIndex };
}

function resolveAttachments(input: Readonly<{
    target: ComposerPresentationTarget;
    snapshot: ComposerSnapshotV1;
    operations: readonly ReturnType<typeof ComposerOperationV1Schema.parse>[];
    attachmentAuthorityResolver: ComposerPresentationAttachmentAuthorityResolver | null;
    admittedContributor: ComposerPresentationAdmittedContributor | null;
    executionTarget: SessionExecutionTargetV1 | null;
}>):
    | Readonly<{ ok: true; attachments: readonly ComposerAttachmentViewV1[]; attachmentInstanceIds: readonly string[] }>
    | Readonly<{ ok: false; result: ComposerTransactionResultV1 }> {
    const attachmentOperations = input.operations.flatMap((operation, operationIndex) => (
        operation.kind.startsWith('attachment.') ? [{ operation, operationIndex }] : []
    ));
    if (attachmentOperations.length === 0) {
        return { ok: true, attachments: input.snapshot.attachments, attachmentInstanceIds: [] };
    }
    if (!input.snapshot.capabilities.attachments) {
        return { ok: false, result: invalidOperation(attachmentOperations[0]!.operationIndex, 'attachments_unsupported') };
    }

    const validatedValues = validateAttachmentOperationValues(input);
    if (!validatedValues.ok) return validatedValues;

    const attachments = input.snapshot.attachments.map((attachment) => ({ ...attachment }));
    const attachmentInstanceIds: string[] = [];
    for (const { operation, operationIndex } of attachmentOperations) {
        if (operation.kind === 'attachment.add') {
            const authority = validatedValues.authoritiesByOperationIndex.get(operationIndex)!;
            if (
                operation.content?.kind === 'stagedMedia'
                && (
                    input.executionTarget === null
                    || !equalContributionIdentity(operation.content.handle.owner, authority.identity)
                    || !equalComposerMediaExecutionTarget(
                        operation.content.handle.executionTarget,
                        input.executionTarget,
                    )
                )
            ) {
                return { ok: false, result: invalidOperation(operationIndex, 'staged_media_handle_mismatch') };
            }
            const matchingIdentityIndexes = attachments.flatMap((attachment, attachmentIndex) => (
                equalContributionIdentity(attachment.attachment, authority.identity) ? [attachmentIndex] : []
            ));
            const sameKeyIndex = attachments.findIndex((attachment) => (
                equalContributionIdentity(attachment.attachment, authority.identity) && attachment.key === operation.value.key
            ));
            const replacementIndex = authority.cardinality === 'one'
                ? (matchingIdentityIndexes[0] ?? -1)
                : sameKeyIndex;
            // `(attachment contribution, key)` is the immutable draft identity.
            // Cardinality-one chooses the list slot to replace, but a different
            // key is still remove-plus-add: it must not inherit the superseded
            // record's host identity, staged content, or availability.
            const sameIdentity = sameKeyIndex >= 0 ? attachments[sameKeyIndex]! : null;
            if (replacementIndex < 0 && attachments.length >= MAX_COMPOSER_ATTACHMENT_INSTANCES_V1) {
                return {
                    ok: false,
                    result: {
                        status: 'limitExceeded',
                        limit: 'composerAttachments',
                        maximum: MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
                        actual: attachments.length + 1,
                    },
                };
            }
            const generatedId = sameIdentity?.instanceId ?? input.target.createAttachmentInstanceId?.();
            if (!generatedId || !ComposerInstanceIdSchema.safeParse(generatedId).success) {
                return { ok: false, result: invalidOperation(operationIndex, 'attachment_instance_id_unavailable') };
            }
            // A contentless upsert changes the attachment value only. Stage
            // custody is removed only by an explicit replacement or removal.
            const content = operation.content ?? sameIdentity?.content;
            const next: ComposerAttachmentViewV1 = {
                v: 1,
                instanceId: generatedId,
                attachment: authority.identity,
                key: operation.value.key,
                value: operation.value.value,
                presentation: {
                    ...operation.value.presentation,
                    typeLabel: authority.typeLabel,
                },
                availability: sameIdentity?.availability ?? { status: 'ready' },
                ...(content === undefined ? {} : { content }),
            };
            if (replacementIndex >= 0) {
                attachments[replacementIndex] = next;
                if (authority.cardinality === 'one') {
                    for (let index = matchingIdentityIndexes.length - 1; index >= 1; index -= 1) {
                        attachments.splice(matchingIdentityIndexes[index]!, 1);
                    }
                }
            } else {
                attachments.push(next);
            }
            attachmentInstanceIds.push(generatedId);
            continue;
        }

        if (operation.kind !== 'attachment.update' && operation.kind !== 'attachment.remove') {
            continue;
        }

        const existingIndex = attachments.findIndex((attachment) => attachment.instanceId === operation.instanceId);
        if (existingIndex < 0) {
            return { ok: false, result: invalidOperation(operationIndex, 'attachment_not_found') };
        }
        if (operation.kind === 'attachment.remove') {
            attachments.splice(existingIndex, 1);
            continue;
        }

        const existing = attachments[existingIndex]!;
        attachments[existingIndex] = {
            ...existing,
            value: operation.update.value,
            presentation: operation.update.presentation
                ? { ...operation.update.presentation, typeLabel: existing.presentation.typeLabel }
                : existing.presentation,
        };
    }
    return { ok: true, attachments, attachmentInstanceIds };
}

/**
 * A completed staged-media claim is retained while any next attachment still
 * owns it. The key intentionally names only carrier ownership/identity facts,
 * never a path, URI, reader, or bytes.
 */
function composerStagedMediaHandleKey(handle: ComposerContentHandleV1): string {
    return [
        handle.executionTarget.serverId,
        handle.executionTarget.machineId,
        handle.owner.pluginId,
        handle.owner.localId,
        handle.id,
    ].map(encodePart).join('');
}

function readReleasedComposerStagedMediaHandles(input: Readonly<{
    composer: ComposerRefV1;
    previous: readonly ComposerAttachmentViewV1[];
    next: readonly ComposerAttachmentViewV1[];
}>): readonly Readonly<{
    handle: ComposerContentHandleV1;
    claimant: Readonly<{ composer: ComposerRefV1; attachmentInstanceId: string }>;
}>[] {
    const retained = new Set(input.next.flatMap((attachment) => (
        attachment.content?.kind === 'stagedMedia'
            ? [composerStagedMediaHandleKey(attachment.content.handle)]
            : []
    )));
    const released = new Map<string, Readonly<{
        handle: ComposerContentHandleV1;
        claimant: Readonly<{ composer: ComposerRefV1; attachmentInstanceId: string }>;
    }>>();
    for (const attachment of input.previous) {
        if (attachment.content?.kind !== 'stagedMedia') continue;
        const key = composerStagedMediaHandleKey(attachment.content.handle);
        if (!retained.has(key)) {
            released.set(key, {
                handle: attachment.content.handle,
                claimant: { composer: input.composer, attachmentInstanceId: attachment.instanceId },
            });
        }
    }
    return [...released.values()];
}

function releaseComposerStagedMedia(
    handle: ComposerContentHandleV1,
    claimant?: Readonly<{ composer: ComposerRefV1; attachmentInstanceId: string }>,
): void {
    // The carrier owns idempotence and bounded retention; the UI creates no
    // retry/cache state. Callers use this only after a committed discard or to
    // retire a late unattached pick.
    void releaseComposerContent(handle, claimant ? { claimant } : undefined).catch(() => undefined);
}

/**
 * The canonical UI-realm transaction executor. All target adapters provide is
 * a snapshot/commit bridge to their incumbent owner; validation, conflict,
 * and reference reconciliation live here. Attachment authority enters only
 * through the controller-created resolver below, never through a transaction.
 */
function applyComposerPresentationTransactionAtOwner(input: Readonly<{
    request: ComposerPresentationTransactionRequest;
    attachmentAuthorityResolver: ComposerPresentationAttachmentAuthorityResolver | null;
    admittedContributor: ComposerPresentationAdmittedContributor | null;
    /** The mounted host's private current target, if this call has one. */
    executionTarget?: SessionExecutionTargetV1;
    /**
     * Omitted uses the exact generic target resolution (including the
     * persisted Session fallback); explicit null is a deliberate
     * registered-only refusal.
     */
    target?: ComposerPresentationTarget | null;
}>): ComposerTransactionResultV1 {
    const { request } = input;
    const target = input.target === undefined ? readTarget(request.ref) : input.target;
    if (!target?.readSnapshot || !target.commitDocument) {
        return { status: 'composerUnavailable' };
    }
    const transaction = ComposerTransactionV1Schema.safeParse(request.transaction);
    if (!transaction.success) {
        return invalidOperation(0, 'invalid_transaction');
    }
    const snapshot = target.readSnapshot();
    if (snapshot.revision !== transaction.data.expectedRevision) {
        return { status: 'conflict', currentRevision: snapshot.revision };
    }
    if (!snapshot.state.editable) return { status: 'notEditable' };

    const text = resolveTextMutation({ snapshot, operations: transaction.data.operations });
    if (!text.ok) return text.result;
    const references = resolveReferences({
        snapshot,
        operations: transaction.data.operations,
        nextText: text.text,
        edits: text.edits,
    });
    if (!references.ok) return references.result;
    const attachments = resolveAttachments({
        target,
        snapshot,
        operations: transaction.data.operations,
        attachmentAuthorityResolver: input.attachmentAuthorityResolver,
        admittedContributor: input.admittedContributor,
        executionTarget: readComposerMediaExecutionTarget(input.executionTarget),
    });
    if (!attachments.ok) return attachments.result;
    const selection = clampSelection(snapshot.selection, text.text.length);

    const committed = target.commitDocument({
        expectedRevision: transaction.data.expectedRevision,
        mutation: {
            text: text.text,
            ...(selection ? { selection } : {}),
            references: references.references,
            attachments: attachments.attachments,
        },
    });
    if (committed.status !== 'applied') return committed;
    for (const released of readReleasedComposerStagedMediaHandles({
        composer: request.ref,
        previous: snapshot.attachments,
        next: attachments.attachments,
    })) {
        releaseComposerStagedMedia(released.handle, released.claimant);
    }
    if (target.commitDocumentEmitsChange !== true) emit(request.ref);
    return {
        status: 'applied',
        revision: committed.revision,
        ...(attachments.attachmentInstanceIds.length > 0
            ? { attachmentInstanceIds: [...attachments.attachmentInstanceIds] }
            : {}),
    };
}

/**
 * Creates the one attachment-capable document applier for a mounted Composer
 * composition. The composition owner supplies its current daemon-admitted
 * attachment projection once; individual control calls carry only their own
 * exact admitted contributor and an intact transaction.
 */
export function createComposerPresentationTransactionApplier(input: Readonly<{
    composerAttachmentsById: Readonly<Record<string, PluginUiComposerAttachmentProjection>>;
    /**
     * Resolves declared attachment titles for the current locale before they are
     * frozen into the persisted record. A composition that cannot reach the
     * translation projection keeps the author's declared fallback.
     */
    localize?: PluginLocalizedTextResolver;
}>): ComposerPresentationTransactionApplier {
    const attachmentAuthorityResolver = createAttachmentAuthorityResolver(input);
    return Object.freeze({
        apply: (request) => applyComposerPresentationTransactionAtOwner({
            request,
            attachmentAuthorityResolver,
            admittedContributor: request.admittedContributor,
            ...(request.executionTarget ? { executionTarget: request.executionTarget } : {}),
        }),
        resolveAttachmentIdentity: (request) => (
            attachmentAuthorityResolver(request)?.identity ?? null
        ),
    });
}

/**
 * The public direct entry point remains unprivileged for incumbent host paths
 * such as daemon text/reference transactions and host-owned attachment removal.
 * Attachment add/update requires a composition-bound applier above.
 */
export function applyComposerPresentationTransaction(
    request: ComposerPresentationTransactionRequest,
): ComposerTransactionResultV1 {
    return applyComposerPresentationTransactionAtOwner({
        request,
        attachmentAuthorityResolver: null,
        admittedContributor: null,
    });
}

/**
 * The daemon current-Session command is actionable only against the mounted
 * Session editor. Unlike the generic Composer Host API, it must not fall back
 * to an offscreen persisted draft when that visual target is absent.
 */
export function applyRegisteredSessionComposerPresentationTransaction(input: Readonly<{
    sessionId: string;
    transaction: unknown;
}>): ComposerTransactionResultV1 {
    const ref: ComposerRefV1 = { kind: 'session', sessionId: input.sessionId.trim() };
    return applyComposerPresentationTransactionAtOwner({
        request: { ref, transaction: input.transaction },
        attachmentAuthorityResolver: null,
        admittedContributor: null,
        target: readRegisteredTarget(ref),
    });
}

export function registerComposerPresentationTarget(
    ref: ComposerRefV1,
    target: ComposerPresentationTarget,
): () => void {
    const key = composerRefV1Key(ref);
    targets.set(key, target);
    emit(ref);
    return () => {
        if (targets.get(key) !== target) return;
        targets.delete(key);
        emit(ref);
    };
}

export function readComposerPresentationTarget(ref: ComposerRefV1): ComposerPresentationTargetRead | null {
    const target = readTarget(ref);
    return target ? Object.freeze({ revision: target.readRevision(), replace: target.replace }) : null;
}

/**
 * Returns the exact live document, or the current-account persisted Session
 * draft when that Session has no mounted visual owner.
 */
export function readComposerPresentationSnapshot(ref: ComposerRefV1): ComposerSnapshotV1 | null {
    return readTarget(ref)?.readSnapshot?.() ?? null;
}

/**
 * Scope adapters call this after their incumbent local draft owner advances
 * outside a registry transaction. Observation remains exact-ref scoped; this
 * is not a second document store or global invalidation channel.
 */
export function notifyComposerPresentationTargetChanged(ref?: ComposerRefV1): void {
    emit(ref);
}

function subscribePersistentSessionComposerTarget(
    ref: ComposerRefV1,
    listener: () => void,
): () => void {
    const sessionId = readPersistentSessionId(ref);
    const scope = capturePersistentSessionDraftScope(ref);
    if (!sessionId || !scope) return () => undefined;

    let signature = persistentSessionDraftStateSignature(scope, sessionId);
    const unsubscribeSemanticRevision = subscribeSessionDraft(scope, { kind: 'session', sessionId }, () => {
        // A mounted target owns its current visual document. Its registration
        // and retirement already emit through this module's one target map.
        if (readRegisteredTarget(ref)) return;
        listener();
    });
    const unsubscribeStorage = storage.subscribe(() => {
        const nextSignature = persistentSessionDraftStateSignature(scope, sessionId);
        if (nextSignature === signature) return;
        signature = nextSignature;
        if (readRegisteredTarget(ref)) return;
        listener();
    });
    return () => {
        unsubscribeSemanticRevision();
        unsubscribeStorage();
    };
}

/**
 * Scoped observation remains part of the one document registry. It never
 * subscribes the Session screen to every plugin surface: an observer receives
 * only a change for its exact `ComposerRefV1` and disposal removes that local
 * listener without touching the target or another observer.
 */
export function subscribeComposerPresentationTarget(
    ref: ComposerRefV1,
    listener: () => void,
): () => void {
    const key = composerRefV1Key(ref);
    const scopedListeners = listenersByTargetKey.get(key) ?? new Set<() => void>();
    scopedListeners.add(listener);
    listenersByTargetKey.set(key, scopedListeners);
    const unsubscribePersistentSession = ref.kind === 'session'
        ? subscribePersistentSessionComposerTarget(ref, listener)
        : () => undefined;
    return () => {
        unsubscribePersistentSession();
        const current = listenersByTargetKey.get(key);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) listenersByTargetKey.delete(key);
    };
}

export type ComposerPresentationHostHandlers = Pick<
    PluginSurfaceHostApiHandlers,
    | 'activeComposer'
    | 'readComposer'
    | 'watchComposer'
    | 'applyComposer'
    | 'focusComposer'
    | 'setComposerDecorations'
    | 'acquireComposerInputLock'
    | 'disposeHostResource'
    | 'pickComposerMedia'
    | 'inspectComposerContent'
    | 'releaseComposerContent'
> & Readonly<{
    /** Retires this mounted surface's ephemeral decorations and lock leases. */
    dispose: () => void;
}>;

export type CreateComposerPresentationHostHandlersInput = Readonly<{
    /**
     * This must come from the mounted surface's admitted contribution and
     * generation, never an author payload. Invalid source facts install no
     * Composer methods so capability negotiation stays factual.
     */
    owner: ComposerPresentationHostOwner;
    /**
     * The current Composer composition's closed attachment authority. The
     * mount derives it once from its admitted projection; this factory never
     * reconstructs a catalog or accepts it from a Host API request.
     */
    transactionApplier?: ComposerPresentationTransactionApplier;
    /**
     * The mount's exact daemon target. Without a real target-bound transfer
     * port the media methods remain uninstalled rather than simulating a
     * capability against an arbitrary active machine.
     */
    executionTarget?: SessionExecutionTargetV1;
    /** The bound surface controller's one mount-currentness predicate. */
    isCurrent?: () => boolean;
    /**
     * The physical transport supplies its one existing subscription sink. The
     * document owner never owns a second wire registry or event queue.
     */
    publishComposerSnapshot?: (event: Readonly<{
        subscriptionId: string;
        snapshot: ComposerSnapshotV1;
    }>) => void;
}>;

type ActiveComposerDecoration = Readonly<{
    entryKey: string;
    targetKey: string;
    ref: ComposerRefV1;
    target: ComposerPresentationTarget;
    key: string;
    decorations: ComposerDecorationSetV1;
}>;

type ActiveComposerInputLock = Readonly<{
    subscriptionId: string;
    targetKey: string;
    ref: ComposerRefV1;
    target: ComposerPresentationTarget;
    release: () => void;
}>;

type ActiveComposerObservation = Readonly<{
    subscriptionId: string;
    ref: ComposerRefV1;
    dispose: () => void;
}>;

function composerHostUnavailable(reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('unavailable', [reason]);
}

function composerHostInvalidPayload(reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('invalid_payload', [reason]);
}

function composerHostStaleSurface(): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
}

function composerHostRequestRefusal(
    input: CreateComposerPresentationHostHandlersInput,
    options: PluginSurfaceHostApiRequestOptions | undefined,
    cancellationReason: string,
): PluginUiJsonValueV1 | null {
    if (options?.signal?.aborted) return composerHostUnavailable(cancellationReason);
    if (input.isCurrent?.() === false) return composerHostStaleSurface();
    return null;
}

function normalizeComposerPresentationHostOwner(
    raw: ComposerPresentationHostOwner,
): ComposerPresentationHostOwner | null {
    const pluginId = typeof raw?.identity?.pluginId === 'string' ? raw.identity.pluginId.trim() : '';
    const localId = typeof raw?.identity?.localId === 'string' ? raw.identity.localId.trim() : '';
    const immutableGenerationId = typeof raw?.immutableGenerationId === 'string'
        ? raw.immutableGenerationId.trim()
        : '';
    const surfaceInstanceKey = typeof raw?.surfaceInstanceKey === 'string'
        ? raw.surfaceInstanceKey.trim()
        : '';
    if (!pluginId || !localId || !immutableGenerationId || !surfaceInstanceKey) return null;
    return Object.freeze({
        identity: Object.freeze({ pluginId, localId }),
        immutableGenerationId,
        surfaceInstanceKey,
    });
}

function readComposerMediaExecutionTarget(
    raw: SessionExecutionTargetV1 | undefined,
): SessionExecutionTargetV1 | null {
    const serverId = raw?.serverId;
    const machineId = raw?.machineId;
    if (
        typeof serverId !== 'string'
        || typeof machineId !== 'string'
        || serverId.trim().length === 0
        || machineId.trim().length === 0
        || serverId !== serverId.trim()
        || machineId !== machineId.trim()
    ) {
        return null;
    }
    return Object.freeze({ serverId, machineId });
}

function equalComposerMediaExecutionTarget(
    left: SessionExecutionTargetV1,
    right: SessionExecutionTargetV1,
): boolean {
    return left.serverId === right.serverId && left.machineId === right.machineId;
}

function readComposerHostPayload(
    value: PluginUiJsonValueV1 | undefined,
): Readonly<Record<string, PluginUiJsonValueV1>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Readonly<Record<string, PluginUiJsonValueV1>>;
}

function readComposerSnapshot(target: ComposerPresentationTarget): ComposerSnapshotV1 | null {
    try {
        return target.readSnapshot?.() ?? null;
    } catch {
        return null;
    }
}

function decorationsFitSnapshot(
    decorations: ComposerDecorationSetV1,
    snapshot: ComposerSnapshotV1,
): boolean {
    return decorations.ranges.every(({ range }) => (
        range.start >= 0
        && range.end >= range.start
        && range.end <= snapshot.text.length
    ));
}

function decorationEntryKey(targetKey: string, key: string): string {
    return `${targetKey}${encodePart(key)}`;
}

/**
 * The composer-side portion of the one mounted Host API. This is deliberately
 * a handler bundle, not another Host API factory or transport: the bound
 * controller retains factual method negotiation, request routing, and the one
 * generic `disposeHostResource` operation.
 */
export function createComposerPresentationHostHandlers(
    input: CreateComposerPresentationHostHandlersInput,
): ComposerPresentationHostHandlers {
    const owner = normalizeComposerPresentationHostOwner(input.owner);
    if (!owner) {
        return Object.freeze({
            dispose: () => {},
        } satisfies ComposerPresentationHostHandlers);
    }
    const activeOwner = owner;

    const decorations = new Map<string, ActiveComposerDecoration>();
    const locks = new Map<string, ActiveComposerInputLock>();
    const observations = new Map<string, ActiveComposerObservation>();
    const targetObservers = new Map<string, Readonly<{ dispose: () => void }>>();
    const admittedContributor: ComposerPresentationAdmittedContributor = Object.freeze({
        identity: activeOwner.identity,
        immutableGenerationId: activeOwner.immutableGenerationId,
    });
    const composerMediaExecutionTarget = readComposerMediaExecutionTarget(input.executionTarget);
    const composerMediaTransactionApplier = input.transactionApplier;
    let disposed = false;

    function requestRefusal(
        options: PluginSurfaceHostApiRequestOptions | undefined,
        cancellationReason: string,
    ): PluginUiJsonValueV1 | null {
        if (disposed) return composerHostStaleSurface();
        return composerHostRequestRefusal(input, options, cancellationReason);
    }

    function readAdmittedComposerMediaAttachmentOwner(attachmentLocalId: string): PluginContributionIdentityV1 | null {
        return composerMediaTransactionApplier?.resolveAttachmentIdentity({
            attachmentLocalId,
            admittedContributor,
        }) ?? null;
    }

    function isMountedComposerMediaHandle(handle: ComposerContentHandleV1): boolean {
        if (
            !composerMediaExecutionTarget
            || !composerMediaTransactionApplier
            || !equalComposerMediaExecutionTarget(handle.executionTarget, composerMediaExecutionTarget)
        ) {
            return false;
        }
        const ownerForAttachment = readAdmittedComposerMediaAttachmentOwner(handle.owner.localId);
        return ownerForAttachment !== null && equalContributionIdentity(handle.owner, ownerForAttachment);
    }

    function refHasActiveEffects(targetKey: string): boolean {
        for (const decoration of decorations.values()) {
            if (decoration.targetKey === targetKey) return true;
        }
        for (const lock of locks.values()) {
            if (lock.targetKey === targetKey) return true;
        }
        return false;
    }

    function clearDecoration(decoration: ActiveComposerDecoration): void {
        try {
            decoration.target.setComposerDecorations?.({
                owner: activeOwner,
                key: decoration.key,
                decorations: null,
            });
        } catch {
            // Retirement is final even when an incumbent visual adapter has
            // already unmounted; stale visual state must not keep a lease alive.
        }
    }

    function stopObservingIfUnused(ref: ComposerRefV1): void {
        const targetKey = composerRefV1Key(ref);
        if (refHasActiveEffects(targetKey)) return;
        targetObservers.get(targetKey)?.dispose();
        targetObservers.delete(targetKey);
    }

    function releaseInputLock(subscriptionId: string, notify: boolean): void {
        const lock = locks.get(subscriptionId);
        if (!lock) return;
        locks.delete(subscriptionId);
        try {
            lock.release();
        } catch {
            // The host has retired this lease regardless of a stale adapter's
            // cleanup result; no later disposer may revive it.
        }
        stopObservingIfUnused(lock.ref);
        if (notify && readTarget(lock.ref) === lock.target) emit(lock.ref);
    }

    function releaseComposerObservation(
        subscriptionId: string,
        expected?: ActiveComposerObservation,
    ): void {
        const observation = observations.get(subscriptionId);
        if (!observation || (expected && observation !== expected)) return;
        observations.delete(subscriptionId);
        observation.dispose();
    }

    function publishComposerObservation(subscriptionId: string, ref: ComposerRefV1): void {
        if (disposed || input.isCurrent?.() === false) {
            releaseComposerObservation(subscriptionId);
            return;
        }
        const snapshot = readComposerPresentationSnapshot(ref);
        if (!snapshot) {
            releaseComposerObservation(subscriptionId);
            return;
        }
        try {
            input.publishComposerSnapshot?.({ subscriptionId, snapshot });
        } catch {
            // A transport delivery failure cannot keep a stale semantic
            // observer attached to the document registry.
            releaseComposerObservation(subscriptionId);
        }
    }

    function reconcileTargetEffects(ref: ComposerRefV1): void {
        const targetKey = composerRefV1Key(ref);
        const currentTarget = readTarget(ref);
        const currentSnapshot = currentTarget ? readComposerSnapshot(currentTarget) : null;

        for (const [entryKey, decoration] of [...decorations]) {
            if (decoration.targetKey !== targetKey) continue;
            if (
                currentTarget !== decoration.target
                || !currentSnapshot
                || currentSnapshot.revision !== decoration.decorations.revision
            ) {
                decorations.delete(entryKey);
                clearDecoration(decoration);
            }
        }
        for (const [subscriptionId, lock] of [...locks]) {
            if (lock.targetKey !== targetKey || currentTarget === lock.target) continue;
            releaseInputLock(subscriptionId, false);
        }
        stopObservingIfUnused(ref);
    }

    function ensureObserving(ref: ComposerRefV1): void {
        const targetKey = composerRefV1Key(ref);
        if (targetObservers.has(targetKey)) return;
        targetObservers.set(targetKey, Object.freeze({
            dispose: subscribeComposerPresentationTarget(ref, () => {
                reconcileTargetEffects(ref);
            }),
        }));
    }

    const handlers = {
        activeComposer: (
            _request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 => {
            const refusal = requestRefusal(options, 'composer_active_cancelled');
            if (refusal) return refusal;
            let active: ComposerRefV1 | null = null;
            for (const [targetKey, target] of targets) {
                if (!isComposerPresentationTargetCurrent(target)) continue;
                const snapshot = readComposerSnapshot(target);
                if (!snapshot?.state.focused) continue;
                // A snapshot reader can synchronously cause a scope replacement.
                // Never let the just-retired target participate in active lookup.
                if (targets.get(targetKey) !== target || !isComposerPresentationTargetCurrent(target)) continue;
                if (active !== null) return null;
                active = snapshot.ref;
            }
            return active;
        },
        readComposer: (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 => {
            const refusal = requestRefusal(options, 'composer_read_cancelled');
            if (refusal) return refusal;
            const parsed = PluginUiReadComposerRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return composerHostInvalidPayload('composer_read_payload_invalid');
            const snapshot = readComposerPresentationSnapshot(parsed.data.ref);
            return PluginUiJsonValueV1Schema.parse(snapshot
                ? { status: 'ready', snapshot }
                : { status: 'unavailable', reason: 'scopeClosed' });
        },
        ...(input.publishComposerSnapshot
            ? {
                watchComposer: (
                    request: PluginUiHostApiRequestEnvelopeV1,
                    options?: PluginSurfaceHostApiRequestOptions,
                ): PluginUiJsonValueV1 => {
                    const refusal = requestRefusal(options, 'composer_watch_cancelled');
                    if (refusal) return refusal;
                    const rawPayload = readComposerHostPayload(request.payload);
                    if (!rawPayload || typeof rawPayload.subscriptionId !== 'string' || !rawPayload.subscriptionId.trim()) {
                        return composerHostInvalidPayload('composer_watch_subscription_invalid');
                    }
                    const { subscriptionId: rawSubscriptionId, ...watchPayload } = rawPayload;
                    const subscriptionId = rawSubscriptionId.trim();
                    const parsed = PluginUiWatchComposerRequestV1Schema.safeParse(watchPayload);
                    if (!parsed.success) return composerHostInvalidPayload('composer_watch_payload_invalid');
                    if (observations.has(subscriptionId)) {
                        return composerHostInvalidPayload('composer_watch_subscription_reused');
                    }
                    if (!readComposerPresentationSnapshot(parsed.data.ref)) {
                        return composerHostUnavailable('composer_watch_unavailable');
                    }
                    let observation: ActiveComposerObservation | null = null;
                    const onAbort = (): void => {
                        if (observation) releaseComposerObservation(subscriptionId, observation);
                    };
                    const unsubscribe = subscribeComposerPresentationTarget(parsed.data.ref, () => {
                        publishComposerObservation(subscriptionId, parsed.data.ref);
                    });
                    observation = Object.freeze({
                        subscriptionId,
                        ref: parsed.data.ref,
                        dispose: () => {
                            options?.signal?.removeEventListener('abort', onAbort);
                            unsubscribe();
                        },
                    });
                    observations.set(subscriptionId, observation);
                    options?.signal?.addEventListener('abort', onAbort, { once: true });
                    if (options?.signal?.aborted || input.isCurrent?.() === false) {
                        releaseComposerObservation(subscriptionId, observation);
                        return options?.signal?.aborted
                            ? composerHostUnavailable('composer_watch_cancelled')
                            : composerHostStaleSurface();
                    }
                    return null;
                },
            }
            : {}),
        applyComposer: (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 => {
            const refusal = requestRefusal(options, 'composer_apply_cancelled');
            if (refusal) return refusal;
            const parsed = PluginUiApplyComposerRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return composerHostInvalidPayload('composer_apply_payload_invalid');
            return PluginUiJsonValueV1Schema.parse(input.transactionApplier
                ? input.transactionApplier.apply({
                    ref: parsed.data.ref,
                    admittedContributor,
                    transaction: parsed.data.transaction,
                    ...(composerMediaExecutionTarget
                        ? { executionTarget: composerMediaExecutionTarget }
                        : {}),
                })
                : applyComposerPresentationTransaction(parsed.data));
        },
        ...(composerMediaExecutionTarget && composerMediaTransactionApplier
            ? {
                pickComposerMedia: async (
                    request: PluginUiHostApiRequestEnvelopeV1,
                    options?: PluginSurfaceHostApiRequestOptions,
                ): Promise<PluginUiJsonValueV1> => {
                    const refusal = requestRefusal(options, 'composer_media_pick_cancelled');
                    if (refusal) return refusal;
                    const parsed = PluginUiPickComposerMediaRequestV1Schema.safeParse(request.payload);
                    if (!parsed.success) return composerHostInvalidPayload('composer_media_pick_payload_invalid');
                    const attachmentOwner = readAdmittedComposerMediaAttachmentOwner(
                        parsed.data.request.attachmentLocalId,
                    );
                    if (!attachmentOwner) return composerHostUnavailable('composer_media_attachment_unavailable');

                    try {
                        const availability = await getComposerMediaContentAvailability({
                            executionTarget: composerMediaExecutionTarget,
                            signal: options?.signal ?? null,
                        });
                        if (!availability.available) {
                            return composerHostUnavailable('composer_media_capability_unavailable');
                        }
                    } catch {
                        return composerHostUnavailable('composer_media_capability_unavailable');
                    }
                    // Capability negotiation is asynchronous. Recheck the same
                    // mount before selection so a retired host cannot open its
                    // picker after the target daemon answered.
                    const capabilityRefusal = requestRefusal(options, 'composer_media_pick_cancelled');
                    if (capabilityRefusal) return capabilityRefusal;

                    let staged: ComposerContentHandleV1 | null;
                    try {
                        staged = await pickAndStageComposerMedia({
                            executionTarget: composerMediaExecutionTarget,
                            owner: attachmentOwner,
                            kinds: parsed.data.request.kinds,
                            signal: options?.signal ?? null,
                        });
                    } catch {
                        return composerHostUnavailable('composer_media_stage_unavailable');
                    }
                    if (!staged) return composerHostUnavailable('composer_media_stage_unavailable');

                    const canonicalStage = ComposerContentHandleV1Schema.safeParse(staged);
                    if (!canonicalStage.success || !isMountedComposerMediaHandle(canonicalStage.data)) {
                        return composerHostUnavailable('composer_media_stage_unavailable');
                    }
                    if (!parsed.data.request.kinds.includes(canonicalStage.data.mediaKind)) {
                        releaseComposerStagedMedia(canonicalStage.data);
                        return composerHostUnavailable('composer_media_stage_unavailable');
                    }
                    const lateRefusal = requestRefusal(options, 'composer_media_pick_cancelled');
                    if (lateRefusal) {
                        releaseComposerStagedMedia(canonicalStage.data);
                        return lateRefusal;
                    }
                    return PluginUiJsonValueV1Schema.parse(canonicalStage.data);
                },
                inspectComposerContent: async (
                    request: PluginUiHostApiRequestEnvelopeV1,
                    options?: PluginSurfaceHostApiRequestOptions,
                ): Promise<PluginUiJsonValueV1> => {
                    const refusal = requestRefusal(options, 'composer_media_inspect_cancelled');
                    if (refusal) return refusal;
                    const parsed = PluginUiInspectComposerContentRequestV1Schema.safeParse(request.payload);
                    if (!parsed.success) return composerHostInvalidPayload('composer_media_inspect_payload_invalid');
                    if (!isMountedComposerMediaHandle(parsed.data.handle)) {
                        return composerHostUnavailable('composer_media_inspect_unavailable');
                    }
                    let inspection: Awaited<ReturnType<typeof inspectComposerContent>>;
                    try {
                        inspection = await inspectComposerContent(
                            parsed.data.handle,
                            parsed.data.request,
                            options?.signal ? { signal: options.signal } : undefined,
                        );
                    } catch {
                        return composerHostUnavailable('composer_media_inspect_unavailable');
                    }
                    if (!inspection.success) return composerHostUnavailable('composer_media_inspect_unavailable');
                    const result = PluginUiInspectComposerContentResultV1Schema.safeParse(inspection.result);
                    if (!result.success) return composerHostUnavailable('composer_media_inspect_unavailable');
                    const lateRefusal = requestRefusal(options, 'composer_media_inspect_cancelled');
                    if (lateRefusal) return lateRefusal;
                    return PluginUiJsonValueV1Schema.parse(result.data);
                },
                releaseComposerContent: async (
                    request: PluginUiHostApiRequestEnvelopeV1,
                    options?: PluginSurfaceHostApiRequestOptions,
                ): Promise<PluginUiJsonValueV1> => {
                    const refusal = requestRefusal(options, 'composer_media_release_cancelled');
                    if (refusal) return refusal;
                    const parsed = PluginUiReleaseComposerContentRequestV1Schema.safeParse(request.payload);
                    if (!parsed.success) return composerHostInvalidPayload('composer_media_release_payload_invalid');
                    if (!isMountedComposerMediaHandle(parsed.data.handle)) {
                        return composerHostUnavailable('composer_media_release_unavailable');
                    }
                    try {
                        const released = await releaseComposerContent(
                            parsed.data.handle,
                            options?.signal ? { signal: options.signal } : undefined,
                        );
                        return released.success
                            ? null
                            : composerHostUnavailable('composer_media_release_unavailable');
                    } catch {
                        return composerHostUnavailable('composer_media_release_unavailable');
                    }
                },
            }
            : {}),
        focusComposer: (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 => {
            const refusal = requestRefusal(
                options,
                'composer_focus_cancelled',
            );
            if (refusal) return refusal;
            const parsed = PluginUiFocusComposerRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return composerHostInvalidPayload('composer_focus_payload_invalid');
            const target = readTarget(parsed.data.ref);
            if (!target?.focusComposer) return { status: 'unavailable', reason: 'scopeClosed' };
            if (readComposerSnapshot(target)?.state.editable === false) {
                return { status: 'notEditable' };
            }
            try {
                const focused = target.focusComposer();
                // Focus can synchronously trigger an unmount, account retirement,
                // or target replacement. Its success is not valid for a scope that
                // no longer owns the exact requested ref.
                if (readTarget(parsed.data.ref) !== target) {
                    return { status: 'unavailable', reason: 'scopeClosed' };
                }
                return focused === false
                    ? { status: 'notEditable' }
                    : { status: 'focused' };
            } catch {
                return composerHostUnavailable('composer_focus_unavailable');
            }
        },
        setComposerDecorations: (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 => {
            const refusal = requestRefusal(
                options,
                'composer_decoration_cancelled',
            );
            if (refusal) return refusal;
            const parsed = PluginUiSetComposerDecorationsRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return composerHostInvalidPayload('composer_decoration_payload_invalid');
            const target = readTarget(parsed.data.ref);
            if (!target?.setComposerDecorations) return { status: 'unavailable', reason: 'scopeClosed' };
            const targetKey = composerRefV1Key(parsed.data.ref);
            const entryKey = decorationEntryKey(targetKey, parsed.data.key);
            const previous = decorations.get(entryKey);

            if (parsed.data.decorations === null) {
                try {
                    target.setComposerDecorations({
                        owner: activeOwner,
                        key: parsed.data.key,
                        decorations: null,
                    });
                } catch {
                    return composerHostUnavailable('composer_decoration_unavailable');
                }
                decorations.delete(entryKey);
                if (previous && previous.target !== target) clearDecoration(previous);
                stopObservingIfUnused(parsed.data.ref);
                return { status: 'cleared' };
            }

            const snapshot = readComposerSnapshot(target);
            if (!snapshot) return { status: 'unavailable', reason: 'scopeClosed' };
            if (snapshot.revision !== parsed.data.decorations.revision) {
                return { status: 'staleRevision', currentRevision: snapshot.revision };
            }
            if (!decorationsFitSnapshot(parsed.data.decorations, snapshot)) return { status: 'invalid' };

            decorations.set(entryKey, {
                entryKey,
                targetKey,
                ref: parsed.data.ref,
                target,
                key: parsed.data.key,
                decorations: parsed.data.decorations,
            });
            try {
                target.setComposerDecorations({
                    owner: activeOwner,
                    key: parsed.data.key,
                    decorations: parsed.data.decorations,
                });
            } catch {
                decorations.delete(entryKey);
                if (previous) clearDecoration(previous);
                stopObservingIfUnused(parsed.data.ref);
                return composerHostUnavailable('composer_decoration_unavailable');
            }
            if (previous && previous.target !== target) clearDecoration(previous);
            ensureObserving(parsed.data.ref);
            return { status: 'set' };
        },
        acquireComposerInputLock: (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 => {
            const refusal = requestRefusal(
                options,
                'composer_input_lock_cancelled',
            );
            if (refusal) return refusal;
            const rawPayload = readComposerHostPayload(request.payload);
            if (!rawPayload || typeof rawPayload.subscriptionId !== 'string' || !rawPayload.subscriptionId.trim()) {
                return composerHostInvalidPayload('composer_input_lock_subscription_invalid');
            }
            const { subscriptionId: rawSubscriptionId, ...leasePayload } = rawPayload;
            const subscriptionId = rawSubscriptionId.trim();
            const parsed = PluginUiAcquireComposerInputLockRequestV1Schema.safeParse(leasePayload);
            if (!parsed.success) return composerHostInvalidPayload('composer_input_lock_payload_invalid');
            if (locks.has(subscriptionId)) {
                return composerHostInvalidPayload('composer_input_lock_subscription_reused');
            }
            const target = readTarget(parsed.data.ref);
            if (!target?.acquireComposerInputLock) return composerHostUnavailable('composer_input_lock_unavailable');
            let release: (() => void) | null = null;
            try {
                release = target.acquireComposerInputLock({
                    owner: activeOwner,
                    subscriptionId,
                    request: parsed.data.request,
                });
            } catch {
                return composerHostUnavailable('composer_input_lock_unavailable');
            }
            if (typeof release !== 'function') return composerHostUnavailable('composer_input_lock_unavailable');

            const lock: ActiveComposerInputLock = {
                subscriptionId,
                targetKey: composerRefV1Key(parsed.data.ref),
                ref: parsed.data.ref,
                target,
                release,
            };
            locks.set(subscriptionId, lock);
            ensureObserving(parsed.data.ref);
            const lateRefusal = requestRefusal(
                options,
                'composer_input_lock_cancelled',
            );
            if (lateRefusal || readTarget(parsed.data.ref) !== target) {
                releaseInputLock(subscriptionId, false);
                return lateRefusal ?? composerHostUnavailable('composer_input_lock_unavailable');
            }
            emit(parsed.data.ref);
            // Input locks use the established subscription acknowledgement; no
            // composer event or bespoke lock result is emitted here.
            return null;
        },
        disposeHostResource: (
            request: PluginUiHostApiRequestEnvelopeV1,
        ): PluginUiJsonValueV1 => {
            if (disposed || input.isCurrent?.() === false) return composerHostStaleSurface();
            const parsed = PluginUiDisposeHostResourceRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) {
                return composerHostInvalidPayload('composer_input_lock_dispose_payload_invalid');
            }
            releaseComposerObservation(parsed.data.subscriptionId);
            releaseInputLock(parsed.data.subscriptionId, true);
            // Unknown ids belong to another installed disposer (or were already
            // retired); generic disposal is intentionally idempotent.
            return null;
        },
    } satisfies Pick<
        PluginSurfaceHostApiHandlers,
        | 'activeComposer'
        | 'readComposer'
        | 'watchComposer'
        | 'applyComposer'
        | 'focusComposer'
        | 'setComposerDecorations'
        | 'acquireComposerInputLock'
        | 'disposeHostResource'
        | 'pickComposerMedia'
        | 'inspectComposerContent'
        | 'releaseComposerContent'
    >;

    return Object.freeze({
        ...handlers,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            const refsToNotify = new Map<string, ComposerRefV1>();
            for (const lock of [...locks.values()]) {
                if (readTarget(lock.ref) === lock.target) refsToNotify.set(lock.targetKey, lock.ref);
                releaseInputLock(lock.subscriptionId, false);
            }
            for (const observation of [...observations.values()]) {
                releaseComposerObservation(observation.subscriptionId);
            }
            for (const [entryKey, decoration] of [...decorations]) {
                decorations.delete(entryKey);
                clearDecoration(decoration);
                stopObservingIfUnused(decoration.ref);
            }
            for (const observer of targetObservers.values()) observer.dispose();
            targetObservers.clear();
            for (const ref of refsToNotify.values()) emit(ref);
        },
    } satisfies ComposerPresentationHostHandlers);
}

/**
 * Compatibility wrappers for the incumbent daemon presentation channel. They
 * delegate into the exact-ref registry; no Session-only map remains active.
 */
export function registerSessionComposerPresentationTarget(
    sessionIdRaw: string,
    target: ComposerPresentationTarget,
): () => void {
    return registerComposerPresentationTarget({ kind: 'session', sessionId: sessionIdRaw.trim() }, target);
}

export function readSessionComposerPresentationTarget(sessionIdRaw: string): ComposerPresentationTargetRead | null {
    const ref: ComposerRefV1 = { kind: 'session', sessionId: sessionIdRaw.trim() };
    const target = readRegisteredTarget(ref);
    return target ? Object.freeze({ revision: target.readRevision(), replace: target.replace }) : null;
}

export function notifySessionComposerPresentationTargetChanged(sessionIdRaw?: string): void {
    const sessionId = sessionIdRaw?.trim();
    notifyComposerPresentationTargetChanged(sessionId ? { kind: 'session', sessionId } : undefined);
}

export function subscribeSessionComposerPresentationTargets(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
