import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetDefinitionV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { JsonValue } from '@happier-dev/protocol';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { describeAuthoredWidgetDefinitionV1, readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useConfiguredWidgetTarget } from '@/sync/domains/widgets/useConfiguredWidgetTarget';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readMountedComposerPresentationSnapshot } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { appendMountedComposerDraft } from '@/sync/ops/actions/appendMountedComposerDraft';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import { SaveAsWidgetPanel, type SaveAsWidgetConvertedInput } from './SaveAsWidgetPanel';
import { WidgetAboutPanel, readWidgetAboutSources } from './WidgetAboutPanel';
import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';
import type { IconName } from '@/components/ui/icons/Icon';
import { createWidgetSnapshotCaptureSlot, useWidgetSnapshotCaptureAvailable, type WidgetSnapshotCaptureSlot } from './widgetSnapshotCapture';
import { WidgetSnapshotConfirmPanel } from './WidgetSnapshotConfirmPanel';

type Flow = 'about' | 'save' | 'snapshot';

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

type OpenedDefinition = Readonly<{ definition: WidgetDefinitionV1; placements: Parameters<typeof WidgetAboutPanel>[0]['placements'] }>;

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
    scope: WidgetSurfaceRefV1 | null;
    anchorRef: React.RefObject<View | null>;
    editInputs?: Readonly<{ onPress: () => void; binding: string | null }> | undefined;
    sessionItem?: WidgetDefinitionSessionItem | null;
    providedContext?: Readonly<Record<string, readonly JsonValue[]>>;
    testID: string;
}>): Readonly<{
    about: (() => void) | undefined;
    saveAsYours: (() => void) | undefined;
    postSnapshot: (() => void) | undefined;
    snapshotSlot: WidgetSnapshotCaptureSlot;
    panel: React.ReactElement | null;
}> {
    const [flow, setFlow] = React.useState<Flow | null>(null);
    const [slot] = React.useState(createWidgetSnapshotCaptureSlot);
    const capturable = useWidgetSnapshotCaptureAvailable(slot);
    const { instance, scope, anchorRef, editInputs, sessionItem, testID } = input;
    const artifactId = instance?.definition.kind === 'artifact' ? instance.definition.artifactId : null;
    const close = React.useCallback(() => setFlow(null), []);
    const about = React.useMemo(() => (instance && scope ? () => setFlow('about') : undefined), [instance, scope]);
    const onBoard = scope?.owner.kind === 'sessionBoard';
    const saveAsYours = React.useMemo(() => (onBoard && sessionItem?.savable ? () => setFlow('save') : undefined), [onBoard, sessionItem?.savable]);
    const postSnapshot = React.useMemo(() => (onBoard && sessionItem?.canEdit && capturable ? () => setFlow('snapshot') : undefined),
        [capturable, onBoard, sessionItem?.canEdit]);

    let panel: React.ReactElement | null = null;
    if (flow && scope) {
        const title = flow === 'about' ? t('widgetDefinition.aboutTitle') : flow === 'save' ? t('widgetDefinition.saveTitle') : t('widgetDefinition.snapshotTitle');
        const account = { serverId: scope.serverId, accountId: scope.accountId };
        panel = (
            <WidgetFlowShell anchorRef={anchorRef} title={title} onRequestClose={close} testID={`${testID}.${flow}`}>
                {flow === 'about' && instance ? (
                    <AboutFlow key={`${scope.serverId}/${scope.accountId}/${instance.id}/${artifactId ?? instance.definition.kind}`} account={account} scope={scope} instance={instance} artifactId={artifactId} editInputs={editInputs}
                        providedContext={input.providedContext}
                        onClose={close} testID={`${testID}.about`} />
                ) : flow === 'save' && sessionItem && scope.owner.kind === 'sessionBoard' ? (
                    <SaveAsWidgetPanel
                        account={account}
                        session={{ serverId: scope.serverId, sessionId: scope.owner.sessionId }}
                        itemId={sessionItem.itemId}
                        defaultName={sessionItem.title}
                        converted={sessionItem.converted}
                        {...(sessionItem.renderPreview ? { preview: sessionItem.renderPreview() } : {})}
                        onCancel={close}
                        onDone={close}
                        testID={`${testID}.save`}
                    />
                ) : flow === 'snapshot' && sessionItem ? (
                    <WidgetSnapshotConfirmPanel surface={scope} title={sessionItem.title} sourceLabel={sessionItem.sourceLabel}
                        {...(sessionItem.mark ? { mark: sessionItem.mark } : {})} watch={slot.watch}
                        capture={slot.capture} onCancel={close} onDone={close} testID={`${testID}.snapshot`} />
                ) : null}
            </WidgetFlowShell>
        );
    }
    return { about, saveAsYours, postSnapshot, snapshotSlot: slot, panel };
}

