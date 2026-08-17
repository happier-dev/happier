import type {
    ComposerAttachmentViewV1,
    ComposerContentHandleV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import {
    admitMentionRefsV1ForText,
    ComposerContentHandleV1Schema,
    SessionExecutionTargetV1Schema,
} from '@happier-dev/protocol';

import { getComposerMediaContentAvailability } from '@/sync/domains/transfers/runtime/transferRuntime';

type ComposerMentionRef = ComposerSnapshotV1['references'][number];

export type ComposerSubmissionSnapshot = Readonly<{
    ref: ComposerRefV1;
    revision: number;
    text: string;
    references: readonly ComposerMentionRef[];
    attachments: readonly ComposerAttachmentViewV1[];
}>;

export type ComposerSubmissionAdmissionOutcome =
    | Readonly<{ status: 'accepted' }>
    | Readonly<{ status: 'rejected' }>;

/**
 * The incumbent admission owner invokes this exactly when its Message/Pending
 * handoff becomes durable. Keeping this callback coordinator-owned preserves
 * the existing handoff timing without giving a route its own clear authority.
 */
export type ComposerSubmissionAdmissionHandoff = Readonly<{
    accept: () => boolean;
}>;

type ComposerSubmissionAdmissionDelegate = (
    snapshot: ComposerSubmissionSnapshot,
    handoff: ComposerSubmissionAdmissionHandoff,
) => Promise<ComposerSubmissionAdmissionOutcome> | ComposerSubmissionAdmissionOutcome;

type ComposerSubmissionRouteForKind<Kind extends ComposerRefV1['kind']> = Readonly<{
    kind: Kind;
    /** The exact document owner whose admission delegate is being invoked. */
    ref: Extract<ComposerRefV1, Readonly<{ kind: Kind }>>;
    /**
     * The route's exact Session target at the moment canonical admission is
     * about to begin. Staged media fails closed when this value is absent,
     * malformed, or no longer matches its transfer-owned handle.
     */
    readCurrentExecutionTarget?: () => unknown;
    admit: ComposerSubmissionAdmissionDelegate;
}>;

export type ComposerSubmissionRoute =
    | ComposerSubmissionRouteForKind<'session'>
    | ComposerSubmissionRouteForKind<'newSession'>
    | ComposerSubmissionRouteForKind<'participantMessage'>
    | ComposerSubmissionRouteForKind<'pendingMessage'>;

export type ComposerSubmissionResult =
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'notSendable'; snapshot: ComposerSubmissionSnapshot }>
    | Readonly<{
        status: 'blocked';
        reason: 'attachmentUnavailable' | 'mediaContentUnavailable' | 'scopeMismatch';
        snapshot: ComposerSubmissionSnapshot;
    }>
    | Readonly<{ status: 'rejected'; snapshot: ComposerSubmissionSnapshot }>
    | Readonly<{ status: 'accepted'; snapshot: ComposerSubmissionSnapshot; cleared: boolean }>;

export type ComposerSubmissionFieldCurrentness = Readonly<{
    text: boolean;
    references: boolean;
    attachments: boolean;
    /** The text that remains once an accepted snapshot clears only its current text field. */
    reconciledText: string;
    /** Current references that still name an exact token in `reconciledText`. */
    reconciledReferences: readonly ComposerMentionRef[];
}>;

/**
 * Detach exactly the semantic fields that canonical admission consumes. The
 * document owner may keep evolving after this point; its later bytes must not
 * alter the admitted attempt or be cleared by it.
 */
export function captureComposerSubmissionSnapshot(snapshot: ComposerSnapshotV1 | null): ComposerSubmissionSnapshot | null {
    if (!snapshot) return null;
    return structuredClone({
        ref: snapshot.ref,
        revision: snapshot.revision,
        text: snapshot.text,
        references: snapshot.references,
        attachments: snapshot.attachments,
    });
}

