import type {
    ComposerAttachmentDraftV1,
    ComposerRefV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    ParticipantRecipientV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import type {
    ComposerReferenceSearchHost,
    ComposerSuggestionKindId,
} from '@/components/autocomplete/composerSuggestionKinds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { PluginContextualResourceStoreProvider } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { resolveSessionComposerSuggestions } from '@/components/sessions/agentInput/sessionComposerSuggestions';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import {
    buildStructuredInputMetaOverrides,
    mergeMessageMetaOverrides,
    type ComposerStructuredInputMention,
} from '@/components/sessions/agentInput/structuredInputMentions';
import {
    projectComposerAttachmentRowItems,
} from '@/components/sessions/composer/composerAttachmentProjection';
import {
    composerAttachmentDraftToView,
    composerAttachmentViewToDraft,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
} from '@/components/sessions/composer/composerScopeAdapters';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import {
    readComposerSubmissionFieldCurrentness,
    submitComposerSnapshot,
    type ComposerSubmissionSnapshot,
} from '@/components/sessions/composer/composerSubmissionCoordinator';
import {
    applyComposerPresentationTransaction,
    notifyComposerPresentationTargetChanged,
    readComposerPresentationSnapshot,
    registerComposerPresentationTarget,
    useStableComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { useComposerPresentationInputEffects } from '@/components/sessions/presentation/useComposerPresentationInputEffects';
import { useComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveParticipantRoutedSend } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { BrowserContextState } from '@/sync/domains/browser/context';
import {
    hasBrowserContextComposerAttachments,
    mergeBrowserContextMessageMetaOverrides,
} from '@/sync/domains/session/input/browserContext';
import { isExecutionRunNotRunningSendError, sessionExecutionRunSend } from '@/sync/ops/sessionExecutionRuns';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type ExecutionRunDelivery = 'prompt' | 'steer_if_supported' | 'interrupt';

// R-9: participant composers offer file, vendor-plugin, and daemon composer references plus
// slash commands. No $ skills.
const PARTICIPANT_COMPOSER_SUGGESTION_KINDS: readonly ComposerSuggestionKindId[] = [
    'file',
    'vendorPlugin',
    'composerReference',
    'slashCommand',
];

type ParticipantComposerDocument = Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    // Persisted participant documents retain only semantic attachment draft
    // data. Availability is derived from the exact scoped projection at read
    // time, never retained from the generation that added the attachment.
    attachments: readonly ComposerAttachmentDraftV1[];
}>;

function sameComposerRef(left: ComposerRefV1, right: ComposerRefV1): boolean {
    return left.kind === right.kind
        && left.kind === 'participantMessage'
        && right.kind === 'participantMessage'
        && left.sessionId === right.sessionId
        && left.instanceId === right.instanceId;
}

function sameParticipantComposerDocument(
    left: ParticipantComposerDocument,
    right: ParticipantComposerDocument,
): boolean {
    return left.text === right.text
        && JSON.stringify(left.mentions) === JSON.stringify(right.mentions)
        && JSON.stringify(left.attachments) === JSON.stringify(right.attachments);
}

