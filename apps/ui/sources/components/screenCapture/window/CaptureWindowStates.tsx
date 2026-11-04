import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HAPPIER_STATE_SIZE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { AnnotatorPaperCapsule } from '@/components/ui/media/annotation/AnnotatorPalette';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SystemPermissionDragTile } from '@/components/systemPermissions/SystemPermissionDragTile';
import { splitKeybindingLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

/** The compact window for a state with no picture (lab `st` PERM, FAIL). */
export const CAPTURE_STATE_WINDOW_WIDTH = 500;

export type CaptureWindowBlockedState =
    | Readonly<{
        kind: 'permission';
        /** The bound capture shortcut: first run also teaches the trigger (lab `st` PERM). */
        shortcutLabel?: string;
        /** Where the grant stands: macOS can want a relaunch before it applies. */
        progress: 'waiting' | 'allowed' | 'reopen';
        /** The macOS app has a bundle to drag onto the privacy list; `standIn` is the specimen's picture. */
        drag?: Readonly<{ standIn?: React.ReactNode }>;
        onOpenSettings: () => void;
        onReopen: () => void;
        onNotNow: () => void;
    }>
    | Readonly<{
        kind: 'failed';
        /** A recording that stopped, not a picture that failed: its title says so. */
        recording?: boolean;
        /** What failed when it isn't the capture itself (a saved recording that won't open). */
        title?: string;
        diagnostic: string | null;
        reason?: string;
        onTryAgain: () => void;
        onAttachRecent?: () => void;
        /** What was recorded stays in the folder until the person lets it go. */
        onDiscard?: () => void;
    }>
    | Readonly<{
        /** The picture is on its way (a saved recording opening); the window still has a way out. */
        kind: 'loading';
        title: string;
    }>
    | Readonly<{
        kind: 'systemSelection';
        onContinue: () => void;
        onCancel: () => void;
    }>;

/** The window with nothing to annotate yet (lab `st` PERM, FAIL): one reason, one way forward, always a way out. */
export function CaptureWindowStates(props: Readonly<{
    state: CaptureWindowBlockedState;
    onClose: () => void;
}>) {
    const { state } = props;
    return (
        <View style={styles.body} testID={`capture-window-state-${state.kind}`}>
            <View style={styles.close}>
                <AnnotatorPaperCapsule>
                    <IconButton
                        variant="plain"
                        iconName="x"
                        accessibilityLabel={t('common.close')}
                        tooltip={t('common.close')}
                        tooltipPlacement="bottom"
                        onPress={props.onClose}
                        testID="capture-window-close"
                    />
                </AnnotatorPaperCapsule>
            </View>
            {state.kind === 'permission' ? (
                <SurfaceStateCard
                    kind="empty"
                    size="details"
                    iconName="desktop"
                    title={t('screenCapture.permission.title')}
                    // First run also teaches the trigger: the keycaps stand in the sentence that names them (lab `st` PERM).
                    {...(state.shortcutLabel && state.progress === 'waiting' ? {
                        reason: t('screenCapture.permission.reasonWithShortcut', { shortcut: state.shortcutLabel }),
                        reasonContent: <ShortcutSentence label={state.shortcutLabel} />,
                    } : { reason: t('screenCapture.permission.reason') })}
                    live={state.progress === 'waiting'
                        ? { text: t('screenCapture.permission.waiting'), busy: true }
                        : { text: state.progress === 'reopen'
                            ? t('screenCapture.permission.reopenNeeded')
                            : t('screenCapture.permission.allowed', { shortcut: state.shortcutLabel ?? '' }) }}
                    {...(state.progress === 'allowed' ? {} : {
                        action: state.progress === 'reopen'
                            ? { label: t('screenCapture.permission.reopen'), onPress: state.onReopen }
                            : { label: t('screenCapture.permission.openSettings'), onPress: state.onOpenSettings },
                        secondaryAction: { label: t('screenCapture.permission.notNow'), onPress: state.onNotNow },
                    })}
                    {...(state.progress !== 'waiting' ? {}
                        // After Settings opens, the icon goes straight onto the list it names.
                        : state.drag ? { actionFooter: <SystemPermissionDragTile subject="screen" where={t('screenCapture.permission.where')} standIn={state.drag.standIn} /> }
                        : { note: t('screenCapture.permission.where') })}
                />
            ) : state.kind === 'loading' ? (
                <SurfaceStateCard kind="loading" size="details" title={state.title} />
            ) : state.kind === 'systemSelection' ? (
                <SurfaceStateCard
                    kind="empty"
                    size="details"
                    iconName="desktop"
                    title={t('screenCapture.recording.systemSelectionTitle')}
                    reason={t('screenCapture.recording.systemSelectionReason')}
                    action={{ label: t('screenCapture.recording.continue'), onPress: state.onContinue }}
                    secondaryAction={{ label: t('common.cancel'), onPress: state.onCancel }}
                />
            ) : (
                <SurfaceStateCard
                    kind="error"
                    size="details"
                    title={state.title ?? (state.recording ? t('screenCapture.recording.failedTitle') : t('screenCapture.failed.title'))}
                    reason={state.reason ?? (state.recording ? t('screenCapture.recording.failedReason') : t('screenCapture.failed.reason'))}
                    diagnosticCode={state.diagnostic}
                    action={{ label: t('screenCapture.failed.tryAgain'), onPress: state.onTryAgain }}
                    {...(state.onDiscard
                        ? { secondaryAction: { label: t('screenCapture.window.discard'), onPress: state.onDiscard } }
                        : state.onAttachRecent
                        ? { secondaryAction: { label: t('screenCapture.window.attachRecent'), onPress: state.onAttachRecent } }
                        : {})}
                />
            )}
        </View>
    );
}

/** Stands in for the copy's shortcut so the sentence can be cut around its keycaps in any language. */
const SHORTCUT_SLOT = '\u0000';

/** The permission reason with the bound shortcut drawn as keycaps where the copy names it. */
function ShortcutSentence(props: Readonly<{ label: string }>) {
    const [before, after = ''] = t('screenCapture.permission.reasonWithShortcut', { shortcut: SHORTCUT_SLOT }).split(SHORTCUT_SLOT);
    return (
        <>
            {before}
            {splitKeybindingLabel(props.label).map((key, index) => <KeyHint key={`${key}-${index}`} label={key} style={styles.inlineKey} />)}
            {after}
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: {
        // The state lifts itself in a pane; this window shrink-wraps it, so the lift would read as slack.
        marginBottom: -HAPPIER_STATE_SIZE_METRICS.details.liftPx,
        paddingHorizontal: theme.space.s16,
    },
    inlineKey: {
        marginHorizontal: theme.space.s2,
    },
    close: {
        position: 'absolute',
        top: theme.space.s12,
        left: theme.space.s12,
        zIndex: 1,
    },
}));
