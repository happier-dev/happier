import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import {
    AutomationSourceSelectorIdV1Schema,
    type AutomationDefinitionDetail,
    type AutomationTriggerDefinitionInput,
} from '@happier-dev/protocol';

import { AutomationPluralEditorScreen } from '@/components/automations/editor/AutomationPluralEditorScreen';
import {
    readPluginEventAutomationEditSeed,
    readPluginEventAutomationPrivateDetail,
    type PluginEventAutomationEditSeed,
    type PluginEventAutomationStoredContentAccess,
} from '@/components/automations/editor/pluginEventAutomationEditSeed';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import {
    areExactTurnAutomationPrefillsEqual,
    buildExactTurnAutomationRouteParams,
    readExactActiveParentTurn,
    type ExactTurnAutomationPrefill,
} from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { layout } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { Modal } from '@/modal';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { isAutomationApiErrorCode } from '@/sync/api/automations/apiAutomations';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    automationEditorDraftFromDetail,
    createAutomationEditorLifetimeIdentity,
    isAutomationEditorLifetimeIdentityCurrent,
    createAutomationEditorTriggerClientId,
    shouldValidateAutomationEditorLifecycleTrigger,
    type AutomationEditorDraft,
    type AutomationEditorTriggerDefinitionSeed,
} from '@/sync/domains/automations/automationEditorDraft';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureSessionAutomationAuthority } from '@/sync/domains/automations/sessionAutomationAuthority';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage, useActiveServerAccountScope, useAutomation, useSessions } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { getSessionName } from '@/utils/sessions/sessionUtils';

const stylesheet = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.background.canvas },
    centered: { minHeight: 180, alignItems: 'center', justifyContent: 'center' },
    content: { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' },
}));

function definitionSeedForNonEvent(
    trigger: Exclude<AutomationEditorHydrationTrigger, Readonly<{ kind: 'pluginEvent' }>>,
): AutomationEditorTriggerDefinitionSeed {
    const definition: AutomationTriggerDefinitionInput = trigger.kind === 'schedule'
        ? { kind: 'schedule', enabled: trigger.enabled, schedule: trigger.schedule }
        : {
            kind: 'sessionLifecycle',
            enabled: trigger.enabled,
            event: trigger.event,
            scope: trigger.scope,
            consumption: trigger.consumption,
        };
    return { definition };
}

type AutomationEditorHydrationTrigger = AutomationDefinitionDetail['triggers'][number];

function buildTriggerSeeds(params: Readonly<{
    definition: NonNullable<ReturnType<typeof useAutomation>>;
    access: PluginEventAutomationStoredContentAccess;
}>): ReadonlyMap<string, AutomationEditorTriggerDefinitionSeed> | null {
    if (params.definition.detail.kind !== 'available') return null;
    const seeds = new Map<string, AutomationEditorTriggerDefinitionSeed>();
    for (const trigger of params.definition.detail.value.triggers) {
        if (trigger.kind !== 'pluginEvent') {
            seeds.set(trigger.id, definitionSeedForNonEvent(trigger));
            continue;
        }
        const privateDetail = readPluginEventAutomationPrivateDetail(
            params.definition,
            trigger.id,
            params.access,
        );
        if (!privateDetail) return null;
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.safeParse(trigger.sourceSelectorId);
        if (!sourceSelectorId.success) return null;
        seeds.set(trigger.id, {
            // Durable endpoint setup is deliberately not reconstructed. The
            // Event composer replaces this row with a fresh strict input only
            // after the author explicitly edits its source.
            definition: null,
            retainedEvent: {
                kind: 'pluginEvent',
                enabled: trigger.enabled,
                displayLabel: privateDetail.storedDefinition.displayLabel,
                eventRef: trigger.eventRef,
            },
            eventSourceBinding: {
                sourceSelectorId: sourceSelectorId.data,
                sourceInstanceId: privateDetail.storedDefinition.sourceInstanceId,
            },
            retainedEventPrivateDefinition: privateDetail.storedDefinition,
        });
    }
    return seeds;
}