function sameComposerRef(left: ComposerRefV1, right: ComposerRefV1): boolean {
    if (left.kind !== right.kind) return false;

    switch (left.kind) {
        case 'session':
            return right.kind === 'session' && left.sessionId === right.sessionId;
        case 'newSession':
            return right.kind === 'newSession' && left.instanceId === right.instanceId;
        case 'pendingMessage':
            return right.kind === 'pendingMessage'
                && left.sessionId === right.sessionId
                && left.localId === right.localId;
        case 'participantMessage':
            return right.kind === 'participantMessage'
                && left.sessionId === right.sessionId
                && left.instanceId === right.instanceId;
        default:
            return false;
    }
}

function sameComposerReferenceContent(
    left: readonly ComposerMentionRef[],
    right: readonly ComposerMentionRef[],
): boolean {
    return left.length === right.length && left.every((reference, index) => {
        const other = right[index];
        return other !== undefined
            && reference.kind === other.kind
            && reference.ref === other.ref
            && reference.token === other.token
            && reference.label === other.label;
    });
}

/**
 * One document revision covers all three semantic fields, so it cannot decide
 * whether an accepted snapshot may clear one field after another changed.
 * This owner compares each captured field independently while retaining exact
 * document identity as the admission boundary.
 */
export function readComposerSubmissionFieldCurrentness(
    current: ComposerSnapshotV1,
    accepted: ComposerSubmissionSnapshot,
    options?: Readonly<{
        /** Pending-edit acceptance restores the previous ordinary draft rather than clearing text. */
        acceptedTextReplacement?: string;
    }>,
): ComposerSubmissionFieldCurrentness | null {
    if (!sameComposerRef(current.ref, accepted.ref)) return null;
    const text = current.text === accepted.text;
    const reconciledText = text ? (options?.acceptedTextReplacement ?? '') : current.text;
    const admittedReferences = new Set(admitMentionRefsV1ForText(reconciledText, current.references));
    return {
        text,
        references: sameComposerReferenceContent(current.references, accepted.references),
        attachments: JSON.stringify(current.attachments) === JSON.stringify(accepted.attachments),
        reconciledText,
        // Retain the live reference objects rather than reconstructing a new
        // positionless shape: scope owners turn these back through their
        // incumbent semantic writer, which preserves rich current metadata.
        reconciledReferences: current.references.filter((reference) => admittedReferences.has(reference)),
    };
}

function isSubmissionRouteForSnapshot(
    snapshot: ComposerSubmissionSnapshot,
    route: ComposerSubmissionRoute,
): boolean {
    return snapshot.ref.kind === route.kind && sameComposerRef(snapshot.ref, route.ref);
}

function hasUnavailableAttachment(snapshot: ComposerSubmissionSnapshot): boolean {
    return snapshot.attachments.some((attachment) => attachment.availability.status !== 'ready');
}

function isTextlessAndAttachmentless(snapshot: ComposerSubmissionSnapshot): boolean {
    return snapshot.text.trim().length === 0 && snapshot.attachments.length === 0;
}

type StagedMediaHandleRead =
    | Readonly<{ status: 'none' }>
    | Readonly<{ status: 'invalid' }>
    | Readonly<{ status: 'ready'; handles: readonly ComposerContentHandleV1[] }>;

function readStagedMediaHandles(snapshot: ComposerSubmissionSnapshot): StagedMediaHandleRead {
    const handles: ComposerContentHandleV1[] = [];
    for (const attachment of snapshot.attachments) {
        const content = attachment.content;
        if (content === undefined) continue;
        if (content === null || typeof content !== 'object' || content.kind !== 'stagedMedia') {
            return { status: 'invalid' };
        }
        const parsedHandle = ComposerContentHandleV1Schema.safeParse(content.handle);
        if (!parsedHandle.success) return { status: 'invalid' };
        handles.push(parsedHandle.data);
    }
    return handles.length === 0 ? { status: 'none' } : { status: 'ready', handles };
}

