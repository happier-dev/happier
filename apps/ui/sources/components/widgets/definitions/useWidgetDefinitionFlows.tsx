import * as React from 'react';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { View } from 'react-native';
import { isPublicProfileWidgetSurfaceV1, type WidgetDefinitionV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { canPromoteSessionWidgetDefinitionSourceV1 } from '@happier-dev/protocol/widgets/widgetDefinitionPromotionV1';

import { useAppShellPluginUiProjectionCurrentness } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { describeAuthoredWidgetDefinitionV1, readWidgetDescriptor, resolveWidgetInstanceTitle, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useConfiguredWidgetTarget } from '@/sync/domains/widgets/useConfiguredWidgetTarget';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readMountedComposerPresentationSnapshot } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { appendMountedComposerDraft } from '@/sync/ops/actions/appendMountedComposerDraft';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

import { SaveAsWidgetPanel, type SaveAsWidgetConvertedInput } from './SaveAsWidgetPanel';
import { WidgetAboutPanel, readWidgetAboutSources } from './WidgetAboutPanel';
import { createWidgetArtifactWriteAttempt, runWidgetDefinitionCommand } from './widgetDefinitionCommands';
import { useWidgetDefinitionFlowRead } from './useWidgetDefinitionFlowRead';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { WIDGET_FLOW_WIDTH_PX, WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';
import type { IconName } from '@/components/ui/icons/Icon';
import { createWidgetSnapshotCaptureSlot, useWidgetSnapshotCaptureAvailable, type WidgetSnapshotCaptureSlot } from './widgetSnapshotCapture';
import { buildWidgetSnapshotPreview, WidgetSnapshotConfirmPanel } from './WidgetSnapshotConfirmPanel';
import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { WidgetCopyChooser, WidgetCopyPanel, type WidgetCopyAttempt } from './WidgetCopyPanel';

type Flow = 'about' | 'save' | 'snapshot' | 'addTo';

/** A Session Board card: what Save as your widget and Post a snapshot need from it. */
export type WidgetDefinitionSessionItem = Readonly<{
    itemId: string;
    title: string;
    /** Save as your widget copies widgets and inert declarative content; other item kinds stay where they are. */
    savable: boolean;
    /** Posting a snapshot writes to the shared Board: only an editor can. */
    canEdit: boolean;
    converted: readonly SaveAsWidgetConvertedInput[];
    /** Where the snapshot's numbers come from, for its provenance ("analytics replica"). */
    sourceLabel: string;
    /** The card's own mark, so the snapshot shows the same card. */
    mark?: IconName;
    renderPreview?: () => React.ReactNode;
}>;

/** Save borrows the primary body's admitted snapshot, never another executable or Resource read. */
function WidgetSavePreview(props: Readonly<{ slot: WidgetSnapshotCaptureSlot; sourceLabel: string; testID: string }>): React.ReactElement {
    const [, changed] = React.useReducer((revision: number) => revision + 1, 0);
    React.useLayoutEffect(() => {
        const unwatch = props.slot.watch(changed);
        // The mounted body can publish between this preview's render and subscription.
        changed();
        return unwatch;
    }, [props.slot]);
    const preview = buildWidgetSnapshotPreview(props.slot.capture(), props.sourceLabel, Date.now());
    return preview
        ? <SessionBoardDeclarativeContent document={preview.document} snapshot actionBinding={null} testID={props.testID} />
        : <SurfaceStateCard kind="empty" size="line" accessibilitySemantics="status" testID={props.testID}
            title={t('sessionBoard.item.runningElsewhere.title')} detail={t('sessionBoard.item.runningElsewhere.reason')} />;
}

/** The Session whose mounted composer can take a drafted change request, when one is on screen. */
function readDraftTarget(scope: WidgetSurfaceRefV1, definition: WidgetDefinitionV1 | null): Readonly<{ sessionId: string }> | null {
    const candidates = [
        scope.owner.kind === 'sessionBoard' || scope.owner.kind === 'companion' ? scope.owner.sessionId : null,
        definition?.provenance.source.kind === 'session' ? definition.provenance.source.sessionId : null,
    ];
    for (const sessionId of candidates) {
        if (!sessionId) continue;
        const snapshot = readMountedComposerPresentationSnapshot({ ref: { kind: 'session', sessionId }, scope: { serverId: scope.serverId, accountId: scope.accountId } });
        if (snapshot?.state.editable) return { sessionId };
    }
    return null;
}

/**
 * A placed copy's definition flows, the same on every surface: About this widget (with Duplicate
 * and Change with the agent), and on a Session Board card Save as your widget and Post a snapshot.
 * Each opens anchored to the card's ⋯ (a sheet on a phone) and each entry exists only when its
 * operation can succeed here. The card wraps its body in the returned capture slot so Post a
 * snapshot reads exactly what it shows.
 */
export function useWidgetDefinitionFlows(input: Readonly<{
    instance: WidgetInstanceV1 | null;
    title?: string;
    scope: WidgetSurfaceRefV1 | null;
    /** The containing layout's admitted viewer is distinct from its stored owner. */
    admittedViewer?: ServerAccountScope;
    isCurrent?: () => boolean;
    anchorRef: React.RefObject<View | null>;
    /**
     * A card that sits among siblings opens every flow on its own card, not at the ⋯: the card's own
     * `anchorRef` sits at its top edge and `reveal` brings the card into view first, so a panel never opens over a
     * sibling or from a ⋯ that has scrolled away. Without it the flows open at the ⋯ (`anchorRef`).
     */
    card?: Readonly<{ anchorRef: React.RefObject<View | null>; reveal: () => void }>;
    editInputs?: Readonly<{ onPress: (event?: unknown, callerContext?: ActionExecutorContext) => void; binding: string | null }> | undefined;
    sessionItem?: WidgetDefinitionSessionItem | null;
    providedContext?: Readonly<Record<string, readonly JsonValue[]>>;
    testID: string;
}>): Readonly<{
    about: (() => void) | undefined;
    addTo: (() => void) | undefined;
    saveAsYours: (() => void) | undefined;
    postSnapshot: (() => void) | undefined;
    snapshotSlot: WidgetSnapshotCaptureSlot;
    panel: React.ReactElement | null;
}> {
    const [openedFlow, setFlow] = React.useState<Readonly<{ kind: Flow; callerContext?: ActionExecutorContext }> | null>(null);
    const flow = openedFlow?.kind;
    const [slot] = React.useState(createWidgetSnapshotCaptureSlot);
    const capturable = useWidgetSnapshotCaptureAvailable(slot);
    const { instance, scope, editInputs, sessionItem, testID } = input;
    const card = input.card;
    const anchorRef = card?.anchorRef ?? input.anchorRef;
    const artifactId = instance?.definition.kind === 'artifact' ? instance.definition.artifactId : null;
    // Add to… chooses its place in the shared chooser first; the copy's setup then opens at setup width.
    const [copySelection, setCopyTo] = React.useState<Readonly<{ key: string; callerContext?: ActionExecutorContext }> | null>(null);
    const copyTo = copySelection?.key ?? null;
    // Save as your widget hands each place the person chose to the same setup Add to… uses; the copy it created stays.
    const [placing, setPlacing] = React.useState<Readonly<{ saved: WidgetDefinitionV1; instance: WidgetInstanceV1; remaining: readonly string[];
        attempts: ReadonlyMap<string, WidgetCopyAttempt> }> | null>(null);
    const close = React.useCallback(() => { setFlow(null); setCopyTo(null); setPlacing(null); }, []);
    const stopPlacing = React.useCallback(() => {
        if (placing && ![...placing.attempts.values()].some(attempt => attempt.placement?.outcome()?.kind === 'unconfirmed')) {
            publishPresentationNotice({ key: `widget-save:${instance?.id ?? 'item'}`, severity: 'info', message: t('widgetDefinition.savedButNotPlaced') });
        }
        close();
    }, [close, instance?.id, placing]);
    const placeNext = React.useCallback(() => {
        const [next, ...remaining] = placing?.remaining ?? [];
        if (!placing || next === undefined) { close(); return; }
        setCopyTo({ key: next });
        setPlacing({ ...placing, remaining });
    }, [close, placing]);
    const open = React.useCallback((next: Flow, callerContext?: ActionExecutorContext) => { card?.reveal(); setFlow({ kind: next, callerContext }); }, [card]);
    const about = React.useMemo(() => (instance && scope ? (_input?: unknown, callerContext?: ActionExecutorContext) => open('about', callerContext) : undefined), [instance, open, scope]);
    const addTo = React.useMemo(() => (instance && scope && (scope.owner.kind !== 'sessionBoard'
        || canPromoteSessionWidgetDefinitionSourceV1({ kind: 'widget', instance })) ? () => open('addTo') : undefined), [instance, open, scope]);
    const onBoard = scope?.owner.kind === 'sessionBoard';
    const saveAsYours = React.useMemo(() => (onBoard && sessionItem?.savable ? () => open('save') : undefined), [onBoard, open, sessionItem?.savable]);
    const postSnapshot = React.useMemo(() => (onBoard && sessionItem?.canEdit && capturable ? () => open('snapshot') : undefined),
        [capturable, onBoard, open, sessionItem?.canEdit]);
    const widgetTitle = input.title ?? sessionItem?.title ?? (instance
        ? resolveWidgetInstanceTitle(instance, readWidgetDescriptor(null, instance.definition)) : '');
    const openers = [
        { key: 'about', title: t('widgetDefinition.aboutTitle'), invoke: about },
        { key: 'addTo', title: t('widgetFrame.groupAddTo'), invoke: addTo },
        { key: 'save', title: t('widgetDefinition.saveTitle'), invoke: saveAsYours },
        { key: 'snapshot', title: t('widgetDefinition.snapshotTitle'), invoke: postSnapshot },
    ].flatMap(entry => entry.invoke ? [{ key: entry.key, title: `${entry.title}: ${widgetTitle}`, invoke: entry.invoke }] : []);
    const commands = useCurrentUiContextLocalCommands([
        ...openers,
        ...(flow ? [{ key: 'close', title: `${t('common.close')}: ${widgetTitle}`, invoke: placing ? stopPlacing : close }] : []),
        ...(copyTo !== null && !placing ? [{ key: 'back', title: `${t('common.back')}: ${widgetTitle}`, invoke: () => setCopyTo(null) }] : []),
    ], { unbound: 'local' });
    const dismiss = React.useCallback(() => { void commands.invoke('close'); }, [commands]);
    const showAbout = React.useCallback(() => { void commands.invoke('about'); }, [commands]);
    const showAddTo = React.useCallback(() => { void commands.invoke('addTo'); }, [commands]);
    const showSave = React.useCallback(() => { void commands.invoke('save'); }, [commands]);
    const showSnapshot = React.useCallback(() => { void commands.invoke('snapshot'); }, [commands]);

    let panel: React.ReactElement | null = null;
    if (flow === 'about' && scope && instance) {
        // The read belongs to the open flow, above the shell that recomposes on resize.
        panel = <AboutFlow key={`${scope.serverId}/${scope.accountId}/${instance.id}/${artifactId ?? instance.definition.kind}`}
            account={input.admittedViewer ?? { serverId: scope.serverId, accountId: scope.accountId }}
            callerContext={openedFlow?.callerContext}
            isCurrent={input.isCurrent} scope={scope} instance={instance} artifactId={artifactId}
            anchorRef={anchorRef} editInputs={editInputs} providedContext={input.providedContext} onClose={dismiss} testID={`${testID}.about`} />;
    } else if (flow === 'addTo' && scope && instance && copyTo === null) {
        panel = <WidgetCopyChooser instance={instance} current={scope} anchorRef={anchorRef}
            onChoose={(key, callerContext) => setCopyTo({ key, callerContext })} onClose={dismiss} testID={`${testID}.addTo`} />;
    } else if (flow && scope) {
        const placeInstance = placing?.instance ?? instance;
        const title = flow === 'about' ? t('widgetDefinition.aboutTitle') : flow === 'save' ? t('widgetDefinition.saveTitle')
            : flow === 'addTo' ? t('widgetFrame.groupAddTo') : t('widgetDefinition.snapshotTitle');
        const account = { serverId: scope.serverId, accountId: scope.accountId };
        panel = (
            <WidgetFlowShell anchorRef={anchorRef} title={title} onRequestClose={dismiss} testID={`${testID}.${flow}`}
                {...(flow === 'addTo' ? { width: WIDGET_FLOW_WIDTH_PX.setup } : {})}>
                {flow === 'addTo' && placeInstance && copyTo !== null ? (
                    <WidgetCopyPanel instance={placeInstance} current={scope} destinationKey={copyTo} providedContext={input.providedContext ?? {}}
                        callerContext={copySelection?.callerContext}
                        {...(placing ? { saved: placing.saved, attempt: placing.attempts.get(copyTo), onDone: placeNext, onClose: dismiss } : { onBack: () => { void commands.invoke('back'); }, onClose: dismiss })}
                        testID={`${testID}.addTo`} />
                ) : flow === 'save' && sessionItem && scope.owner.kind === 'sessionBoard' ? (
                    <SaveAsWidgetPanel
                        account={account}
                        session={{ serverId: scope.serverId, sessionId: scope.owner.sessionId }}
                        instance={instance}
                        itemId={sessionItem.itemId}
                        defaultName={sessionItem.title}
                        converted={sessionItem.converted}
                        preview={sessionItem.renderPreview?.() ?? <WidgetSavePreview slot={slot} sourceLabel={sessionItem.sourceLabel} testID={`${testID}.save.snapshotPreview`} />}
                        {...(sessionItem.mark ? { mark: sessionItem.mark } : {})}
                        sourceLabel={sessionItem.sourceLabel}
                        providedContext={input.providedContext ?? {}}
                        onCancel={dismiss}
                        onDone={close}
                        onSaved={(saved, [first = null, ...remaining], attempts) => {
                            // The copy is placed from what it is: the item's widget, or its own definition when it declares no inputs.
                            setPlacing({ saved, remaining, attempts, instance: instance ?? { v: 1, id: sessionItem.itemId, definition: { kind: 'inline', definition: saved }, bindings: {} } });
                            setCopyTo(first === null ? null : { key: first }); setFlow({ kind: 'addTo' });
                        }}
                        testID={`${testID}.save`}
                    />
                ) : flow === 'snapshot' && sessionItem?.canEdit && capturable ? (
                    <WidgetSnapshotConfirmPanel surface={scope} title={sessionItem.title} sourceLabel={sessionItem.sourceLabel}
                        {...(sessionItem.mark ? { mark: sessionItem.mark } : {})} watch={slot.watch}
                        capture={slot.capture} onCancel={dismiss} onDone={close} testID={`${testID}.snapshot`} />
                ) : null}
            </WidgetFlowShell>
        );
    }
    return { about: about ? showAbout : undefined, addTo: addTo ? showAddTo : undefined, saveAsYours: saveAsYours ? showSave : undefined,
        postSnapshot: postSnapshot ? showSnapshot : undefined, snapshotSlot: slot, panel };
}

function AboutFlow(props: Readonly<{
    account: Readonly<{ serverId: string; accountId: string }>;
    isCurrent?: () => boolean;
    callerContext?: ActionExecutorContext;
    scope: WidgetSurfaceRefV1;
    instance: WidgetInstanceV1;
    artifactId: string | null;
    anchorRef: React.RefObject<View | null>;
    providedContext?: Readonly<Record<string, readonly JsonValue[]>>;
    editInputs?: Readonly<{ onPress: (event?: unknown, callerContext?: ActionExecutorContext) => void; binding: string | null }> | undefined;
    onClose: () => void;
    testID: string;
}>): React.ReactElement {
    const opened = useWidgetDefinitionFlowRead(props);
    const { current, state } = opened;
    const { artifactId } = props;

    let content: React.ReactElement;
    if (!current) content = <WidgetFlowPanel title={t('widgetDefinition.aboutTitle')} testID={props.testID} onClose={props.onClose}
        note={t('widgetDefinition.aboutUnavailable')}>{null}</WidgetFlowPanel>;
    else if (artifactId && (state === 'loading' || state === 'unavailable')) {
        content = (
            <WidgetFlowPanel title={t('widgetDefinition.aboutTitle')} testID={props.testID} onClose={props.onClose}
                note={state === 'unavailable' ? t('widgetDefinition.aboutUnavailable') : null}>
                {state === 'loading' ? <ItemLoadStateRows testID={`${props.testID}.loading`} state={{ kind: 'loading' }} rows={4} lines={2} shape="list" /> : null}
            </WidgetFlowPanel>
        );
    } else {
        content = <AboutResolvedFlow {...props} definition={opened.definition} placements={opened.placements} />;
    }
    return <WidgetFlowShell anchorRef={props.anchorRef} title={t('widgetDefinition.aboutTitle')}
        onRequestClose={props.onClose} testID={props.testID}>{content}</WidgetFlowShell>;
}

function AboutResolvedFlow(props: Parameters<typeof AboutFlow>[0] & Readonly<{
    definition: WidgetDefinitionV1 | null;
    placements: Parameters<typeof WidgetAboutPanel>[0]['placements'];
}>): React.ReactElement {
    const runtime = useAppShellPluginUiProjectionCurrentness();
    const definition = props.definition;
    const localize = usePluginLocalizedTextResolver({ projection: runtime.pluginUiProjection });
    const installed = definition && definition.body.kind !== 'installed' && definition.body.kind !== 'builtin' ? null : readWidgetDescriptor(runtime.pluginUiProjection,
        definition?.body.kind === 'installed' || definition?.body.kind === 'builtin' ? definition.body : props.instance.definition,
        definition?.name ? undefined : localize);
    const reference = props.instance.definition;
    const descriptor = definition && (reference.kind === 'inline' || reference.kind === 'artifact')
        ? describeAuthoredWidgetDefinitionV1(definition, reference, installed) : installed;
    const providedContext = React.useMemo(() => props.providedContext ?? (props.scope.owner.kind === 'sessionBoard' || props.scope.owner.kind === 'companion'
        ? { session: [{ serverId: props.scope.serverId, sessionId: props.scope.owner.sessionId }] } : {}),
    [props.providedContext, props.scope]);
    const name = definition?.name ?? descriptor?.title ?? props.instance.displayName ?? t('widgetDefinition.aboutUnavailable');
    const source = definition?.body ?? props.instance.definition;
    // About can open while the widget body is deferred; presentation metadata
    // alone does not establish the executable Resource declarations.
    return <>
        {!isPublicProfileWidgetSurfaceV1(props.scope) && source.kind === 'installed' ? <PluginSurfaceProjectionDemand
            pluginId={source.surface.pluginId} accountScope={props.account} /> : null}
        <AboutBoundFlow {...props} descriptor={descriptor} runtime={runtime} providedContext={providedContext} name={name} />
    </>;
}

/** Only the open panel resolves target metadata; closed frame menus issue no read. */
function AboutBoundFlow(props: Parameters<typeof AboutResolvedFlow>[0] & Readonly<{
    descriptor: WidgetCandidate | null;
    runtime: ReturnType<typeof useAppShellPluginUiProjectionCurrentness>;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    name: string;
}>): React.ReactElement {
    // An unavailable definition still has About, but cannot borrow another target's source facts.
    if (!props.descriptor) return <AboutPanelContent {...props} resolution={null} />;
    return <AboutAdmittedFlow {...props} descriptor={props.descriptor} />;
}

function AboutAdmittedFlow(props: Parameters<typeof AboutBoundFlow>[0] & Readonly<{ descriptor: WidgetCandidate }>): React.ReactElement {
    const resolution = useConfiguredWidgetTarget({ scope: props.scope, admittedViewer: props.account,
        instance: props.instance, descriptor: props.descriptor,
        providedContext: props.providedContext, appRuntime: props.runtime });
    return <AboutPanelContent {...props} resolution={resolution} />;
}

function AboutPanelContent(props: Parameters<typeof AboutBoundFlow>[0] & Readonly<{
    resolution: Parameters<typeof readWidgetAboutSources>[0]['resolution'];
}>): React.ReactElement {
    const { account, artifactId } = props;
    const duplicate = React.useRef<ReturnType<typeof createWidgetArtifactWriteAttempt<'widgets.definition.duplicate'>> | null>(null);
    const draftTarget = readDraftTarget(props.scope, props.definition);
    const editInputs = props.editInputs;
    const commands = useCurrentUiContextLocalCommands([
        ...(editInputs ? [{ key: 'editInputs', title: `${t('common.edit')}: ${props.name}`,
            invoke: (_input: unknown, callerContext?: ActionExecutorContext) => {
                props.onClose(); editInputs.onPress(undefined, callerContext);
            } }] : []),
        ...(draftTarget ? [{ key: 'changeWithAgent', title: `${t('widgetDefinition.changeWithAgent')}: ${props.name}`,
            invoke: async (_input: unknown, callerContext?: ActionExecutorContext) => {
                const drafted = await appendMountedComposerDraft({ scope: account,
                    ref: { kind: 'session', sessionId: draftTarget.sessionId }, callerContext,
                    text: t('widgetDefinition.changeDraft', { widget: props.name }) });
                if (drafted) props.onClose();
            } }] : []),
    ], { unbound: 'local' });
    return (
        <WidgetAboutPanel
            onClose={props.onClose}
            {...(artifactId ? { artifactId } : {})}
            definition={props.definition}
            descriptor={props.descriptor}
            name={props.name}
            sources={readWidgetAboutSources({ definition: props.definition, descriptor: props.descriptor, resolution: props.resolution })}
            placements={props.placements}
            inputs={{ binding: editInputs?.binding ?? null,
                ...(editInputs ? { onEdit: () => { void commands.invoke('editInputs'); } } : {}) }}
            onRefresh={() => runWidgetDefinitionCommand('widgets.item.refresh',
                { ref: { surface: props.scope, instanceId: props.instance.id } }, account)}
            {...(draftTarget ? { onChangeWithAgent: () => { void commands.invoke('changeWithAgent'); } } : {})}
            {...(artifactId ? { onDuplicate: async () => {
                duplicate.current ??= createWidgetArtifactWriteAttempt('widgets.definition.duplicate', account);
                const outcome = await duplicate.current.run(() => ({ account, artifactId, newArtifactId: randomUUID() }));
                // Approval now owns this copy too; a later explicit Duplicate is a new intent.
                if (outcome.kind !== 'refused') duplicate.current = null;
                return outcome.kind === 'applied' ? outcome.result.definition.name : null;
            } } : {})}
            testID={props.testID}
        />
    );
}
