import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { useLentHeaderMenuRows } from '@/components/navigation/stackHeaderActions';

/** The menu's width: a label column and a value column that fits "Claude Code · Opus 5.5". */
const RUN_MENU_WIDTH = 340;

export type ExecutionRunMenuFact = Readonly<{
    id: 'agent' | 'permissions' | 'kind' | 'started' | 'process' | 'run';
    label: string;
    value: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    anchor: {
        flexShrink: 0,
    },
    factValue: {
        color: theme.colors.text.primary,
        ...Typography.variant('body'),
        fontVariant: ['tabular-nums'],
        textAlign: 'right',
        flexShrink: 1,
    },
}));

/**
 * The Run's ⋯ (agents lab MN; unified-work lab `convo-C1`): Cancel run, cancel the current response,
 * copy the result, show it in the transcript, send the result to the lead Session — then the Run's
 * facts in words, with its id last. While the run works, the result actions are named but wait
 * ("When it finishes"); otherwise the menu offers only the actions this Run really has.
 */
export const ExecutionRunActionsMenu = React.memo((props: Readonly<{
    cancelRun?: Readonly<{ pending: boolean; onCancel: () => void }> | null;
    cancelResponse?: Readonly<{ pending: boolean; onCancel: () => void }> | null;
    copyResultText?: string | null;
    /** The run is still working: its result actions are shown, waiting for it. */
    resultPending?: boolean;
    onShowInTranscript?: (() => void) | null;
    /** Hands the result to the lead Session's composer (the canonical send-to-session handoff). */
    sendToSession?: Readonly<{ sessionTitle: string; onSend: (resultText: string) => void }> | null;
    deleteAction?: Readonly<{ pending: boolean; onDelete: () => void }> | null;
    facts: readonly ExecutionRunMenuFact[];
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const writeClipboard = useClipboardWrite(undefined, { enabled: open });
    const close = React.useCallback(() => setOpen(false), []);
    const iconColor = theme.colors.text.secondary;
    // This is the run header's `⋯`, so the rows its pane lends (a phone group's other pages, close) are drawn here.
    const lentRows = useLentHeaderMenuRows();

    const actions = React.useMemo<ActionListItem[]>(() => {
        const items: ActionListItem[] = [];
        const cancelRun = props.cancelRun;
        if (cancelRun) {
            items.push({
                id: 'cancel-run',
                testID: 'session-run-details-stop',
                label: t('agentStart.pane.cancelRun'),
                icon: <Icon name="stop" size={ICON_SIZE.sm} color={iconColor} />,
                disabled: cancelRun.pending,
                onPress: () => {
                    close();
                    cancelRun.onCancel();
                },
            });
        }
        const cancelResponse = props.cancelResponse;
        if (cancelResponse) {
            items.push({
                id: 'cancel-response',
                testID: 'session-run-details-cancel-turn',
                label: t('runPage.menu.cancelResponse'),
                icon: <Icon name="stop" size={ICON_SIZE.sm} color={iconColor} />,
                disabled: cancelResponse.pending,
                onPress: () => {
                    close();
                    cancelResponse.onCancel();
                },
            });
        }
        const copyText = props.copyResultText?.trim() ? props.copyResultText : null;
        const waiting = !copyText && props.resultPending === true;
        if (copyText || waiting) {
            items.push({
                id: 'copy-result',
                testID: 'session-run-menu-copy-result',
                label: t('runPage.menu.copyResult'),
                icon: <Icon name="copy" size={ICON_SIZE.sm} color={iconColor} />,
                ...(waiting ? { subtitle: t('agentStart.pane.whenItFinishes'), disabled: true } : {}),
                onPress: () => {
                    if (!copyText) return;
                    close();
                    void writeClipboard(copyText);
                },
            });
        }
        const showInTranscript = props.onShowInTranscript;
        if (showInTranscript) {
            items.push({
                id: 'show-in-transcript',
                testID: 'session-run-menu-show-in-transcript',
                label: t('runPage.menu.showInTranscript'),
                icon: <Icon name="list" size={ICON_SIZE.sm} color={iconColor} />,
                onPress: () => {
                    close();
                    showInTranscript();
                },
            });
        }
        const sendToSession = props.sendToSession;
        if (sendToSession && (copyText || waiting)) {
            items.push({
                id: 'send-to-session',
                testID: 'session-run-menu-send-to-session',
                label: t('agentStart.pane.sendToSession', { session: sendToSession.sessionTitle }),
                icon: <Icon name="arrow-elbow-down-right" size={ICON_SIZE.sm} color={iconColor} />,
                ...(waiting ? { subtitle: t('agentStart.pane.whenItFinishes'), disabled: true } : {}),
                onPress: () => {
                    if (!copyText) return;
                    close();
                    sendToSession.onSend(copyText);
                },
            });
        }
        for (const row of lentRows ?? []) {
            items.push({
                id: `lent:${row.id}`,
                testID: row.testID,
                label: row.title,
                icon: <Icon name={row.iconName} size={ICON_SIZE.sm} color={iconColor} />,
                onPress: () => {
                    close();
                    row.onSelect();
                },
            });
        }
        const deleteAction = props.deleteAction;
        if (deleteAction) {
            items.push({
                id: 'delete',
                testID: 'session-run-details-delete',
                label: t('sessionInfo.deleteSession'),
                icon: <Icon name="trash" size={ICON_SIZE.sm} color={iconColor} />,
                destructive: true,
                disabled: deleteAction.pending,
                onPress: () => {
                    close();
                    deleteAction.onDelete();
                },
            });
        }
        return items;
    }, [close, iconColor, lentRows, props.cancelResponse, props.cancelRun, props.copyResultText, props.deleteAction, props.onShowInTranscript, props.resultPending, props.sendToSession, writeClipboard]);

    const factRows = React.useMemo<ActionListItem[]>(() => props.facts.map((fact) => ({
        id: fact.id,
        testID: `session-run-menu-fact-${fact.id}`,
        label: fact.label,
        right: <Text numberOfLines={1} selectable style={styles.factValue}>{fact.value}</Text>,
    })), [props.facts, styles.factValue]);

    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            <IconButton
                iconName="dots-three"
                variant="plain"
                accessibilityLabel={t('common.moreActions')}
                selected={open}
                expanded={open}
                hasPopup="menu"
                testID="session-run-details-actions-menu"
                onPress={() => setOpen((current) => !current)}
            />
            {open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    boundaryRef={null}
                    placement="bottom"
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
                    maxWidthCap={RUN_MENU_WIDTH}
                    maxHeightCap={560}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay
                            maxHeight={Math.min(maxHeight, 560)}
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            surfaceChrome="theme"
                            containerStyle={{ width: Math.min(maxWidth, RUN_MENU_WIDTH) }}
                        >
                            {actions.length > 0 ? <ActionListSection actions={actions} /> : null}
                            <ActionListSection
                                separatorAbove={actions.length > 0}
                                title={t('runPage.menu.runDetails')}
                                actions={factRows}
                            />
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
});