function AboutFlow(props: Readonly<{
    account: Readonly<{ serverId: string; accountId: string }>;
    scope: WidgetSurfaceRefV1;
    instance: WidgetInstanceV1;
    artifactId: string | null;
    providedContext?: Readonly<Record<string, readonly JsonValue[]>>;
    editInputs?: Readonly<{ onPress: () => void; binding: string | null }> | undefined;
    onClose: () => void;
    testID: string;
}>): React.ReactElement {
    const [opened, setOpened] = React.useState<OpenedDefinition | 'loading' | 'unavailable'>('loading');
    const { account, artifactId } = props;
    const { serverId, accountId } = account;
    const viewer = useActiveServerAccountScope();
    const current = areServerAccountScopesEqual(viewer, account);
    React.useEffect(() => {
        if (!artifactId || !current) return;
        const controller = new AbortController();
        void runWidgetDefinitionCommand('widgets.definition.get', { account: { serverId, accountId }, artifactId }, { serverId, accountId }, controller.signal).then((outcome) => {
            if (controller.signal.aborted) return;
            setOpened(outcome.kind === 'applied' ? { definition: outcome.result.definition, placements: outcome.result.placementSummary ?? null } : 'unavailable');
        });
        return () => controller.abort();
    }, [accountId, artifactId, serverId, current]);

    if (!current) return <WidgetFlowPanel title={t('widgetDefinition.aboutTitle')} testID={props.testID} onClose={props.onClose}
        note={t('widgetDefinition.aboutUnavailable')}>{null}</WidgetFlowPanel>;
    if (artifactId && (opened === 'loading' || opened === 'unavailable')) {
        return (
            <WidgetFlowPanel title={t('widgetDefinition.aboutTitle')} testID={props.testID} onClose={props.onClose}
                note={opened === 'unavailable' ? t('widgetDefinition.aboutUnavailable') : null}>
                {opened === 'loading' ? <ItemLoadStateRows testID={`${props.testID}.loading`} state={{ kind: 'loading' }} rows={4} lines={2} shape="list" /> : null}
            </WidgetFlowPanel>
        );
    }
    const definition = !artifactId ? props.instance.definition.kind === 'inline' ? props.instance.definition.definition : null
        : typeof opened === 'object' ? opened.definition : null;
    const placements = artifactId && typeof opened === 'object' ? opened.placements
        : { placements: [{ surface: props.scope, instanceId: props.instance.id }], unavailableScopes: [] };
    return <AboutResolvedFlow {...props} definition={definition} placements={placements} />;
}

function AboutResolvedFlow(props: Parameters<typeof AboutFlow>[0] & Readonly<{
    definition: WidgetDefinitionV1 | null;
    placements: Parameters<typeof WidgetAboutPanel>[0]['placements'];
}>): React.ReactElement {
    const runtime = useAppShellPluginUiProjection();
    const definition = props.definition;
    const installed = readWidgetDescriptor(runtime.pluginUiProjection,
        definition?.body.kind === 'installed' ? definition.body : props.instance.definition);
    const reference = props.instance.definition;
    const descriptor = definition && (reference.kind === 'inline' || reference.kind === 'artifact')
        ? describeAuthoredWidgetDefinitionV1(definition, reference, installed) : installed;
    const providedContext = React.useMemo(() => props.providedContext ?? (props.scope.owner.kind === 'sessionBoard' || props.scope.owner.kind === 'companion'
        ? { session: [{ serverId: props.scope.serverId, sessionId: props.scope.owner.sessionId }] } : {}),
    [props.providedContext, props.scope]);
    const name = definition?.name ?? descriptor?.title ?? props.instance.displayName ?? t('widgetDefinition.aboutUnavailable');
    return <AboutBoundFlow {...props} descriptor={descriptor} runtime={runtime} providedContext={providedContext} name={name} />;
}

/** Only the open panel resolves target metadata; closed frame menus issue no read. */
function AboutBoundFlow(props: Parameters<typeof AboutResolvedFlow>[0] & Readonly<{
    descriptor: WidgetCandidate | null;
    runtime: ReturnType<typeof useAppShellPluginUiProjection>;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    name: string;
}>): React.ReactElement {
    // An unavailable definition still has About, but cannot borrow another target's source facts.
    if (!props.descriptor) return <AboutPanelContent {...props} resolution={null} />;
    return <AboutAdmittedFlow {...props} descriptor={props.descriptor} />;
}

function AboutAdmittedFlow(props: Parameters<typeof AboutBoundFlow>[0] & Readonly<{ descriptor: WidgetCandidate }>): React.ReactElement {
    const resolution = useConfiguredWidgetTarget({ scope: props.scope, instance: props.instance, descriptor: props.descriptor,
        providedContext: props.providedContext, appRuntime: props.runtime });
    return <AboutPanelContent {...props} resolution={resolution} />;
}

function AboutPanelContent(props: Parameters<typeof AboutBoundFlow>[0] & Readonly<{
    resolution: Parameters<typeof readWidgetAboutSources>[0]['resolution'];
}>): React.ReactElement {
    const { account, artifactId } = props;
    const draftTarget = readDraftTarget(props.scope, props.definition);
    const editInputs = props.editInputs;
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
                ...(editInputs ? { onEdit: () => { props.onClose(); editInputs.onPress(); } } : {}) }}
            onRefresh={async () => (await runWidgetDefinitionCommand('widgets.instance.refresh',
                { ref: { surface: props.scope, instanceId: props.instance.id } }, account)).kind === 'applied'}
            {...(draftTarget ? { onChangeWithAgent: () => {
                void appendMountedComposerDraft({ scope: account, ref: { kind: 'session', sessionId: draftTarget.sessionId },
                    text: t('widgetDefinition.changeDraft', { widget: props.name }) }).then((drafted) => {
                    if (drafted) props.onClose();
                });
            } } : {})}
            {...(artifactId ? { onDuplicate: async () => {
                const outcome = await runWidgetDefinitionCommand('widgets.definition.duplicate', { account, artifactId, newArtifactId: randomUUID() }, account);
                return outcome.kind === 'applied' ? outcome.result.definition.name : null;
            } } : {})}
            testID={props.testID}
        />
    );
}