function appendExactTurnPrefill(
    draft: AutomationEditorDraft,
    prefill: ExactTurnAutomationPrefill | null,
): AutomationEditorDraft {
    if (!prefill) return draft;
    if (draft.triggers.some((trigger) => (
        trigger.definition?.kind === 'sessionLifecycle'
        && trigger.definition.scope.sourceSessionId === prefill.sourceSessionId
        && trigger.definition.scope.sourceTurnId === prefill.sourceTurnId
    ))) return draft;
    return {
        ...draft,
        triggers: [...draft.triggers, {
            clientId: createAutomationEditorTriggerClientId(),
            persisted: null,
            definition: {
                kind: 'sessionLifecycle',
                enabled: true,
                event: 'parentTurnCompleted',
                scope: {
                    kind: 'exactTurn',
                    sourceSessionId: prefill.sourceSessionId,
                    sourceTurnId: prefill.sourceTurnId,
                },
                consumption: 'once',
            },
        }],
    };
}

function replaceLifecycleRowsWithCurrentTurns(draft: AutomationEditorDraft): AutomationEditorDraft | null {
    let changed = false;
    const triggers = draft.triggers.map((trigger) => {
        const definition = trigger.definition;
        if (definition?.kind !== 'sessionLifecycle' || !shouldValidateAutomationEditorLifecycleTrigger(trigger)) {
            return trigger;
        }
        const current = readExactActiveParentTurn(
            storage.getState().sessions[definition.scope.sourceSessionId],
        );
        if (!current) return null;
        if (
            draft.executionRecipe.target.kind === 'existingSession'
            && draft.executionRecipe.target.sessionId === current.sourceSessionId
        ) return null;
        if (current.sourceTurnId === definition.scope.sourceTurnId) return trigger;
        changed = true;
        return {
            ...trigger,
            isDirty: trigger.persisted !== null || trigger.isDirty === true,
            definition: {
                ...definition,
                scope: {
                    ...definition.scope,
                    sourceSessionId: current.sourceSessionId,
                    sourceTurnId: current.sourceTurnId,
                },
            },
        };
    });
    if (triggers.some((trigger) => trigger === null)) return null;
    return changed ? { ...draft, triggers: triggers as AutomationEditorDraft['triggers'] } : draft;
}