export const SessionParticipantComposer = React.memo((props: Readonly<{
    sessionId: string;
    canSendMessages: boolean;
    recipient: ParticipantRecipientV1 | null;
    executionRunDelivery?: ExecutionRunDelivery;
    extraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    browserContextState?: BrowserContextState | null;
    onExecutionRunUnavailable?: () => void;
}>) => {
    const composerAccountLifetime = captureActiveServerAccountScopeLifetime();
    const participantMachineTarget = useSessionMachineTarget(props.sessionId);
    const participantServerId = usePreferredServerIdForSession(props.sessionId);
    const participantDaemonProjection = useDaemonMergedProjectionInputs({
        machineId: participantMachineTarget?.machineId ?? null,
        serverId: participantServerId,
        enabled: participantMachineTarget !== null,
    });
    const [composerInstanceId] = React.useState(randomUUID);
    const composerRef = React.useMemo<Extract<ComposerRefV1, { kind: 'participantMessage' }>>(() => ({
        kind: 'participantMessage',
        sessionId: props.sessionId,
        instanceId: composerInstanceId,
    }), [composerInstanceId, props.sessionId]);
    const composerRefRef = React.useRef<ComposerRefV1>(composerRef);
    composerRefRef.current = composerRef;
    const canSendMessagesRef = React.useRef(props.canSendMessages);
    canSendMessagesRef.current = props.canSendMessages;
    const mountedRef = React.useRef(true);
    const composerInputFocusedRef = React.useRef(false);
    const composerActionBarLayoutRef = React.useRef<ComposerSnapshotV1['layout']>('wrap');
    const composerFocusRequestRef = React.useRef<(() => void) | null>(null);
    const documentRef = React.useRef<ParticipantComposerDocument>({
        text: '',
        mentions: [],
        attachments: [],
    });
    const revisionRef = React.useRef(0);
    const [, forceComposerDocumentRender] = React.useReducer((version: number) => version + 1, 0);

    const isParticipantComposerCurrent = React.useCallback(() => (
        mountedRef.current
        && sameComposerRef(composerRefRef.current, composerRef)
        && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
    ), [composerAccountLifetime, composerRef]);
    const composerInputEffects = useComposerPresentationInputEffects({
        ref: composerRef,
    });
    const participantComposerReferenceHostRef = React.useRef<ComposerReferenceSearchHost | null>(null);
    const participantComposerReferenceHost = React.useMemo<ComposerReferenceSearchHost | null>(() => {
        const projection = participantDaemonProjection.inputs?.pluginProjectionV2 ?? null;
        const machineId = participantMachineTarget?.machineId ?? null;
        if (
            participantDaemonProjection.phase !== 'ready'
            || machineId === null
            || projection === null
        ) {
            return null;
        }

        let host: ComposerReferenceSearchHost;
        host = {
            machineId,
            serverId: participantServerId,
            projection,
            isCurrent: () => (
                participantComposerReferenceHostRef.current === host
                && isParticipantComposerCurrent()
                && composerInputFocusedRef.current
            ),
        };
        return host;
    }, [
        isParticipantComposerCurrent,
        participantDaemonProjection.inputs?.pluginProjectionV2,
        participantDaemonProjection.phase,
        participantMachineTarget?.machineId,
        participantServerId,
    ]);
    participantComposerReferenceHostRef.current = participantComposerReferenceHost;
    const participantComposerPresentation = useComposerScopePluginPresentation({
        composer: composerRef,
        physicalTarget: { kind: 'session', sessionId: props.sessionId },
        resourceContext: { kind: 'session', sessionId: props.sessionId },
        machineId: participantMachineTarget?.machineId ?? null,
        serverId: participantServerId,
        projectionPhase: participantDaemonProjection.phase,
        projectionInputs: participantDaemonProjection.inputs,
        accountLifetime: composerAccountLifetime,
        isScopeCurrent: isParticipantComposerCurrent,
        attachmentsEnabled: true,
        includeSessionActions: false,
    });
    // The daemon catalog remains the only availability owner. Persisted
    // drafts contain semantic attachment data only, and this exact current
    // projection determines whether they are sendable.
    const participantComposerAttachmentEntriesById = participantComposerPresentation.attachmentEntriesById;

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
        if (!mountedRef.current || !sameComposerRef(composerRefRef.current, composerRef)) return;
        if (composerInputFocusedRef.current === focused) return;
        composerInputFocusedRef.current = focused;
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef]);

    const onComposerFocusRequestChange = React.useCallback((request: (() => void) | null) => {
        composerFocusRequestRef.current = request;
    }, []);

    const onComposerActionBarLayoutChange = React.useCallback((layout: ComposerSnapshotV1['layout']) => {
        if (!mountedRef.current || !sameComposerRef(composerRefRef.current, composerRef)) return;
        if (composerActionBarLayoutRef.current === layout) return;
        composerActionBarLayoutRef.current = layout;
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef]);

    const updateParticipantComposerDocument = React.useCallback((next: ParticipantComposerDocument, notify: boolean): number => {
        if (!sameComposerRef(composerRefRef.current, composerRef)) return revisionRef.current;
        if (sameParticipantComposerDocument(documentRef.current, next)) return revisionRef.current;
        documentRef.current = next;
        revisionRef.current += 1;
        forceComposerDocumentRender();
        if (notify) notifyComposerPresentationTargetChanged(composerRef);
        return revisionRef.current;
    }, [composerRef]);

    const readParticipantComposerSnapshot = React.useCallback((): ComposerSnapshotV1 => {
        const document = documentRef.current;
        const canSendMessages = canSendMessagesRef.current;
        const inputLock = composerInputEffects.readComposerInputLock();
        const editable = canSendMessages && inputLock?.mode !== 'editAndSubmit';
        const submittable = canSendMessages && inputLock === null;
        return {
            revision: revisionRef.current,
            ref: composerRef,
            text: document.text,
            references: [...composerReferencesFromStructuredMentions({
                text: document.text,
                mentions: document.mentions,
            })],
            attachments: document.attachments.map((attachment) => composerAttachmentDraftToView(attachment, {
                entriesById: participantComposerAttachmentEntriesById,
            })),
            layout: composerActionBarLayoutRef.current,
            capabilities: {
                text: true,
                references: true,
                attachments: true,
                submit: true,
            },
            state: {
                focused: composerInputFocusedRef.current,
                editable,
                submittable,
                submitting: false,
                running: false,
                ...(inputLock ? { inputLock } : {}),
            },
        };
    }, [composerInputEffects.readComposerInputLock, composerRef, participantComposerAttachmentEntriesById]);

    const commitParticipantComposerDocument = React.useCallback((input: Readonly<{
        expectedRevision: number;
        mutation: ComposerPresentationDocumentMutation;
    }>): ComposerTransactionResultV1 => {
        if (!sameComposerRef(composerRefRef.current, composerRef) || revisionRef.current !== input.expectedRevision) {
            return { status: 'conflict', currentRevision: revisionRef.current };
        }
        const previous = documentRef.current;
        const next: ParticipantComposerDocument = {
            text: input.mutation.text,
            mentions: composerStructuredMentionsFromReferences({
                references: input.mutation.references,
                existing: previous.mentions,
            }),
            attachments: input.mutation.attachments.map(composerAttachmentViewToDraft),
        };
        return {
            status: 'applied',
            revision: updateParticipantComposerDocument(next, false),
        };
    }, [composerRef, updateParticipantComposerDocument]);

    const composerTarget = useStableComposerPresentationTarget(composerRef, {
        readRevision: () => revisionRef.current,
        replace: (text, expectedRevision) => {
            if (revisionRef.current !== expectedRevision) return revisionRef.current;
            return updateParticipantComposerDocument({
                ...documentRef.current,
                text,
            }, true);
        },
        readSnapshot: readParticipantComposerSnapshot,
        commitDocument: commitParticipantComposerDocument,
        createAttachmentInstanceId: randomUUID,
        setComposerDecorations: composerInputEffects.setComposerDecorations,
        acquireComposerInputLock: composerInputEffects.acquireComposerInputLock,
        isCurrent: () => (
            mountedRef.current
            && sameComposerRef(composerRefRef.current, composerRef)
            && (composerAccountLifetime === null || composerAccountLifetime.isCurrent())
        ),
        focusComposer: () => {
            if (
                !mountedRef.current
                || !sameComposerRef(composerRefRef.current, composerRef)
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

    React.useEffect(() => {
        notifyComposerPresentationTargetChanged(composerRef);
    }, [composerRef, participantComposerAttachmentEntriesById]);

    const removeComposerAttachment = React.useCallback((instanceId: string) => {
        const snapshot = readComposerPresentationSnapshot(composerRef);
        if (!snapshot) return;
        applyComposerPresentationTransaction({
            ref: composerRef,
            transaction: {
                expectedRevision: snapshot.revision,
                operations: [{ kind: 'attachment.remove', instanceId }],
            },
        });
    }, [composerRef]);

    const document = documentRef.current;
    const composerAttachmentViews = React.useMemo(() => document.attachments.map((attachment) => (
        composerAttachmentDraftToView(attachment, {
            entriesById: participantComposerAttachmentEntriesById,
        })
    )), [document.attachments, participantComposerAttachmentEntriesById]);
    const composerAttachmentRowItems = React.useMemo(() => projectComposerAttachmentRowItems({
        attachments: composerAttachmentViews,
        onRemove: removeComposerAttachment,
        entriesById: participantComposerAttachmentEntriesById ?? undefined,
        renderSurface: participantComposerPresentation.renderAttachmentSurface,
        resolveInteraction: participantComposerPresentation.resolveAttachmentInteraction,
    }), [
        composerAttachmentViews,
        participantComposerAttachmentEntriesById,
        participantComposerPresentation.renderAttachmentSurface,
        participantComposerPresentation.resolveAttachmentInteraction,
        removeComposerAttachment,
    ]);

    const clearAcceptedParticipantSnapshot = React.useCallback((submittedSnapshot: ComposerSubmissionSnapshot): boolean => {
        if (!mountedRef.current) return false;
        const currentSnapshot = readParticipantComposerSnapshot();
        if (!sameComposerRef(composerRefRef.current, submittedSnapshot.ref)) return false;
        const currentness = readComposerSubmissionFieldCurrentness(currentSnapshot, submittedSnapshot);
        if (!currentness) return false;
        updateParticipantComposerDocument({
            text: currentness.reconciledText,
            mentions: composerStructuredMentionsFromReferences({
                references: currentness.reconciledReferences,
                existing: documentRef.current.mentions,
            }),
            attachments: currentness.attachments ? [] : documentRef.current.attachments,
        }, true);
        return true;
    }, [readParticipantComposerSnapshot, updateParticipantComposerDocument]);

    const handleParticipantSend = React.useCallback((sendOptions?: AgentInputSendOptions) => {
        if (!props.canSendMessages) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return;
        }

        const liveComposerText = sendOptions?.inputTextOverride ?? documentRef.current.text;
        if (liveComposerText !== documentRef.current.text) {
            updateParticipantComposerDocument({
                ...documentRef.current,
                text: liveComposerText,
            }, true);
        }

        const snapshot = readParticipantComposerSnapshot();
        fireAndForget(submitComposerSnapshot({
            snapshot,
            route: {
                kind: 'participantMessage',
                ref: composerRef,
                readCurrentExecutionTarget: () => (
                    participantComposerPresentation.scopeSignal.aborted
                        ? null
                        : {
                            serverId: participantServerId,
                            machineId: participantMachineTarget?.machineId,
                        }
                ),
                admit: async (submittedSnapshot, handoff) => {
                    const text = submittedSnapshot.text.trim();
                    const hasComposerAttachments = submittedSnapshot.attachments.length > 0;
                    const snapshotStructuredInputMetaOverrides = buildStructuredInputMetaOverrides({
                        mentions: composerStructuredMentionsFromReferences({
                            references: submittedSnapshot.references,
                            existing: [],
                        }),
                        text: submittedSnapshot.text,
                        ...(hasComposerAttachments
                            ? { composerAttachments: submittedSnapshot.attachments.map(composerAttachmentViewToDraft) }
                            : {}),
                    });
                    const structuredInputMetaOverrides = mergeMessageMetaOverrides(
                        submittedSnapshot.references.length === 0
                            ? sendOptions?.structuredInputMetaOverrides
                            : undefined,
                        Object.keys(snapshotStructuredInputMetaOverrides).length > 0
                            ? snapshotStructuredInputMetaOverrides
                            : undefined,
                    );

                    const mergeBrowserContextMeta = (metaOverrides?: Record<string, unknown>): Record<string, unknown> | undefined | null => {
                        const result = mergeBrowserContextMessageMetaOverrides({
                            state: props.browserContextState ?? null,
                            metaOverrides,
                        });
                        if (result.ok) {
                            return result.metaOverrides;
                        }
                        Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
                        return null;
                    };

                    try {
                        const routed =
                            props.recipient
                                ? resolveParticipantRoutedSend({
                                    text,
                                    recipient: props.recipient,
                                    executionRunDelivery: props.executionRunDelivery,
                                })
                                : null;

                        if (routed?.type === 'execution_run_send') {
                            if (hasBrowserContextComposerAttachments(props.browserContextState)) {
                                Modal.alert(t('common.error'), t('browserContext.composer.contextUnavailable'));
                                return { status: 'rejected' };
                            }
                            if (hasComposerAttachments) {
                                Modal.alert(t('common.error'), t('runs.send.failedToSend'));
                                return { status: 'rejected' };
                            }

                            const result = await sessionExecutionRunSend(props.sessionId, {
                                runId: routed.runId,
                                message: routed.message,
                                delivery: routed.delivery,
                            });
                            if (!result.ok) {
                                if (isExecutionRunNotRunningSendError(result)) {
                                    props.onExecutionRunUnavailable?.();
                                }
                                Modal.alert(t('common.error'), result.error ?? t('runs.send.failedToSend'));
                                return { status: 'rejected' };
                            }
                            return { status: 'accepted' };
                        }

                        if (routed?.type === 'session_message') {
                            const metaOverrides = mergeBrowserContextMeta(mergeMessageMetaOverrides(
                                routed.metaOverrides,
                                structuredInputMetaOverrides,
                            ));
                            if (metaOverrides === null) return { status: 'rejected' };
                            await sync.submitMessage(props.sessionId, routed.text, routed.displayText, metaOverrides, {
                                callerSurface: 'participant_composer',
                                onOutboundHandoff: () => {
                                    handoff.accept();
                                },
                            });
                            return { status: 'accepted' };
                        }

                        const metaOverrides = mergeBrowserContextMeta(structuredInputMetaOverrides);
                        if (metaOverrides === null) return { status: 'rejected' };
                        await sync.submitMessage(props.sessionId, text, undefined, metaOverrides, {
                            callerSurface: 'participant_composer',
                            onOutboundHandoff: () => {
                                handoff.accept();
                            },
                        });
                        return { status: 'accepted' };
                    } catch (error) {
                        Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSendMessage'));
                        return { status: 'rejected' };
                    }
                },
            },
            clearAcceptedSnapshot: clearAcceptedParticipantSnapshot,
        }).then((result) => {
            if (
                result.status === 'blocked'
                && (result.reason === 'attachmentUnavailable' || result.reason === 'mediaContentUnavailable')
            ) {
                Modal.alert(t('common.error'), t('common.unavailable'));
            }
        }), { tag: 'SessionParticipantComposer.sendMessage' });
    }, [
        clearAcceptedParticipantSnapshot,
        props.browserContextState,
        props.canSendMessages,
        props.executionRunDelivery,
        props.onExecutionRunUnavailable,
        props.recipient,
        props.sessionId,
        participantMachineTarget?.machineId,
        participantServerId,
        readParticipantComposerSnapshot,
        updateParticipantComposerDocument,
    ]);

    const extraActionChips = React.useMemo(() => [
        ...(props.extraActionChips ?? []),
        ...participantComposerPresentation.extraActionChips,
    ], [participantComposerPresentation.extraActionChips, props.extraActionChips]);

    return (
        <PluginContextualResourceStoreProvider>
            {participantComposerPresentation.beforeComposer}
            <AgentInput
                placeholder={props.canSendMessages ? t('session.inputPlaceholder') : t('session.sharing.viewOnlyMode')}
                value={document.text}
                onComposerFocusChange={onComposerFocusChange}
                onComposerFocusRequestChange={onComposerFocusRequestChange}
                onComposerActionBarLayoutChange={onComposerActionBarLayoutChange}
                composerDecorations={composerInputEffects.composerDecorations}
                composerInputLock={composerInputEffects.composerInputLock}
                onChangeText={(text) => {
                    updateParticipantComposerDocument({
                        ...documentRef.current,
                        text,
                    }, true);
                }}
                structuredInputMentions={document.mentions}
                onStructuredInputMentionsChange={(mentions) => {
                    updateParticipantComposerDocument({
                        ...documentRef.current,
                        mentions,
                    }, true);
                }}
                sessionId={props.sessionId}
                onSend={handleParticipantSend}
                autocompleteKinds={PARTICIPANT_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={(query, signal) => resolveSessionComposerSuggestions(props.sessionId, query, {
                    kinds: PARTICIPANT_COMPOSER_SUGGESTION_KINDS,
                    signal,
                    composerReferenceHost: participantComposerReferenceHost,
                })}
                isSendDisabled={!props.canSendMessages || composerInputEffects.composerInputLock !== null}
                disabled={!props.canSendMessages || composerInputEffects.composerInputLock?.mode === 'editAndSubmit'}
                extraActionChips={extraActionChips}
                attachmentRowItems={composerAttachmentRowItems}
                hasSendableAttachments={composerAttachmentViews.some((attachment) => attachment.availability.status === 'ready')}
            />
            {participantComposerPresentation.afterComposer}
        </PluginContextualResourceStoreProvider>
    );
});
