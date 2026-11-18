import * as React from 'react';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { SessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { decodeLegacyReviewStartInput } from '@happier-dev/protocol/reviews/reviewStart';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import type { ParticipantComposerDocument } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import type { ComparisonReviewDraftInput } from './useComparisonReviewDraft';
import { ScmReviewComparisonSelectorSchema } from '@/sync/domains/scm/diffSummary/selection';
import { paneDetailsTabSchema } from '@/components/appShell/panes/model/paneScopePersistenceSchema';
import { randomUUID } from '@/platform/randomUUID';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    executionRunLauncherDraftFieldPath,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

/** Both retained draft selections and Details resources cross the same persistence boundary. */
export const ComparisonReviewDraftInputSchema = z.strictObject({
    cwd: z.string().check(z.minLength(1)), comparison: ScmReviewComparisonSelectorSchema,
    comparisonId: z.optional(z.nullable(z.string())), scopeLabel: z.string(),
    scopeDetail: z.optional(z.nullable(z.string())), defaultWalkthrough: z.boolean(),
    preselectedEngineIds: z.optional(z.array(z.string())),
    origin: z.optional(z.strictObject({ scopeId: z.string().check(z.minLength(1)),
        tab: z.omit(paneDetailsTabSchema, { isPreview: true, isPinned: true }) })),
});

const SelectionSchema = z.strictObject({
    identity: z.strictObject({ correlationId: z.string().check(z.minLength(1)), inputLocalId: z.string().check(z.minLength(1)) }),
    actionInput: z.record(z.string(), z.unknown()),
    comparisonReview: z.optional(ComparisonReviewDraftInputSchema),
});

type LauncherSelection = Omit<z.infer<typeof SelectionSchema>, 'comparisonReview'> & Readonly<{
    comparisonReview?: ComparisonReviewDraftInput;
    key: string;
    selectionSnapshot: object;
}>;

/** Reopening Work consumes the context held by the same selection as its captured comparison id. */
export function readExecutionRunLauncherComparisonReview(
    document: SessionDraftDocumentV2 | null, draftKey: string,
): ComparisonReviewDraftInput | null {
    const selection = SelectionSchema.safeParse(getSessionDraftDocumentField(document,
        executionRunLauncherDraftFieldPath(draftKey, 'selection'))?.value);
    return selection.success ? selection.data.comparisonReview ?? null : null;
}

/** Session launchers reuse their Session draft; detached launchers retain only mounted state. */
export function useExecutionRunLauncherDraft(input: Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    sessionId: string | null;
    draftKey: string;
    actionId?: ActionId;
    correlationId?: string;
    comparisonReview?: ComparisonReviewDraftInput;
    createDefaultInput: () => Record<string, unknown>;
}>) {
    const { lifetime, sessionId, draftKey } = input;
    const acceptedLifetime = lifetime ? readServerAccountScopeOwnerLifetime(lifetime) : null;
    const address = sessionId === null ? null : { kind: 'session' as const, sessionId };
    const key = JSON.stringify([lifetime?.scope.serverId ?? null, lifetime?.scope.accountId ?? null, sessionId, draftKey]);
    const selectionPath = executionRunLauncherDraftFieldPath(draftKey, 'selection');
    const selectionFieldId = `extensions.happier.${selectionPath.fieldId}`;
    const currentRef = React.useRef<LauncherSelection | null>(null);
    const observation = React.useRef<Readonly<{ key: string; mutationId: string | null; snapshot: object }> | null>(null);
    const readSelectionSnapshot = React.useCallback(() => {
        const field = lifetime && sessionId !== null ? getSessionDraftDocumentField(
            getSessionDraftSnapshot(lifetime.scope, { kind: 'session', sessionId })?.document ?? null,
            executionRunLauncherDraftFieldPath(draftKey, 'selection'),
        ) : null;
        const mutationId = field?.mutationId ?? null;
        const previous = observation.current;
        if (previous?.key === key && previous.mutationId === mutationId) return previous.snapshot;
        const held = currentRef.current;
        // A text edit first checkpoints the already-held selection. Its new repository
        // token is not a changed form value; external changes and removal still advance.
        const unchanged = held?.key === key && field && pluginJsonValuesEqual(field.value, {
            identity: held.identity, actionInput: held.actionInput,
            ...(held.comparisonReview ? { comparisonReview: held.comparisonReview } : {}),
        });
        const snapshot = previous?.key === key && unchanged ? previous.snapshot : {};
        observation.current = { key, mutationId, snapshot };
        return snapshot;
    }, [draftKey, key, lifetime, sessionId]);
    const subscribeSelection = React.useCallback((listener: () => void) => lifetime && sessionId !== null
        ? subscribeSessionDraft(lifetime.scope, { kind: 'session', sessionId }, listener)
        : () => undefined, [lifetime, sessionId]);
    const selectionSnapshot = React.useSyncExternalStore(subscribeSelection, readSelectionSnapshot, readSelectionSnapshot);
    const createState = (): LauncherSelection => {
        const document = lifetime && address ? getSessionDraftSnapshot(lifetime.scope, address)?.document : null;
        const saved = SelectionSchema.safeParse(getSessionDraftDocumentField(document ?? null, selectionPath)?.value);
        const actionInput = saved.success ? saved.data.actionInput : input.createDefaultInput();
        return { key, selectionSnapshot, identity: saved.success ? saved.data.identity : {
            correlationId: input.correlationId ?? randomUUID(), inputLocalId: randomUUID(),
        }, actionInput: input.actionId === 'review.start'
            ? decodeLegacyReviewStartInput(actionInput) as Record<string, unknown> : actionInput,
            ...(input.comparisonReview ? { comparisonReview: input.comparisonReview } : {}) };
    };
    const [stored, setStored] = React.useState(createState);
    const matches = stored.key === key && stored.selectionSnapshot === selectionSnapshot;
    const current = matches ? stored : createState();
    if (!matches) setStored(current);
    currentRef.current = current;
    const persistSelection = React.useCallback(() => {
        const current = currentRef.current;
        if (!lifetime?.isCurrent() || sessionId === null || current?.key !== key) return;
        const { identity, actionInput, comparisonReview } = current;
        writeExistingSessionDraft({ scope: lifetime.scope, sessionId,
            patch: { executionRunLauncher: { key: draftKey, patch: {
                selection: StrictJsonValueSchema.parse({ identity, actionInput,
                    ...(comparisonReview ? { comparisonReview } : {}) }),
            } } } });
    }, [draftKey, key, lifetime, sessionId]);
    const setActionInput = React.useCallback<React.Dispatch<React.SetStateAction<Record<string, unknown>>>>((update) => {
        const previous = currentRef.current;
        if (previous?.key !== key) return;
        const actionInput = typeof update === 'function' ? update(previous.actionInput) : update;
        if (actionInput === previous.actionInput) return;
        currentRef.current = { ...previous, actionInput };
        setStored(currentRef.current);
    }, [key]);
    const setUserActionInput = React.useCallback<React.Dispatch<React.SetStateAction<Record<string, unknown>>>>((update) => {
        setActionInput(update);
        persistSelection();
    }, [persistSelection, setActionInput]);
    return {
        identity: current.identity,
        actionInput: current.actionInput,
        setActionInput,
        setUserActionInput,
        onDocumentEdit: persistSelection,
        setIdentity: (identity: typeof current.identity) => {
            if (currentRef.current?.key !== key) return;
            currentRef.current = { ...currentRef.current, identity };
            setStored(currentRef.current);
            persistSelection();
        },
        captureSelection: (): SessionDraftCurrentness | null => lifetime?.isCurrent() && address
            ? captureSessionDraftCurrentness({ scope: lifetime.scope, address, fieldIds: [selectionFieldId] }) : null,
        clearAcceptedSelection: (capture: SessionDraftCurrentness | null, residual: ParticipantComposerDocument) => {
            if (!capture || !address || !acceptedLifetime?.isCurrent() || residual.text || residual.mentions.length || residual.attachments.length) return;
            clearSessionDraftCurrentnessLocal({ scope: acceptedLifetime.scope, address, currentness: capture, fieldIds: [selectionFieldId] });
        },
    };
}