export function AutomationEditorHostScreen(props: Readonly<{
    automationId: string;
    exactTurnPrefill?: ExactTurnAutomationPrefill | null;
}>) {
    const router = useRouter();
    const definition = useAutomation(props.automationId);
    const sessions = useSessions() ?? [];
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope();
    const editorLifetimeIdentity = activeAccountScope?.serverId === activeServer.serverId
        ? createAutomationEditorLifetimeIdentity(activeAccountScope, props.automationId)
        : null;
    const exactTurnSupport = useAutomationsSupport({
        scopeKind: 'spawn',
        serverId: props.exactTurnPrefill?.sourceServerId ?? activeServer.serverId,
    });
    const exactTurnSupportRef = React.useRef(exactTurnSupport.enabled);
    exactTurnSupportRef.current = exactTurnSupport.enabled;
    const sourceSession = props.exactTurnPrefill
        ? sessions.find((session) => session.id === props.exactTurnPrefill!.sourceSessionId) ?? null
        : null;
    const exactTurnAuthority = React.useMemo(() => props.exactTurnPrefill
        ? captureSessionAutomationAuthority({
            session: sourceSession,
            routeSessionId: props.exactTurnPrefill.sourceSessionId,
            routeServerId: props.exactTurnPrefill.sourceServerId,
            activeServerId: activeServer.serverId,
            automationsEnabled: exactTurnSupport.enabled,
            accountLifetime: captureActiveServerAccountScopeLifetime(),
            readCurrent: () => ({
                session: storage.getState().sessions[props.exactTurnPrefill!.sourceSessionId] ?? null,
                routeSessionId: props.exactTurnPrefill!.sourceSessionId,
                routeServerId: props.exactTurnPrefill!.sourceServerId,
                activeServerId: getActiveServerSnapshot().serverId,
                automationsEnabled: exactTurnSupportRef.current,
            }),
        })
        : null, [
        activeServer.serverId,
        exactTurnSupport.enabled,
        props.exactTurnPrefill,
        sourceSession,
    ]);
    const [draft, setDraft] = React.useState<AutomationEditorDraft | null>(null);
    const [draftLifetimeIdentity, setDraftLifetimeIdentity] = React.useState<string | null>(null);
    const latestDraftRef = React.useRef(draft);
    latestDraftRef.current = draft;
    const [loadError, setLoadError] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [stalePrefill, setStalePrefill] = React.useState<ExactTurnAutomationPrefill | null>(null);
    const [eventEditSeeds, setEventEditSeeds] = React.useState<ReadonlyMap<string, PluginEventAutomationEditSeed>>(
        () => new Map(),
    );
    const [reloadGeneration, setReloadGeneration] = React.useState(0);
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);

    React.useEffect(() => {
        let alive = true;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        setLoadError(false);
        setDraft(null);
        setDraftLifetimeIdentity(null);
        setEventEditSeeds(new Map());
        setStalePrefill(null);
        void (async () => {
            const credentials = sync.getCredentials();
            if (!credentials || !accountLifetime) throw new Error('Automation Account is unavailable');
            const capturedIdentity = createAutomationEditorLifetimeIdentity(
                accountLifetime.scope,
                props.automationId,
            );
            if (capturedIdentity !== editorLifetimeIdentity) return;
            const refreshed = await sync.refreshAutomationDefinitionDetail(props.automationId);
            const mode = await fetchAccountEncryptionMode(credentials);
            if (!alive || !accountLifetime.isCurrent() || !refreshed || refreshed.detail.kind !== 'available') return;
            const access: PluginEventAutomationStoredContentAccess = mode.mode === 'plain'
                ? { mode: 'plain' }
                : { mode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials) };
            const seeds = buildTriggerSeeds({ definition: refreshed, access });
            const hydrated = seeds
                ? automationEditorDraftFromDetail(refreshed.detail.value, seeds)
                : null;
            if (!hydrated) throw new Error('Automation definition is unavailable');
            const observed = props.exactTurnPrefill ?? null;
            const current = observed
                ? readExactActiveParentTurn(storage.getState().sessions[observed.sourceSessionId])
                : null;
            const observedIsAuthorized = !observed || (
                exactTurnAuthority?.isCurrent() === true
                && areExactTurnAutomationPrefillsEqual(observed, current)
            );
            const withPrefill = observed && observedIsAuthorized
                ? appendExactTurnPrefill(hydrated, observed)
                : hydrated;
            if (alive && accountLifetime.isCurrent() && capturedIdentity === editorLifetimeIdentity) {
                const nextEventSeeds = new Map<string, PluginEventAutomationEditSeed>();
                for (const trigger of refreshed.detail.value.triggers) {
                    if (trigger.kind !== 'pluginEvent') continue;
                    const seed = readPluginEventAutomationEditSeed(refreshed, trigger.id, access);
                    if (seed) nextEventSeeds.set(trigger.id, seed);
                }
                setEventEditSeeds(nextEventSeeds);
                setStalePrefill(observed && !observedIsAuthorized
                    ? observed
                    : null);
                setDraftLifetimeIdentity(capturedIdentity);
                setDraft(withPrefill);
            }
        })().catch(() => {
            if (alive && accountLifetime?.isCurrent()) setLoadError(true);
        });
        return () => { alive = false; };
    }, [editorLifetimeIdentity, exactTurnAuthority, props.automationId, props.exactTurnPrefill, reloadGeneration]);

    const sessionOptions = React.useMemo(() => sessions
        .filter((session) => session.serverId === activeServer.serverId)
        .map((session) => ({
        sessionId: session.id,
        label: getSessionName(session),
        currentParentTurnId: readExactActiveParentTurn(session)?.sourceTurnId ?? null,
        selectable: draft?.executionRecipe.target.kind !== 'existingSession'
            || draft.executionRecipe.target.sessionId !== session.id,
    })), [activeServer.serverId, draft?.executionRecipe.target, sessions]);
    const eventAuthoringMachineId = React.useMemo(() => (
        draft?.assignments.find((assignment) => assignment.enabled)?.machineId
        ?? draft?.assignments[0]?.machineId
        ?? null
    ), [draft?.assignments]);

    const handleSave = React.useCallback(async () => {
        const capturedDraft = latestDraftRef.current;
        const capturedDraftLifetimeIdentity = draftLifetimeIdentity;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const observed = props.exactTurnPrefill ?? null;
        const exactTurnIsCurrent = () => !observed || (
            exactTurnAuthority?.isCurrent() === true
            && areExactTurnAutomationPrefillsEqual(
                observed,
                readExactActiveParentTurn(storage.getState().sessions[observed.sourceSessionId]),
            )
        );
        const lifecycleAuthorities = capturedDraft && accountLifetime
            ? capturedDraft.triggers.flatMap((trigger) => {
                if (!shouldValidateAutomationEditorLifecycleTrigger(trigger)) return [];
                const definition = trigger.definition;
                if (definition?.kind !== 'sessionLifecycle') return [];
                const sourceSession = storage.getState().sessions[definition.scope.sourceSessionId] ?? null;
                const authority = captureSessionAutomationAuthority({
                    session: sourceSession,
                    routeSessionId: definition.scope.sourceSessionId,
                    routeServerId: sourceSession?.serverId ?? null,
                    activeServerId: getActiveServerSnapshot().serverId,
                    automationsEnabled: exactTurnSupportRef.current,
                    accountLifetime,
                    readCurrent: () => ({
                        session: storage.getState().sessions[definition.scope.sourceSessionId] ?? null,
                        routeSessionId: definition.scope.sourceSessionId,
                        routeServerId: sourceSession?.serverId ?? null,
                        activeServerId: getActiveServerSnapshot().serverId,
                        automationsEnabled: exactTurnSupportRef.current,
                    }),
                });
                return authority ? [{ authority, definition }] : [];
            })
            : [];
        const lifecycleRows = capturedDraft?.triggers.filter(
            shouldValidateAutomationEditorLifecycleTrigger,
        ).length ?? 0;
        const lifecycleTurnsAreCurrent = () => lifecycleAuthorities.length === lifecycleRows
            && lifecycleAuthorities.every(({ authority, definition }) => (
                authority.isCurrent()
                && readExactActiveParentTurn(
                    storage.getState().sessions[definition.scope.sourceSessionId],
                )?.sourceTurnId === definition.scope.sourceTurnId
            ));
        if (
            !capturedDraft
            || !accountLifetime
            || !capturedDraftLifetimeIdentity
            || capturedDraftLifetimeIdentity !== editorLifetimeIdentity
            || !isAutomationEditorLifetimeIdentityCurrent(
                capturedDraftLifetimeIdentity,
                accountLifetime.scope,
                props.automationId,
            )
            || submitting
            || !exactTurnIsCurrent()
            || !lifecycleTurnsAreCurrent()
        ) {
            if (observed) setStalePrefill(observed);
            if (capturedDraft && !observed && lifecycleRows > 0) {
                void sync.refreshSessions();
                const replacement = replaceLifecycleRowsWithCurrentTurns(capturedDraft);
                if (replacement && replacement !== capturedDraft && await Modal.confirm(
                    t('automations.exactTurn.staleTitle'),
                    t('automations.exactTurn.staleBody'),
                    { cancelText: t('common.cancel'), confirmText: t('automations.exactTurn.useCurrentTurn') },
                )) setDraft(replacement);
                else if (!replacement) {
                    await Modal.alert(t('automations.exactTurn.staleTitle'), t('automations.exactTurn.staleBody'));
                }
            }
            return;
        }
        const isCurrent = () => mountedRef.current
            && accountLifetime.isCurrent()
            && capturedDraftLifetimeIdentity === editorLifetimeIdentity
            && exactTurnIsCurrent()
            && lifecycleTurnsAreCurrent()
            && latestDraftRef.current === capturedDraft;
        setSubmitting(true);
        try {
            const saved = await sync.saveAutomationEditorDraft(capturedDraft, { isCurrent });
            if (isCurrent()) {
                navigateWithBlurOnWeb(() => router.replace(`/automations/${saved.id}` as never));
            }
        } catch (error) {
            const exactTurnRejected = isAutomationApiErrorCode(error, 'sourceTurnNotCurrent')
                || isAutomationApiErrorCode(error, 'sourceTurnNotInProgress')
                || isAutomationApiErrorCode(error, 'sourceTurnUnavailable')
                || isAutomationApiErrorCode(error, 'sourceSessionUnavailable');
            if (observed && accountLifetime.isCurrent() && exactTurnRejected) {
                setStalePrefill(observed);
                void sync.refreshSessions();
            } else if (accountLifetime.isCurrent() && exactTurnRejected && lifecycleRows > 0) {
                void sync.refreshSessions();
                const replacement = replaceLifecycleRowsWithCurrentTurns(capturedDraft);
                if (replacement && replacement !== capturedDraft && await Modal.confirm(
                    t('automations.exactTurn.staleTitle'),
                    t('automations.exactTurn.staleBody'),
                    { cancelText: t('common.cancel'), confirmText: t('automations.exactTurn.useCurrentTurn') },
                )) setDraft(replacement);
                else if (!replacement) {
                    await Modal.alert(t('automations.exactTurn.staleTitle'), t('automations.exactTurn.staleBody'));
                }
            } else if (accountLifetime.isCurrent()) {
                await Modal.alert(t('common.error'), error instanceof Error ? error.message : t('automations.edit.updateFailed'));
            }
        } finally {
            if (mountedRef.current) setSubmitting(false);
        }
    }, [draftLifetimeIdentity, editorLifetimeIdentity, exactTurnAuthority, props.automationId, props.exactTurnPrefill, router, submitting]);

    if (!draft || draftLifetimeIdentity !== editorLifetimeIdentity) {
        return (
            <View style={stylesheet.root}>
                <View style={stylesheet.content}>
                    {loadError ? (
                        <SurfaceStateCard
                            kind="error"
                            title={t('common.error')}
                            reason={t('automations.edit.loadTemplateFailed')}
                            action={{ label: t('common.retry'), onPress: () => setReloadGeneration((value) => value + 1) }}
                            accessibilitySemantics="alert"
                        />
                    ) : (
                        <View style={stylesheet.centered}><ActivitySpinner size="small" /></View>
                    )}
                </View>
            </View>
        );
    }

    return (
        <View style={stylesheet.root}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={stylesheet.content}>
                    {stalePrefill ? (
                        <SurfaceStateCard
                            testID="automation-edit-exact-turn-stale"
                            kind="warning"
                            title={t('automations.exactTurn.staleTitle')}
                            reason={t('automations.exactTurn.staleBody')}
                            {...(() => {
                                const current = readExactActiveParentTurn(
                                    storage.getState().sessions[stalePrefill.sourceSessionId],
                                );
                                return current ? {
                                    action: {
                                        label: t('automations.exactTurn.useCurrentTurn'),
                                        onPress: () => router.setParams(buildExactTurnAutomationRouteParams(current)),
                                    },
                                } : {};
                            })()}
                            accessibilitySemantics="alert"
                        />
                    ) : null}
                    <AutomationPluralEditorScreen
                        variant="edit"
                        value={draft}
                        onChange={setDraft}
                        sessionOptions={sessionOptions}
                        resolveCurrentSessionTurn={(sessionId) => {
                            const current = readExactActiveParentTurn(storage.getState().sessions[sessionId]);
                            return current ? {
                                sourceSessionId: current.sourceSessionId,
                                sourceTurnId: current.sourceTurnId,
                            } : null;
                        }}
                        onSessionSelectionStale={() => { void sync.refreshSessions(); }}
                        renderPluginEventEditor={(editorProps) => (
                            <PluginEventAutomationEditor
                                key={editorProps.clientId}
                                automationId={draft.automationId ?? draft.pendingAutomationId!}
                                clientId={editorProps.clientId}
                                value={editorProps.value}
                                seed={eventEditSeeds.get(editorProps.clientId) ?? null}
                                authoringMachineId={eventAuthoringMachineId}
                                serverId={getActiveServerSnapshot().serverId ?? null}
                                onComplete={editorProps.onComplete}
                                onCancel={editorProps.onCancel}
                            />
                        )}
                        onSubmit={() => { void handleSave(); }}
                        onCancel={() => router.back()}
                        submitting={submitting}
                        submitDisabled={!draft.name.trim()}
                    />
                </View>
            </ItemList>
        </View>
    );
}
