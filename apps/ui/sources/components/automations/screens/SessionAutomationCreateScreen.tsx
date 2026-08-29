import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AutomationTriggerEditor } from '@/components/automations/editor/AutomationPluralEditorScreen';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import { readExactActiveParentTurn } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { ExistingSessionAutomationAuthoringSurface } from '@/components/automations/shared/ExistingSessionAutomationAuthoringSurface';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import { layout } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { refreshExistingSessionAuthoringDraftFromSessionSnapshot } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { useSessionAuthoringDraftState } from '@/components/sessions/authoring/draft/useSessionAuthoringDraftState';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { Modal } from '@/modal';
import {
    createAutomationEditorAutomationId,
    createAutomationEditorLifetimeIdentity,
    isAutomationEditorLifetimeIdentityCurrent,
    type AutomationEditorDraft,
    type AutomationTriggerEditorValue,
} from '@/sync/domains/automations/automationEditorDraft';
import { buildAutomationRecipeFromSessionAuthoring } from '@/sync/domains/automations/automationRecipeAuthoring';
import { captureSessionAutomationAuthority } from '@/sync/domains/automations/sessionAutomationAuthority';
import { isAutomationSessionCandidate } from '@/sync/domains/automations/isAutomationSessionCandidate';
import { resolveExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { isSessionRouteHydrationAvailable } from '@/sync/domains/session/sessionRouteHydrationState';
import {
    storage,
    useActiveServerAccountScope,
    useSession,
    useSessions,
    useSettings,
} from '@/sync/domains/state/storage';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sync } from '@/sync/sync';
import { isAutomationApiErrorCode } from '@/sync/api/automations/apiAutomations';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { getSessionName } from '@/utils/sessions/sessionUtils';

const stylesheet = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.background.canvas },
}));

type SessionAutomationTriggerDraft = AutomationTriggerEditorValue & Readonly<{
    /** Stable definition identity shared by plugin setup and response-loss rejoin. */
    pendingAutomationId: string;
}>;

function initialEditorDraft(): SessionAutomationTriggerDraft {
    return {
        pendingAutomationId: createAutomationEditorAutomationId(),
        removedTriggers: [],
        enabled: true,
        name: t('automations.create.defaultName'),
        description: null,
        triggers: [],
    };
}

function replaceWithCurrentExactTurns(
    draft: SessionAutomationTriggerDraft,
    targetSessionId: string,
): SessionAutomationTriggerDraft | null {
    let changed = false;
    let available = true;
    const triggers = draft.triggers.map((trigger) => {
        const definition = trigger.definition;
        if (definition?.kind !== 'sessionLifecycle' || definition.scope.kind !== 'exactTurn') return trigger;
        if (definition.scope.sourceSessionId === targetSessionId) {
            available = false;
            return trigger;
        }
        const exact = readExactActiveParentTurn(storage.getState().sessions[definition.scope.sourceSessionId]);
        if (!exact) {
            available = false;
            return trigger;
        }
        if (exact.sourceTurnId === definition.scope.sourceTurnId) return trigger;
        changed = true;
        return {
            ...trigger,
            definition: {
                ...definition,
                scope: { ...definition.scope, sourceTurnId: exact.sourceTurnId },
            },
        };
    });
    return available && changed ? { ...draft, triggers } : null;
}