function readCurrentExecutionTarget(route: ComposerSubmissionRoute): SessionExecutionTargetV1 | null {
    if (!route.readCurrentExecutionTarget) return null;
    try {
        const parsed = SessionExecutionTargetV1Schema.safeParse(route.readCurrentExecutionTarget());
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function sameExecutionTarget(left: SessionExecutionTargetV1, right: SessionExecutionTargetV1): boolean {
    return left.serverId === right.serverId && left.machineId === right.machineId;
}

/**
 * This is deliberately coordinator-owned rather than a picker or route-local
 * cache: a staged handle is usable only on the same current target that
 * negotiated the daemon operation immediately before canonical admission.
 */
async function isStagedMediaAdmissionAvailable(
    handles: readonly ComposerContentHandleV1[],
    route: ComposerSubmissionRoute,
): Promise<boolean> {
    const executionTarget = readCurrentExecutionTarget(route);
    if (!executionTarget || handles.some((handle) => !sameExecutionTarget(handle.executionTarget, executionTarget))) {
        return false;
    }

    try {
        const availability = await getComposerMediaContentAvailability({ executionTarget });
        // Re-read the route-owned target after the asynchronous boundary. A
        // target change cannot reuse this probe or a handle staged elsewhere.
        const currentExecutionTarget = readCurrentExecutionTarget(route);
        return availability.available
            && currentExecutionTarget !== null
            && sameExecutionTarget(executionTarget, currentExecutionTarget);
    } catch {
        // Older daemons and malformed/unavailable RPC paths have no staged
        // media admission contract, so retain the exact draft without calling
        // a Message-admission delegate.
        return false;
    }
}

export async function submitComposerSnapshot(input: Readonly<{
    snapshot: ComposerSnapshotV1 | null;
    route: ComposerSubmissionRoute;
    clearAcceptedSnapshot: (snapshot: ComposerSubmissionSnapshot) => boolean;
}>): Promise<ComposerSubmissionResult> {
    if (!input.snapshot || !input.snapshot.capabilities.submit || !input.snapshot.state.submittable) {
        return { status: 'unavailable' };
    }

    const snapshot = captureComposerSubmissionSnapshot(input.snapshot);
    if (!snapshot) return { status: 'unavailable' };
    if (!isSubmissionRouteForSnapshot(snapshot, input.route)) {
        return { status: 'blocked', reason: 'scopeMismatch', snapshot };
    }
    if (hasUnavailableAttachment(snapshot)) {
        return { status: 'blocked', reason: 'attachmentUnavailable', snapshot };
    }
    if (isTextlessAndAttachmentless(snapshot)) {
        return { status: 'notSendable', snapshot };
    }
    const stagedMedia = readStagedMediaHandles(snapshot);
    if (stagedMedia.status === 'invalid') {
        return { status: 'blocked', reason: 'mediaContentUnavailable', snapshot };
    }
    if (stagedMedia.status === 'ready' && !await isStagedMediaAdmissionAvailable(stagedMedia.handles, input.route)) {
        return { status: 'blocked', reason: 'mediaContentUnavailable', snapshot };
    }

    let didAcceptAtHandoff = false;
    let clearedAtHandoff = false;
    const handoff: ComposerSubmissionAdmissionHandoff = {
        accept: () => {
            if (didAcceptAtHandoff) return clearedAtHandoff;
            didAcceptAtHandoff = true;
            clearedAtHandoff = input.clearAcceptedSnapshot(snapshot);
            return clearedAtHandoff;
        },
    };

    let admission: ComposerSubmissionAdmissionOutcome;
    switch (input.route.kind) {
        case 'session':
        case 'newSession':
        case 'participantMessage':
        case 'pendingMessage':
            admission = await input.route.admit(snapshot, handoff);
            break;
    }

    if (admission.status !== 'accepted') {
        return { status: 'rejected', snapshot };
    }

    return {
        status: 'accepted',
        snapshot,
        // The document owner retains the exact ref boundary and independently
        // clears each field whose current value still matches this detached
        // snapshot, leaving newer fields intact after accepted handoff.
        cleared: didAcceptAtHandoff ? clearedAtHandoff : handoff.accept(),
    };
}
