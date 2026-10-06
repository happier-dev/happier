import * as React from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';
import { projectWidgetSnapshotPreviewV1, type WidgetSnapshotPreviewV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import type { IconName } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import { WidgetFlowPanel, WidgetPreviewWell, widgetFlowText } from '@/components/widgets/flow/WidgetFlowPanel';

import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';
import { WidgetSnapshotNote } from './WidgetSnapshotNote';
import type { WidgetSnapshotCapture } from './widgetSnapshotCapture';

/**
 * The frozen preview, built once from what the card shows when the person opens the confirm: the
 * numbers cannot change under them while they decide, and Post sends exactly this payload. A card
 * still refreshing, stale or failed yields nothing — a snapshot posts current numbers or none.
 */
export function buildWidgetSnapshotPreview(capture: WidgetSnapshotCapture | null, sourceLabel: string, now: number): WidgetSnapshotPreviewV1 | null {
    if (!capture || !capture.current) return null;
    return projectWidgetSnapshotPreviewV1({
        document: capture.document,
        frozenByPath: capture.frozenByPath,
        asOf: new Date(now).toISOString(),
        provenance: capture.digests.length > 0
            ? capture.digests.map((digest) => ({ label: sourceLabel, digest }))
            : [{ label: sourceLabel }],
    });
}

/**
 * Post a snapshot (lab `dashboards` dscope VS): who will see it, the exact card they will see with
 * its "as of" and its own mark, and that it will not update and the connection stays the poster's.
 * One primary action; Cancel writes nothing. Publication goes through `widgets.snapshot.post`, whose
 * existing approval policy may hold it for the Inbox — then this says so instead of claiming it posted.
 *
 * A card that is refreshing, stale or failed has no current numbers to post, so the confirm offers
 * the card's own Refresh rather than a dead end; once its reads are current the preview freezes in
 * place and Post is offered.
 */
export function WidgetSnapshotConfirmPanel(props: Readonly<{
    /** The Session Board it posts to. */
    surface: WidgetSurfaceRefV1;
    title: string;
    sourceLabel: string;
    /** The card's own mark. */
    mark?: IconName;
    capture: () => WidgetSnapshotCapture | null;
    /** What the card shows changed (its reads finished refreshing). */
    watch?: (listener: () => void) => () => void;
    onDone: () => void;
    onCancel: () => void;
    testID: string;
}>): React.ReactElement {
    const [opened, setOpened] = React.useState(() => freeze(props.capture(), props.sourceLabel));
    const [state, setState] = React.useState<'idle' | 'refreshing' | 'busy' | 'pending' | 'failed'>('idle');
    const time = formatHappierAsOfTime(opened.at);
    const { capture, sourceLabel, watch } = props;
    // Only while it waits on a refresh it asked for: the first current capture freezes the preview.
    React.useEffect(() => {
        if (state !== 'refreshing' || !watch) return;
        const settle = () => {
            const next = capture();
            if (next?.current) {
                setOpened(freeze(next, sourceLabel));
                setState('idle');
            }
        };
        const stop = watch(settle);
        settle();
        return stop;
    }, [capture, sourceLabel, state, watch]);
    const refresh = React.useCallback(async () => {
        const current = capture();
        if (!current || state === 'refreshing') return;
        setState('refreshing');
        try {
            await current.refresh();
        } catch {
            // The card's own freshness line says why; the confirm stays where it was.
        }
        const after = capture();
        if (after?.current) {
            setOpened(freeze(after, sourceLabel));
        }
        setState('idle');
    }, [capture, sourceLabel, state, watch]);
    const post = React.useCallback(async () => {
        if (!opened.preview || state === 'busy') return;
        setState('busy');
        const outcome = await runWidgetDefinitionCommand('widgets.snapshot.post', {
            surface: props.surface, itemId: randomUUID(), title: props.title, preview: opened.preview, placement: {},
        }, props.surface);
        if (outcome.kind === 'applied') {
            AccessibilityInfo.announceForAccessibility?.(t('widgetDefinition.snapshotPosted'));
            props.onDone();
            return;
        }
        setState(outcome.kind === 'approvalPending' ? 'pending' : 'failed');
    }, [opened.preview, props, state]);

    return (
        <WidgetFlowPanel
            title={t('widgetDefinition.snapshotTitle')}
            hint={t('widgetDefinition.snapshotHint', { widget: props.title, time })}
            testID={props.testID}
            error={state === 'failed' ? t('widgetDefinition.snapshotFailed') : null}
            note={state === 'pending' ? t('widgetDefinition.snapshotAwaitingApproval') : null}
            onCancel={props.onCancel}
            primary={state === 'pending'
                ? { label: t('common.done'), onPress: props.onDone }
                : {
                    label: t('widgetDefinition.postSnapshot'),
                    onPress: () => { void post(); },
                    disabled: opened.preview === null,
                    busy: state === 'busy',
                    // The body's own line says why, with Refresh; the footer does not repeat it.
                }}
        >
            {opened.preview ? (
                <WidgetPreviewWell testID={`${props.testID}.preview`}>
                    <WidgetFrame
                        testID={`${props.testID}.card`}
                        frameStyle="card"
                        placement="board"
                        mark={props.mark ?? 'squares-four'}
                        title={props.title}
                        meta={<Text style={widgetFlowText.secondary}>{t('widgetDefinition.asOf', { time })}</Text>}
                        body={{ kind: 'content', children: (
                            <View>
                                <SessionBoardDeclarativeContent document={opened.preview.document} testID={`${props.testID}.document`} />
                                <WidgetSnapshotNote />
                            </View>
                        ) }}
                    />
                </WidgetPreviewWell>
            ) : (
                <SurfaceStateCard
                    testID={`${props.testID}.notCurrent`}
                    kind="warning"
                    size="line"
                    title={t('widgetDefinition.snapshotNotCurrent')}
                    {...(capture() ? { action: {
                        label: t('common.refresh'),
                        onPress: () => refresh(),
                        busy: state === 'refreshing',
                        disabled: state === 'refreshing',
                        testID: `${props.testID}.refresh`,
                    } } : {})}
                />
            )}
        </WidgetFlowPanel>
    );
}

/** The confirm's frozen preview at one moment: what the card shows now, or nothing when it is not current. */
function freeze(capture: WidgetSnapshotCapture | null, sourceLabel: string): Readonly<{ at: number; preview: WidgetSnapshotPreviewV1 | null }> {
    const at = Date.now();
    return { at, preview: buildWidgetSnapshotPreview(capture, sourceLabel, at) };
}
