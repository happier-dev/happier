import * as React from 'react';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { View } from 'react-native';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { composeWidgetGroupContextV1, isWidgetTargetHostableV1, projectWidgetBindingInputV1, readWidgetDefinitionNetworkOverrideV1,
    type WidgetDefinitionV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useWorkBoardReadState, useWorkBoardSummaries } from '@/components/boards/model/useWorkBoards';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useOpenAppSection } from '@/components/appShell/workspace/destinationRoute';
import { createBoardRoute } from '@/components/boards/boardsRoutes';
import { useOpenPhoneHome } from '@/components/navigation/shell/PhoneHomeLogoButton';
import { useOpenProject } from '@/components/projects/useOpenProject';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { WidgetSetupStep } from '@/components/widgets/add/WidgetSetupStep';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { listWidgetGroupProjects, resolveWidgetGroupCopyDestinations, WidgetCopyDestinationMenu, type WidgetGroupCopyDestination } from '@/components/widgets/group/widgetGroupCopy';
import { widgetSetupBlockingIssues, type WidgetSetup, type WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import { buildWidgetCandidateSetup, widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor, resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { storage, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useDeviceType } from '@/utils/platform/responsive';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { isPublicProfileWidgetSurfaceV1, projectWidgetPublicProfileDescriptorV1, translateWidgetPublicProfileCopyV1 } from '@happier-dev/protocol/widgets';

import { createWidgetArtifactWriteAttempt, getWidgetItemAddAttempt, type WidgetItemAddAttempt } from './widgetDefinitionCommands';

/** An open copy owns promotion and placement independently, including a Save → setup handoff. */
export type WidgetCopyAttempt = {
    promotion?: ReturnType<typeof createWidgetArtifactWriteAttempt<'widgets.definition.saveFromSession'>>;
    placement?: WidgetItemAddAttempt;
};

/**
 * The copy's candidate and the places that can host it: never where it already is. The one owner of
 * which destinations a widget copy offers, for Add to… and for Save as your widget's optional places.
 * A Session item that is not a configurable widget (declarative or HTML content) declares no inputs,
 * so every destination can host it.
 */
export function useWidgetCopyTarget(instance: WidgetInstanceV1 | null, current: WidgetSurfaceRefV1) {
    const pluginUiProjection = useAppShellPluginUiProjection(value => value.pluginUiProjection);
    const localize = usePluginLocalizedTextResolver({ projection: pluginUiProjection });
    const installed = React.useMemo(() => instance ? readWidgetDescriptor(pluginUiProjection, instance.definition, instance.displayName ? undefined : localize) : null,
        [pluginUiProjection, instance, localize]);
    const candidate = useWidgetInstanceDescriptor(current, instance, installed);
    const refs = useWorkspaceRefs();
    const publicProfile = useFeatureDecision('account.publicProfiles', { scopeKind: 'spawn', serverId: current.serverId });
    const publicProfileEnabled = publicProfile?.state === 'enabled';
    // Names only: choosing a place never opens a Board's record. They arrive after the first paint, so the caller reserves their row.
    const boards = useWorkBoardSummaries();
    const boardsRead = useWorkBoardReadState();
    // Until the Account's Board store is current it answers "scope retired" with nothing read: that is still waiting, not an empty list.
    const boardsLoading = boardsRead.status === 'loading' || (!boardsRead.hasSnapshot && boardsRead.errorCode === 'board_scope_retired');
    const destinations = React.useMemo(() => resolveWidgetGroupCopyDestinations({ current,
        projects: listWidgetGroupProjects(refs, current.serverId), boards: boards.map(board => ({ boardId: board.id, label: board.name })), publicProfileEnabled })
        .filter(destination => instance === null || (candidate && isWidgetTargetHostableV1(candidate, destination.surface.owner.kind)
            && (!isPublicProfileWidgetSurfaceV1(destination.surface) || projectWidgetPublicProfileDescriptorV1(instance.definition, candidate)))), [boards, candidate, current, instance, refs, publicProfileEnabled]);
    return { candidate, destinations, boardsLoading };
}

/**
 * Add to… for one widget, step one: the same chooser a group uses (lab wgmenu C/M), anchored to the
 * card's ⋯. Choosing a place moves on to the copy's setup; it never adds by itself, because the
 * destination may need inputs the source page supplied. Mounted only while open.
 */
export function WidgetCopyChooser(props: Readonly<{
    instance: WidgetInstanceV1;
    current: WidgetSurfaceRefV1;
    anchorRef: React.RefObject<View | null>;
    onChoose: (destinationKey: string, callerContext?: ActionExecutorContext) => void;
    onClose: () => void;
    testID: string;
}>) {
    const { destinations } = useWidgetCopyTarget(props.instance, props.current);
    const { onChoose } = props;
    const commands = useCurrentUiContextLocalCommands(destinations.map(destination => ({ key: destination.key,
        title: destination.label, invoke: (_input: unknown, callerContext?: ActionExecutorContext) => onChoose(destination.key, callerContext) })), { unbound: 'local' });
    return <WidgetCopyDestinationMenu destinations={destinations} anchorRef={props.anchorRef}
        onChoose={destination => { void commands.invoke(destination.key); }} onClose={props.onClose} testID={`${props.testID}.destination`} />;
}

/**
 * Add to… step two: the chosen place's setup, with the source's resolved inputs copied in rather
 * than its context promises; the destination's setup owns rebinding. Back returns to the chooser.
 */
export function WidgetCopyPanel(props: Readonly<{
    instance: WidgetInstanceV1;
    current: WidgetSurfaceRefV1;
    destinationKey: string;
    callerContext?: ActionExecutorContext;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    /** A library copy Save as your widget already created: placement only, never a second promotion. */
    saved?: WidgetDefinitionV1;
    attempt?: WidgetCopyAttempt;
    /** Absent when there is no chooser to return to (the places a Save chose). */
    onBack?: () => void;
    onClose: () => void;
    /** After the copy is placed or waits for approval; defaults to closing the flow. */
    onDone?: () => void;
    testID: string;
}>) {
    const { candidate, destinations } = useWidgetCopyTarget(props.instance, props.current);
    const destination = destinations.find(entry => entry.key === props.destinationKey);
    if (!candidate || !destination) return (
        <WidgetFlowPanel title={t('widgetFrame.groupAddTo')} {...(props.onBack ? { onBack: props.onBack } : {})} onCancel={props.onClose} testID={props.testID}
            note={t('widgetDefinition.aboutUnavailable')}>{null}</WidgetFlowPanel>
    );
    return <WidgetCopySetupPanel key={destination.key} {...props} candidate={candidate} destination={destination} />;
}

function WidgetCopySetupPanel(props: React.ComponentProps<typeof WidgetCopyPanel> & Readonly<{
    candidate: WidgetCandidate;
    destination: WidgetGroupCopyDestination;
}>) {
    const { candidate, destination, instance } = props;
    const phone = useDeviceType() === 'phone';
    const promoted = React.useRef<WidgetDefinitionV1 | null>(props.saved ?? null);
    const [attempt] = React.useState<WidgetCopyAttempt>(() => props.attempt ?? {});
    const [unconfirmed, setUnconfirmed] = React.useState<WidgetItemAddAttempt | null>(() => {
        const placement = getWidgetItemAddAttempt({ surface: props.current, instanceId: instance.id }, destination.surface, attempt.placement);
        return placement.outcome()?.kind === 'unconfirmed' ? placement : null;
    });
    const done = (result: Extract<WidgetSetupSubmitResult, { ok: true }>) => {
        publishPresentationNotice({ key: `widget-copy:${instance.id}`, severity: 'info', message: result.approvalPending
            ? `${promoted.current ? `${t('widgetDefinition.savedButNotPlaced')} ` : ''}${t('widgetAdd.areaApprovalPending')}`
            : t('widgetAdd.justAdded', { widget: resolveWidgetInstanceTitle(instance, candidate) }) });
        (props.onDone ?? props.onClose)();
    };
    if (unconfirmed) return <WidgetPlacementCheck attempt={unconfirmed} destination={destination}
        onBack={props.onBack} onClose={props.onClose} testID={props.testID} phone={phone} onChecked={outcome => {
            attempt.placement = unconfirmed;
            if (outcome?.kind === 'applied') done({ ok: true });
            else if (outcome?.kind !== 'unconfirmed') setUnconfirmed(null);
        }} />;
    const setup = buildWidgetCopySetup({ candidate, destination, instance, current: props.current,
        providedContext: props.providedContext, promoted, attempt, onUnconfirmed: setUnconfirmed, testID: props.testID });
    return <WidgetSetupStep setup={setup} callerContext={props.callerContext} phone={phone} {...(props.onBack ? { onBack: props.onBack } : {})}
        onCancel={props.onClose} onDone={done} serverId={props.current.serverId} testID={`${props.testID}.setup`} />;
}

function WidgetPlacementCheck(props: Readonly<{
    attempt: WidgetItemAddAttempt;
    destination: WidgetGroupCopyDestination;
    onBack?: () => void;
    onClose: () => void;
    onChecked(outcome: Awaited<ReturnType<WidgetItemAddAttempt['check']>>): void;
    phone: boolean;
    testID: string;
}>) {
    const openSection = useOpenAppSection();
    const openPhoneHome = useOpenPhoneHome();
    const { open: openProject } = useOpenProject();
    const [checking, setChecking] = React.useState(false);
    const openDestination = async (surface: WidgetSurfaceRefV1) => {
        const active = getActiveServerAccountScope();
        if (active?.accountId !== surface.accountId || !areServerProfileIdentifiersEquivalent(active.serverId, surface.serverId)) return;
        const owner = surface.owner;
        if (owner.kind === 'home') {
            if (props.phone) openPhoneHome();
            else openSection('/');
        } else if (owner.kind === 'workBoard') {
            openSection(createBoardRoute(owner.boardId));
        } else if (owner.kind === 'project') {
            const project = projectGroupIdentityKey({ serverId: surface.serverId, projectKey: owner.projectId });
            const baseline = buildProjectGroupDisplayIndex(readProjectWorkspaceRefs(storage.getState())).get(project)?.baseline;
            if (baseline) await openProject(baseline.id, { serverId: surface.serverId, layoutId: null });
        } else if (isPublicProfileWidgetSurfaceV1(surface)) {
            openSection(SETTINGS_ROUTES.accountPublicProfileEdit);
        }
    };
    const check = async () => {
        setChecking(true);
        const pending = props.attempt.check();
        void openDestination(props.destination.surface);
        const outcome = await pending;
        setChecking(false);
        props.onChecked(outcome);
    };
    return <WidgetFlowPanel title={t('widgetFrame.groupAddTo')} onBack={props.onBack} onCancel={props.onClose} phone={props.phone}
        note={t('widgetDefinition.placementUnconfirmed')} testID={props.testID}
        primary={{ label: t('widgetDefinition.placementCheck'), onPress: () => { void check(); }, busy: checking, disabled: checking, testID: `${props.testID}.check` }}>
        {null}
    </WidgetFlowPanel>;
}

/**
 * One place's copy setup: the destination's inputs with the source's resolved values copied in (never
 * its context promises), submitted through the same Actions an agent uses. The one owner for Add to…'s
 * second step and for Save as your widget's places, which it fills without a step when nothing is left
 * to choose (`placeWidgetCopyWhenReady`).
 */
export function buildWidgetCopySetup(input: Readonly<{
    candidate: WidgetCandidate;
    destination: WidgetGroupCopyDestination;
    instance: WidgetInstanceV1;
    current: WidgetSurfaceRefV1;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    /** The library copy this flow made (or Save as your widget made); filled by the first placement otherwise. */
    promoted: { current: WidgetDefinitionV1 | null };
    attempt?: WidgetCopyAttempt;
    onUnconfirmed?: (attempt: WidgetItemAddAttempt) => void;
    testID: string;
}>): WidgetSetup {
    const { candidate, destination, promoted, current, instance } = input;
    const publicDestination = isPublicProfileWidgetSurfaceV1(destination.surface);
    const attempt = input.attempt ?? {};
    const projects = composeWidgetGroupContextV1({ surfaceOwner: destination.surface.owner, providedContext: {} }).projects?.[0];
    const context: WidgetSurfaceContext = projects !== undefined ? { slots: {
        projects: { label: t('widgetAdd.thisProject'), value: { value: projects, label: destination.label } },
    } } : {};
    const copiedInput = projectWidgetBindingInputV1({ instance: instance, fields: candidate.inputs?.fields ?? [],
        context: input.providedContext, viewerValues: {} });
    const providedContext = widgetProvidedContext(context);
    return buildWidgetCandidateSetup({ candidate, context, audience: 'personal', scope: destination.surface,
        mode: { kind: 'add', submitLabel: t('widgetAdd.areaAddTo', { surface: destination.label }), copiedInput },
        submit: async draft => {
            const placementAttempt = getWidgetItemAddAttempt({ surface: current, instanceId: instance.id }, destination.surface, attempt.placement);
            attempt.placement = placementAttempt;
            const unconfirmed = (outcome: Readonly<{ errorCode: string; details?: unknown }>) => {
                input.onUnconfirmed?.(placementAttempt);
                return { ok: false as const, errorCode: outcome.errorCode, details: outcome.details, message: t('widgetDefinition.placementUnconfirmed') };
            };
            const existing = placementAttempt.outcome();
            if (existing?.kind === 'unconfirmed') return unconfirmed(existing);
            const sourceOwner = current.owner;
            if (sourceOwner.kind === 'sessionBoard' && !promoted.current) {
                attempt.promotion ??= createWidgetArtifactWriteAttempt('widgets.definition.saveFromSession', current);
                const saved = await attempt.promotion.run(() => ({
                    account: { serverId: current.serverId, accountId: current.accountId },
                    session: { serverId: current.serverId, sessionId: sourceOwner.sessionId },
                    itemId: instance.id, artifactId: randomUUID(),
                }));
                if (saved.kind === 'approvalPending') return { ok: true, approvalPending: true };
                if (saved.kind === 'refused') return { ok: false, message: t('widgetDefinition.saveFailed') };
                promoted.current = saved.result.definition;
            }
            const definition = promoted.current;
            const { networkOverride: _sourceNetworkOverride, ...sourceInstance } = instance;
            const networkOverride = definition ? readWidgetDefinitionNetworkOverrideV1(definition) : undefined;
            const outcome = await placementAttempt.run(() => {
                const copy: WidgetInstanceV1 = definition ? { ...sourceInstance, id: randomUUID(), definition: { kind: 'artifact', artifactId: definition.id },
                    bindings: draft.bindings, ...(networkOverride ? { networkOverride } : {}) }
                    : { ...instance, id: randomUUID(), bindings: draft.bindings };
                const placement = publicDestination ? translateWidgetPublicProfileCopyV1(copy,
                    definition ? { ...candidate, authoredDefinition: definition,
                        publicPresentation: definition.publicPresentation ?? candidate.publicPresentation } : candidate) : copy;
                if (!placement) throw Object.assign(new Error('Public snapshot unavailable'), { code: 'widget_public_profile_presentation_unavailable' });
                return { surface: destination.surface, instance: placement,
                    ...(destination.area ? { area: destination.area } : {}), ...(draft.size ? { size: draft.size } : {}) };
            },
                { surface: destination.surface, values: providedContext });
            if (outcome.kind === 'unconfirmed') return unconfirmed(outcome);
            if (outcome.kind === 'refused' || outcome.kind === 'absent') {
                return { ok: false, message: t(definition ? 'widgetDefinition.savedButNotPlaced' : 'widgetAdd.addFailed') };
            }
            return { ok: true, ...(outcome.kind === 'approvalPending' ? { approvalPending: true } : {}) };
        },
        renderPreview: ({ draft }) => <WidgetSetupPreview scope={destination.surface} providedContext={providedContext}
            candidate={candidate} draft={draft} testID={`${input.testID}.preview`} />,
    });
}

/**
 * Places a saved copy straight away when its setup already has every value it needs here; otherwise
 * leaves it to that place's setup step. Returns what happened, or null when the step is still needed.
 */
export async function placeWidgetCopyWhenReady(setup: WidgetSetup): Promise<WidgetSetupSubmitResult | null> {
    if (widgetSetupBlockingIssues(setup.fields, setup.resolve(setup.initial)).length > 0) return null;
    return setup.submit(setup.initial);
}