export function SessionAutomationCreateScreen(props: Readonly<{
    sessionId: string;
    hydrationOptions?: Readonly<{ serverId?: string; forceRefresh?: boolean }>;
}>) {
    useUnistyles();
    const router = useRouter();
    const routeHydrationState = useHydrateSessionForRoute(
        props.sessionId,
        'SessionAutomationCreateScreen.hydrateTargetSession',
        props.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const session = useSession(props.sessionId);
    const sessions = useSessions() ?? [];
    const settings = useSettings();
    const activeAccountScope = useActiveServerAccountScope();
    const editorLifetimeIdentity = activeAccountScope
        && session?.serverId === activeAccountScope.serverId
        ? createAutomationEditorLifetimeIdentity(activeAccountScope, `${props.sessionId}:new`)
        : null;
    const support = useAutomationsSupport({ scopeKind: 'spawn', serverId: session?.serverId ?? null });
    const supportRef = React.useRef(support.enabled);
    supportRef.current = support.enabled;
    const { draft, setDraft, latestDraftRef } = useSessionAuthoringDraftState();
    const [editorDraft, setEditorDraft] = React.useState<SessionAutomationTriggerDraft>(initialEditorDraft);
    const [editorDraftLifetimeIdentity, setEditorDraftLifetimeIdentity] = React.useState<string | null>(
        () => editorLifetimeIdentity,
    );
    const latestEditorRef = React.useRef(editorDraft);
    latestEditorRef.current = editorDraft;
    const [submitting, setSubmitting] = React.useState(false);
    const submittingRef = React.useRef(false);

    React.useEffect(() => {
        if (editorDraftLifetimeIdentity === editorLifetimeIdentity) return;
        setEditorDraft(initialEditorDraft());
        setEditorDraftLifetimeIdentity(editorLifetimeIdentity);
    }, [editorDraftLifetimeIdentity, editorLifetimeIdentity, props.sessionId]);

    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(props.sessionId);
    const machineIdOverride = readMachineControlTargetForSession(props.sessionId)?.machineId ?? null;
    const availability = React.useMemo(() => resolveExistingSessionAutomationAvailability({
        sessionHydrated,
        session,
        machineIdOverride,
        sessionDekBase64,
        accountSettings: settings,
    }), [machineIdOverride, session, sessionDekBase64, sessionHydrated, settings]);
    const machineId = availability.kind === 'ready' ? availability.machineId : null;

    React.useEffect(() => {
        if (!session) return;
        setDraft((current) => refreshExistingSessionAuthoringDraftFromSessionSnapshot({
            session,
            currentDraft: current,
            sessionDekBase64,
            fallbackAutomationDraft: {
                enabled: latestEditorRef.current.enabled,
                name: latestEditorRef.current.name,
                description: latestEditorRef.current.description ?? '',
                triggers: latestEditorRef.current.triggers.flatMap((trigger) => (
                    trigger.definition
                        ? [{ clientId: trigger.clientId, definition: trigger.definition }]
                        : []
                )),
            },
        }));
    }, [session, sessionDekBase64, setDraft]);

    const sessionOptions = React.useMemo(() => sessions
        .filter((candidate) => (
            candidate.serverId === session?.serverId
            && candidate.id !== props.sessionId
            && isAutomationSessionCandidate(candidate, settings)
        ))
        .map((candidate) => ({
            sessionId: candidate.id,
            label: getSessionName(candidate),
            currentParentTurnId: readExactActiveParentTurn(candidate)?.sourceTurnId ?? null,
        })), [props.sessionId, session?.serverId, sessions, settings]);
    const isValid = support.enabled
        && availability.kind === 'ready'
        && editorDraftLifetimeIdentity === editorLifetimeIdentity
        && editorLifetimeIdentity !== null
        && Boolean(session && machineId && draft?.prompt.trim() && editorDraft.name.trim());

    const handleCreate = React.useCallback(async () => {
        if (submittingRef.current) return;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const capturedEditorLifetimeIdentity = editorDraftLifetimeIdentity;
        const authority = captureSessionAutomationAuthority({
            session: storage.getState().sessions[props.sessionId] ?? null,
            routeSessionId: props.sessionId,
            routeServerId: props.hydrationOptions?.serverId ?? null,
            activeServerId: getActiveServerSnapshot().serverId,
            automationsEnabled: supportRef.current,
            accountSettings: storage.getState().settings,
            accountLifetime,
            readCurrent: () => ({
                session: storage.getState().sessions[props.sessionId] ?? null,
                routeSessionId: props.sessionId,
                routeServerId: props.hydrationOptions?.serverId ?? null,
                activeServerId: getActiveServerSnapshot().serverId,
                automationsEnabled: supportRef.current,
                accountSettings: storage.getState().settings,
            }),
        });
        const currentDraft = latestDraftRef.current;
        const currentEditor = latestEditorRef.current;
        if (
            !authority
            || !currentDraft
            || !machineId
            || !currentDraft.prompt.trim()
            || !currentEditor.name.trim()
            || !capturedEditorLifetimeIdentity
            || capturedEditorLifetimeIdentity !== editorLifetimeIdentity
            || !isAutomationEditorLifetimeIdentityCurrent(
                capturedEditorLifetimeIdentity,
                accountLifetime?.scope ?? null,
                `${props.sessionId}:new`,
            )
        ) return;
        submittingRef.current = true;
        setSubmitting(true);
        const sourceDefinitions = currentEditor.triggers.flatMap((trigger) => (
            trigger.definition?.kind === 'sessionLifecycle' && trigger.definition.scope.kind === 'exactTurn'
                ? [trigger.definition]
                : []
        ));
        const sourceAuthorities = sourceDefinitions.flatMap((definition) => {
            if (definition.scope.sourceSessionId === props.sessionId) return [];
            const sourceSessionId = definition.scope.sourceSessionId;
            const sourceAuthority = captureSessionAutomationAuthority({
                session: storage.getState().sessions[sourceSessionId] ?? null,
                routeSessionId: sourceSessionId,
                routeServerId: session?.serverId ?? null,
                activeServerId: getActiveServerSnapshot().serverId,
                automationsEnabled: supportRef.current,
                accountSettings: storage.getState().settings,
                accountLifetime,
                readCurrent: () => ({
                    session: storage.getState().sessions[sourceSessionId] ?? null,
                    routeSessionId: sourceSessionId,
                    routeServerId: session?.serverId ?? null,
                    activeServerId: getActiveServerSnapshot().serverId,
                    automationsEnabled: supportRef.current,
                    accountSettings: storage.getState().settings,
                }),
            });
            return sourceAuthority ? [{
                authority: sourceAuthority,
                sourceSessionId,
                sourceTurnId: definition.scope.sourceTurnId,
            }] : [];
        });
        const sourceTurnsMatchDraft = sourceAuthorities.length === sourceDefinitions.length
            && sourceAuthorities.every((entry) => (
                readExactActiveParentTurn(
                    storage.getState().sessions[entry.sourceSessionId],
                )?.sourceTurnId === entry.sourceTurnId
            ));
        if (!sourceTurnsMatchDraft) {
            const replacement = replaceWithCurrentExactTurns(currentEditor, props.sessionId);
            if (replacement && await Modal.confirm(
                t('automations.exactTurn.staleTitle'),
                t('automations.exactTurn.staleBody'),
                { cancelText: t('common.cancel'), confirmText: t('automations.exactTurn.useCurrentTurn') },
            )) setEditorDraft(replacement);
            else if (!replacement) await Modal.alert(t('automations.exactTurn.staleTitle'), t('automations.exactTurn.staleBody'));
            submittingRef.current = false;
            setSubmitting(false);
            return;
        }
        const isCurrent = () => authority.isCurrent()
            && capturedEditorLifetimeIdentity === editorLifetimeIdentity
            && latestDraftRef.current === currentDraft
            && latestEditorRef.current === currentEditor
            // Pre-request eligibility above already proved every lifecycle row
            // matched the live exact turn. The response lifetime must not
            // re-read the turn: a completion that reaches the transcript after
            // the server commit is authoritative settled truth, not a reason
            // to reject the committed save.
            && sourceAuthorities.every((entry) => entry.authority.isCurrent());
        try {
            const encryption = sync.encryption;
            const recipe = await buildAutomationRecipeFromSessionAuthoring({
                credentials: sync.getCredentials(),
                templateVersion: 1,
                prompt: currentDraft.prompt.trim(),
                target: { kind: 'existingSession', sessionId: props.sessionId },
                ...(encryption
                    ? { encryptRaw: (value: unknown) => encryption.encryptAutomationTemplateRaw(value) }
                    : {}),
                isCurrent,
            });
            const saveDraft: AutomationEditorDraft = {
                ...currentEditor,
                automationId: null,
                expectedTemplateVersion: null,
                recipeDirty: true,
                executionRecipe: recipe,
                assignments: [{ machineId, enabled: true, priority: 100 }],
            };
            const saved = await sync.saveAutomationEditorDraft(saveDraft, { isCurrent });
            if (isCurrent()) navigateWithBlurOnWeb(() => router.replace(`/automations/${saved.id}` as any));
        } catch (error) {
            const exactTurnStale = isAutomationApiErrorCode(error, 'sourceTurnNotCurrent')
                || isAutomationApiErrorCode(error, 'sourceTurnNotInProgress')
                || isAutomationApiErrorCode(error, 'sourceTurnUnavailable')
                || isAutomationApiErrorCode(error, 'sourceSessionUnavailable')
                || (error instanceof Error && error.message === 'Automation authoring authority changed');
            if (authority.isCurrent() && exactTurnStale && latestEditorRef.current === currentEditor) {
                const replacement = replaceWithCurrentExactTurns(currentEditor, props.sessionId);
                if (replacement && await Modal.confirm(
                    t('automations.exactTurn.staleTitle'),
                    t('automations.exactTurn.staleBody'),
                    { cancelText: t('common.cancel'), confirmText: t('automations.exactTurn.useCurrentTurn') },
                )) setEditorDraft(replacement);
                else if (!replacement) await Modal.alert(t('automations.exactTurn.staleTitle'), t('automations.exactTurn.staleBody'));
            } else if (authority.isCurrent()) {
                await Modal.alert(t('common.error'), error instanceof Error ? error.message : t('automations.create.createFailed'));
            }
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    }, [
        editorDraftLifetimeIdentity,
        editorLifetimeIdentity,
        latestDraftRef,
        machineId,
        props.hydrationOptions?.serverId,
        props.sessionId,
        router,
        session?.serverId,
    ]);

    const missingReason = React.useMemo(() => getExistingSessionAutomationUnavailableReason(availability), [availability]);
    return (
        <View style={stylesheet.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <ExistingSessionAutomationAuthoringSurface
                        formVariant="create"
                        session={session}
                        draft={draft}
                        onChangeDraft={setDraft}
                        availability={availability}
                        isWaiting={availability.kind === 'hydrating'}
                        unavailableReason={missingReason}
                        onSubmit={() => { void handleCreate(); }}
                        submitAccessibilityLabel={t('automations.create.createButtonTitle')}
                        isSubmitDisabled={!isValid || submitting}
                        editable={!submitting}
                        automationEditor={editorDraftLifetimeIdentity === editorLifetimeIdentity && editorLifetimeIdentity !== null ? (
                            <AutomationTriggerEditor
                                value={editorDraft}
                                onChange={(next) => setEditorDraft((current) => ({
                                    ...(current.pendingAutomationId === editorDraft.pendingAutomationId
                                        ? next
                                        : current),
                                    pendingAutomationId: current.pendingAutomationId,
                                }))}
                                sessionOptions={sessionOptions}
                                resolveCurrentSessionTurn={(sessionId) => {
                                    const candidate = storage.getState().sessions[sessionId];
                                    if (!candidate || !isAutomationSessionCandidate(candidate, storage.getState().settings)) return null;
                                    const exact = readExactActiveParentTurn(candidate);
                                    return exact ? { sourceSessionId: exact.sourceSessionId, sourceTurnId: exact.sourceTurnId } : null;
                                }}
                                onSessionSelectionStale={() => { void sync.refreshSessions(); }}
                                renderPluginEventEditor={(editorProps) => (
                                    <PluginEventAutomationEditor
                                        key={editorProps.clientId}
                                        automationId={editorDraft.pendingAutomationId}
                                        clientId={editorProps.clientId}
                                        value={editorProps.value}
                                        seed={null}
                                        authoringMachineId={machineId}
                                        serverId={session?.serverId ?? null}
                                        onComplete={editorProps.onComplete}
                                        onCancel={editorProps.onCancel}
                                    />
                                )}
                                submitting={submitting}
                            />
                        ) : null}
                    />
                </View>
            </ItemList>
        </View>
    );
}
