import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetDefinitionV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { readMountedComposerPresentationSnapshot, requestRegisteredComposerFocus } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import { SaveAsWidgetPanel, type SaveAsWidgetConvertedInput } from './SaveAsWidgetPanel';
import { WidgetAboutPanel } from './WidgetAboutPanel';
import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';
import { WidgetDefinitionPanel, WidgetFlowShell } from './WidgetDefinitionPanel';
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
    const about = React.useMemo(() => (artifactId && scope ? () => setFlow('about') : undefined), [artifactId, scope]);
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
                {flow === 'about' && artifactId && instance ? (
                    <AboutFlow account={account} scope={scope} instance={instance} artifactId={artifactId} editInputs={editInputs}
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
    artifactId: string;
    editInputs?: Readonly<{ onPress: () => void; binding: string | null }> | undefined;
    onClose: () => void;
    testID: string;
}>): React.ReactElement {
    const [opened, setOpened] = React.useState<OpenedDefinition | 'loading' | 'unavailable'>('loading');
    const { account, artifactId } = props;
    const { serverId, accountId } = account;
    React.useEffect(() => {
        const controller = new AbortController();
        void runWidgetDefinitionCommand('widgets.definition.get', { account: { serverId, accountId }, artifactId }, { serverId, accountId }, controller.signal).then((outcome) => {
            if (controller.signal.aborted) return;
            setOpened(outcome.kind === 'applied' ? { definition: outcome.result.definition, placements: outcome.result.placementSummary ?? null } : 'unavailable');
        });
        return () => controller.abort();
    }, [accountId, artifactId, serverId]);

    if (opened === 'loading' || opened === 'unavailable') {
        return (
            <WidgetDefinitionPanel title={t('widgetDefinition.aboutTitle')} testID={props.testID}
                note={opened === 'unavailable' ? t('widgetDefinition.aboutUnavailable') : null}>
                {opened === 'loading' ? <ItemLoadStateRows testID={`${props.testID}.loading`} state={{ kind: 'loading' }} rows={4} lines={2} shape="list" /> : null}
            </WidgetDefinitionPanel>
        );
    }
    const draftTarget = readDraftTarget(props.scope, opened.definition);
    const editInputs = props.editInputs;
    return (
        <WidgetAboutPanel
            artifactId={artifactId}
            definition={opened.definition}
            placements={opened.placements}
            inputs={{ binding: editInputs?.binding ?? null,
                ...(editInputs ? { onEdit: () => { props.onClose(); editInputs.onPress(); } } : {}) }}
            onRefresh={async () => (await runWidgetDefinitionCommand('widgets.instance.refresh',
                { ref: { surface: props.scope, instanceId: props.instance.id } }, account)).kind === 'applied'}
            {...(draftTarget ? { onChangeWithAgent: () => {
                void draftWidgetChange({ scope: props.scope, sessionId: draftTarget.sessionId, name: opened.definition.name }).then((drafted) => {
                    if (drafted) props.onClose();
                });
            } } : {})}
            onDuplicate={async () => {
                const outcome = await runWidgetDefinitionCommand('widgets.definition.duplicate', { account, artifactId, newArtifactId: randomUUID() }, account);
                return outcome.kind === 'applied' ? outcome.result.definition.name : null;
            }}
            testID={props.testID}
        />
    );
}

/**
 * Change with the agent: drafts the request into that Session's mounted composer through
 * `composer.transaction.apply` and focuses it. It never sends; the person finishes the sentence.
 */
async function draftWidgetChange(input: Readonly<{ scope: WidgetSurfaceRefV1; sessionId: string; name: string }>): Promise<boolean> {
    const ref = { kind: 'session' as const, sessionId: input.sessionId };
    const scope = { serverId: input.scope.serverId, accountId: input.scope.accountId };
    const snapshot = readMountedComposerPresentationSnapshot({ ref, scope });
    if (!snapshot?.state.editable) return false;
    const draft = t('widgetDefinition.changeDraft', { widget: input.name });
    const text = snapshot.text.length > 0 && !snapshot.text.endsWith('\n') ? `\n${draft}` : draft;
    const outcome = await runWidgetDefinitionCommand('composer.transaction.apply', { scope, ref, transaction: {
        expectedRevision: snapshot.revision, operations: [{ kind: 'text.insert', position: { offset: snapshot.text.length }, text }],
    } }, scope);
    if (outcome.kind !== 'applied' || outcome.result.status !== 'applied') return false;
    requestRegisteredComposerFocus(ref);
    return true;
}
