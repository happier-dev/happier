import type {
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
} from '@happier-dev/protocol';
import React from 'react';

import { getAgentCore } from '@/agents/catalog/catalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type {
    ComposerReferenceSearchHost,
    ComposerSuggestionKindId,
} from '@/components/autocomplete/composerSuggestionKinds';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import {
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import {
    notifyComposerPresentationTargetChanged,
    registerComposerPresentationTarget,
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import { useComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { resolveSessionComposerStateFromAuthoringContext } from '@/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import {
    updateSessionAuthoringDraftModelMode,
    updateSessionAuthoringDraftPermissionMode,
    updateSessionAuthoringDraftPrompt,
} from '@/components/sessions/authoring/draft/updateSessionAuthoringDraftFields';
import type { ExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/sessionAuthoringContext';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { nowServerMs } from '@/sync/runtime/time';
import { t, tLoose } from '@/text';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

// R-9: automation composers offer file, vendor-plugin, and daemon composer references plus
// slash commands. No $ skills.
const AUTOMATION_COMPOSER_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = [
    'file',
    'vendorPlugin',
    'composerReference',
    'slashCommand',
];

type AutomationComposerDocument = Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>;

function sameAutomationComposerRef(left: ComposerRefV1, right: ComposerRefV1): boolean {
    return left.kind === 'automationAuthoring'
        && right.kind === 'automationAuthoring'
        && left.sessionId === right.sessionId
        && left.instanceId === right.instanceId;
}

function sameAutomationComposerDocument(
    left: AutomationComposerDocument,
    right: AutomationComposerDocument,
): boolean {
    return left.text === right.text && JSON.stringify(left.mentions) === JSON.stringify(right.mentions);
}

export function ExistingSessionAutomationComposer(props: Readonly<{
    context: ExistingSessionAutomationAuthoringContext;
    onChangeDraft: React.Dispatch<React.SetStateAction<SessionAuthoringDraft | null>>;
    onSubmit: () => void;
    submitAccessibilityLabel: string;
    isSubmitDisabled: boolean;
    editable?: boolean;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
}>): React.JSX.Element {
    const composerAccountLifetime = captureActiveServerAccountScopeLifetime();
    const automationMachineTarget = useSessionMachineTarget(props.context.session.id);
    const automationServerId = usePreferredServerIdForSession(props.context.session.id);
    const automationDaemonProjection = useDaemonMergedProjectionInputs({
        machineId: automationMachineTarget?.machineId ?? null,
        serverId: automationServerId,
        enabled: automationMachineTarget !== null,
    });
    const composerState = resolveSessionComposerStateFromAuthoringContext(props.context);
    const profileId = composerState.profileId;
    const ownerMetadata = readSessionOwnerMetadataView(props.context.session);
    const [composerInstanceId] = React.useState(randomUUID);
    const composerRef = React.useMemo<Extract<ComposerRefV1, { kind: 'automationAuthoring' }>>(() => ({
        kind: 'automationAuthoring',
        sessionId: props.context.session.id,
        instanceId: composerInstanceId,
    }), [composerInstanceId, props.context.session.id]);
    const composerRefRef = React.useRef<ComposerRefV1>(composerRef);
    composerRefRef.current = composerRef;
    const editableRef = React.useRef(props.editable !== false);
    editableRef.current = props.editable !== false;
    const mountedRef = React.useRef(true);
    const composerInputFocusedRef = React.useRef(false);
    const composerActionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const composerFocusRequestRef = React.useRef<(() => void) | null>(null);
    const onChangeDraftRef = React.useRef(props.onChangeDraft);
    onChangeDraftRef.current = props.onChangeDraft;
    const documentRef = React.useRef<AutomationComposerDocument>({
        text: props.context.draft.prompt,
        mentions: [],
    });
    const revisionRef = React.useRef(0);
    const lastScopeRef = React.useRef<ComposerRefV1>(composerRef);
    const [, forceComposerDocumentRender] = React.useReducer((version: number) => version + 1, 0);

    const isAutomationComposerCurrent = React.useCallback(() => (
        mountedRef.current
        && sameAutomationComposerRef(composerRefRef.current, composerRef)
        && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
    ), [composerAccountLifetime, composerRef]);
    const composerInputEffects = useComposerPresentationInputEffects({
        ref: composerRef,
    });
    const automationComposerReferenceHostRef = React.useRef<ComposerReferenceSearchHost | null>(null);
    const automationComposerReferenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => {
        const projection = automationDaemonProjection.inputs?.pluginProjectionV2 ?? null;
        const machineId = automationMachineTarget?.machineId ?? null;
        if (
            automationDaemonProjection.phase !== 'ready'
            || machineId === null
            || projection === null
        ) {
            return null;
        }

        let host: ComposerReferenceSearchHost;
        host = {
            machineId,
            serverId: automationServerId,
            projection,
            isCurrent: () => (
                automationComposerReferenceHostRef.current === host
                && isAutomationComposerCurrent()
                && composerInputFocusedRef.current
            ),
        };
        return host;
    }, [
        automationDaemonProjection.inputs?.pluginProjectionV2,
        automationDaemonProjection.phase,
        automationMachineTarget?.machineId,
        automationServerId,
        isAutomationComposerCurrent,
    ]);
    automationComposerReferenceHostRef.current = automationComposerReferenceHost;
    const automationComposerPresentation = useComposerScopePluginPresentation({
        composer: composerRef,
        physicalTarget: { kind: 'session', sessionId: props.context.session.id },
        resourceContext: { kind: 'session', sessionId: props.context.session.id },
        machineId: automationMachineTarget?.machineId ?? null,
        serverId: automationServerId,
        projectionPhase: automationDaemonProjection.phase,
        projectionInputs: automationDaemonProjection.inputs,
        accountLifetime: composerAccountLifetime,
        isScopeCurrent: isAutomationComposerCurrent,
        attachmentsEnabled: false,
        includeSessionActions: false,
    });

    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        const retirement = composerAccountLifetime?.onRetire(() => {
            composerInputEffects.retire();
        });
        return () => retirement?.dispose();
    }, [composerAccountLifetime, composerInputEffects.retire]);

    const onComposerFocusChange = React.useCallback((focused: boolean) => {
        if (!mountedRef.current || !sameAutomationComposerRef(composerRefRef.current, composerRef)) return;
        if (composerInputFocusedRef.current === focused) return;
        composerInputFocusedRef.current = focused;
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef]);

    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        composerFocusRequestRef.current = request;
    }, []);

    const onComposerActionBarLayoutChange = React.useCallback((layout: ComposerSnapshotV1['layout']) => {
        if (!mountedRef.current || !sameAutomationComposerRef(composerRefRef.current, composerRef)) return;
        if (composerActionBarLayoutRef.current === layout) return;
        composerActionBarLayoutRef.current = layout;
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef]);

    const updateAutomationComposerDocument = React.useCallback((next: AutomationComposerDocument, notify: boolean): number => {
        if (!sameAutomationComposerRef(composerRefRef.current, composerRef)) return revisionRef.current;
        if (sameAutomationComposerDocument(documentRef.current, next)) return revisionRef.current;
        documentRef.current = next;
        revisionRef.current += 1;
        forceComposerDocumentRender();
        if (notify) notifyComposerPresentationTargetChanged(composerRef);
        return revisionRef.current;
    }, [composerRef]);

    const writeAutomationDraftPrompt = React.useCallback((prompt: string) => {
        onChangeDraftRef.current((current) => current
            ? updateSessionAuthoringDraftPrompt(current, prompt)
            : current);
    }, []);

    React.useEffect(() => {
        const scopeChanged = !sameAutomationComposerRef(lastScopeRef.current, composerRef);
        lastScopeRef.current = composerRef;
        const current = documentRef.current;
        const next: AutomationComposerDocument = scopeChanged
            ? { text: props.context.draft.prompt, mentions: [] }
            : current.text === props.context.draft.prompt
                ? current
                : { ...current, text: props.context.draft.prompt };
        updateAutomationComposerDocument(next, true);
    }, [composerRef, props.context.draft.prompt, updateAutomationComposerDocument]);

    const readAutomationComposerSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        const document = documentRef.current;
        const inputLock = composerInputEffects.readComposerInputLock();
        return {
            revision: revisionRef.current,
            ref: composerRef,
            text: document.text,
            references: [...composerReferencesFromStructuredMentions({
                text: document.text,
                mentions: document.mentions,
            })],
            attachments: [],
            layout: composerActionBarLayoutRef.current,
            capabilities: {
                text: true,
                references: true,
                attachments: false,
                submit: false,
            },
            state: {
                focused: composerInputFocusedRef.current,
                editable: editableRef.current && inputLock?.mode !== 'editAndSubmit',
                submittable: false,
                submitting: false,
                running: false,
                ...(inputLock ? { inputLock } : {}),
            },
        };
    }, [composerInputEffects.readComposerInputLock, composerRef]);

    const commitAutomationComposerDocument = React.useCallback((input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>): ComposerTransactionResultV1 => {
        if (!sameAutomationComposerRef(composerRefRef.current, composerRef) || revisionRef.current !== input.expectedRevision) {
            return { status: 'conflict', currentRevision: revisionRef.current };
        }
        const previous = documentRef.current;
        const next: AutomationComposerDocument = {
            text: input.mutation.text,
            mentions: composerStructuredMentionsFromReferences({
                references: input.mutation.references,
                existing: previous.mentions,
            }),
        };
        const revision = updateAutomationComposerDocument(next, false);
        if (previous.text !== next.text) writeAutomationDraftPrompt(next.text);
        return { status: 'applied', revision };
    }, [composerRef, updateAutomationComposerDocument, writeAutomationDraftPrompt]);

    const composerTarget = useStableComposerPresentationTarget(composerRef, {
        readRevision: () => revisionRef.current,
        replace: (text, expectedRevision) => {
            if (revisionRef.current !== expectedRevision) return revisionRef.current;
            const previous = documentRef.current;
            const revision = updateAutomationComposerDocument({ ...previous, text }, true);
            if (previous.text !== text) writeAutomationDraftPrompt(text);
            return revision;
        },
        readSnapshot: readAutomationComposerSnapshot,
        commitDocument: commitAutomationComposerDocument,
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: () => (
            mountedRef.current
            && sameAutomationComposerRef(composerRefRef.current, composerRef)
            && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
        ),
        focusComposer: () => {
            if (
                !mountedRef.current
                || !sameAutomationComposerRef(composerRefRef.current, composerRef)
                || (composerAccountLifetime !== null && !composerAccountLifetime.isCurrent())
            ) {
                return false;
            }
            const focus = composerFocusRequestRef.current;
            if (!focus) return false;
            focus();
            return true;
        },
    } satisfies ComposerPresentationTarget);

    React.useEffect(() => registerComposerPresentationTarget(composerRef, composerTarget), [composerRef, composerTarget]);

    const document = documentRef.current;
    const extraActionChips = React.useMemo(() => [
        ...(props.extraActionChips ?? []),
        ...automationComposerPresentation.extraActionChips,
    ], [automationComposerPresentation.extraActionChips, props.extraActionChips]);

    return (
        <PluginContextualResourceStoreProvider>
            {automationComposerPresentation.beforeComposer}
            <AgentInput
            value={document.text}
            onComposerFocusChange={onComposerFocusChange}
            onComposerFocusRequestChange={onComposerFocusRequestChange}
            onComposerActionBarLayoutChange={onComposerActionBarLayoutChange}
            composerDecorations={composerInputEffects.composerDecorations}
            composerInputLock={composerInputEffects.composerInputLock}
            onChangeText={(value) => {
                const previous = documentRef.current;
                updateAutomationComposerDocument({ ...previous, text: value }, true);
                if (previous.text !== value) writeAutomationDraftPrompt(value);
            }}
            structuredInputMentions={document.mentions}
            onStructuredInputMentionsChange={(mentions) => {
                updateAutomationComposerDocument({
                    ...documentRef.current,
                    mentions,
                }, true);
            }}
            onSend={props.onSubmit}
            isSendDisabled={props.isSubmitDisabled || composerInputEffects.composerInputLock !== null}
            submitAccessibilityLabel={props.submitAccessibilityLabel}
            placeholder={t('automations.edit.messagePlaceholder')}
            autocompleteKinds={AUTOMATION_COMPOSER_SUGGESTION_KINDS}
            autocompleteSuggestions={(query, signal) => resolveSessionComposerSuggestions(props.context.session.id, query, {
                kinds: AUTOMATION_COMPOSER_SUGGESTION_KINDS,
                signal,
                composerReferenceHost: automationComposerReferenceHost,
            })}
            sessionId={props.context.session.id}
            metadata={ownerMetadata}
            agentType={composerState.agentId ?? undefined}
            agentLabel={composerState.agentId ? t(getAgentCore(composerState.agentId).displayNameKey) : tLoose('common.unknown')}
            permissionMode={composerState.permissionMode}
            onPermissionModeChange={(mode) => {
                props.onChangeDraft((current) => current
                    ? updateSessionAuthoringDraftPermissionMode(current, mode, nowServerMs())
                    : current);
            }}
            modelMode={composerState.modelMode}
            onModelModeChange={(mode) => {
                props.onChangeDraft((current) => current
                    ? updateSessionAuthoringDraftModelMode(current, mode, nowServerMs())
                    : current);
            }}
            machineName={composerState.machineName}
            currentPath={props.context.draft.directory}
            profileId={profileId}
            onProfileClick={profileId
                ? () => {
                    void Modal.alert(
                        t('profiles.title'),
                        `${t('profiles.sessionUses', { profile: profileId })}\n\n${t('profiles.profilesFixedPerSession')}`,
                    );
                }
                : undefined}
            contentPaddingHorizontal={0}
            disabled={props.editable === false || composerInputEffects.composerInputLock?.mode === 'editAndSubmit'}
                extraActionChips={extraActionChips}
            />
            {automationComposerPresentation.afterComposer}
        </PluginContextualResourceStoreProvider>
    );
}
