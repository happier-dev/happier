import * as React from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';
import { projectWidgetSnapshotPreviewV1, type WidgetSnapshotPreviewV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';
import { WidgetDefinitionPanel, widgetPanelText } from './WidgetDefinitionPanel';
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
 * its "as of", and that it will not update and the connection stays the poster's. One primary
 * action; Cancel writes nothing. Publication goes through `widgets.snapshot.post`, whose existing
 * approval policy may hold it for the Inbox — then this says so instead of claiming it posted.
 */
export function WidgetSnapshotConfirmPanel(props: Readonly<{
    /** The Session Board it posts to. */
    surface: WidgetSurfaceRefV1;
    title: string;
    sourceLabel: string;
    capture: () => WidgetSnapshotCapture | null;
    onDone: () => void;
    onCancel: () => void;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [opened] = React.useState(() => {
        const at = Date.now();
        return { at, preview: buildWidgetSnapshotPreview(props.capture(), props.sourceLabel, at) };
    });
    const [state, setState] = React.useState<'idle' | 'busy' | 'pending' | 'failed'>('idle');
    const time = formatHappierAsOfTime(opened.at);
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
        <WidgetDefinitionPanel
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
                    blockedReason: opened.preview === null ? t('widgetDefinition.snapshotNotCurrent') : null,
                }}
        >
            {opened.preview ? (
                <View style={styles.preview} testID={`${props.testID}.preview`}>
                    <WidgetFrame
                        testID={`${props.testID}.card`}
                        frameStyle="card"
                        placement="board"
                        mark="squares-four"
                        title={props.title}
                        meta={<Text style={widgetPanelText.secondary}>{t('widgetDefinition.asOf', { time })}</Text>}
                        body={{ kind: 'content', children: (
                            <View>
                                <SessionBoardDeclarativeContent document={opened.preview.document} testID={`${props.testID}.document`} />
                                <WidgetSnapshotNote />
                            </View>
                        ) }}
                    />
                </View>
            ) : (
                <View style={styles.blocked}>
                    <Icon name="arrow-clockwise" size={16} color={theme.colors.text.tertiary} />
                    <Text style={widgetPanelText.secondary}>{t('widgetDefinition.snapshotNotCurrent')}</Text>
                </View>
            )}
        </WidgetDefinitionPanel>
    );
}

const styles = StyleSheet.create((theme) => ({
    preview: { borderRadius: 12, backgroundColor: theme.colors.surface.inset, padding: 10, marginBottom: 4 },
    blocked: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16 },
}));
