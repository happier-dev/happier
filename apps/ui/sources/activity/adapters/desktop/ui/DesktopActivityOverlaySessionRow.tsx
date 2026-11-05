import * as React from 'react';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';

import { createDesktopActivityOverlayFocusRingStyle } from './DesktopActivityOverlayChrome';
import { composeDesktopActivityOverlayAccessibilityLabel } from './desktopActivityOverlayAccessibilityLabel';
import type { DesktopActivityOverlayPressableInteractionState } from './DesktopActivityOverlayPressableInteractionState';
import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from './shared/desktopActivityOverlaySelectors';
import { motionTokens } from '@/components/ui/motion/motionTokens';

/** The Agent mark at the Session list's compact row size, so the island's rows read like the rail's. */
const IDENTITY_MARK_SIZE = 16;
/** The Agent mark inside a Bot header's context line, at the meta type's size (lab `ntask` `.nt-ctx`). */
const CONTEXT_MARK_SIZE = 12;
/**
 * The row's leading slot: a Bot's face at the panel size, or an Agent mark centred in the same width,
 * so every title in the opened list starts on one edge (lab ntdock-T).
 */
export const DESKTOP_ACTIVITY_OVERLAY_ROW_LEADING_SIZE = 24;

/**
 * Where an asker runs: its Agent mark (when the mark does not already lead its row) and its Session's
 * context line (project · machine). It stays in view while the asker asks (owner ruling 13).
 */
export function DesktopActivityOverlayContextLine(props: Readonly<{
    testID?: string;
    agentId?: string | null;
    machineId?: string | null;
    serverId?: string | null;
    text: string | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={styles.detailLine}>
            {props.agentId ? (
                <SessionAgentCatalogIdentityIcon
                    agentId={props.agentId}
                    machineId={props.machineId ?? null}
                    serverId={props.serverId ?? null}
                    color={theme.colors.text.secondary}
                    size={CONTEXT_MARK_SIZE}
                />
            ) : null}
            <Text variant="meta" numberOfLines={1} style={styles.detail}>{props.text}</Text>
        </View>
    );
}

/**
 * One Session on the island, in the Session list's anatomy: the Agent mark leads, then two lines —
 * the name, and the state word (coloured only when it needs you or failed) beside what it is about.
 */
export function DesktopActivityOverlaySessionRow(props: Readonly<{
    testID?: string;
    visualMode: DesktopActivityOverlayVisualMode;
    title: string;
    subtitle: string | null;
    statusText: string | null;
    previewText: string | null;
    tone?: WorkStatusTone;
    agentId?: string | null;
    machineId?: string | null;
    serverId?: string | null;
    botFace?: SessionBotFaceFacts | null;
    /** A Bot row's own leading mark (`BotFaceMarker` at the panel's face slot), replacing the Agent mark. */
    leading?: React.ReactNode;
    /** The right-aligned tabular meta column (a Bot row's age). */
    meta?: string | null;
    /**
     * This row heads its own asks (lab `ntask`): it says who asks and where (the context line, never the
     * preview, which the asks now carry), and how many asks wait when more than one does.
     */
    asking?: Readonly<{ count: number }> | null;
    pressableRef?: React.Ref<View>;
    onPress: () => void;
    onContextMenu?: (event: unknown) => void;
    onKeyDown?: (key: string, event: unknown) => boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const tone = props.tone ?? 'neutral';
    const asking = props.asking ?? null;
    const detail = props.previewText ?? props.subtitle;
    // Identity and state only: the preview repeats agent/session content and stays out of the name.
    const accessibilityLabel = composeDesktopActivityOverlayAccessibilityLabel([
        props.title,
        props.subtitle,
        props.statusText,
    ]);

    return (
        <Pressable
            ref={props.pressableRef}
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPress={props.onPress}
            {...(props.onContextMenu || props.onKeyDown ? {
                onContextMenu: props.onContextMenu,
                onKeyDown: props.onKeyDown
                    ? (event: { key?: string; nativeEvent?: { key?: string }; preventDefault?: () => void }) => {
                        const key = event.key ?? event.nativeEvent?.key ?? '';
                        if (props.onKeyDown?.(key, event)) event.preventDefault?.();
                    }
                    : undefined,
            } as Record<string, unknown> : null)}
            style={(state) => {
                const { pressed } = state;
                const interaction = state as DesktopActivityOverlayPressableInteractionState;

                return [
                    styles.container,
                    interaction.hovered === true ? styles.hovered : null,
                    pressed ? { opacity: motionTokens.press.opacitySubtle } : null,
                    createDesktopActivityOverlayFocusRingStyle(theme, interaction.focused),
                ];
            }}
        >
            <View style={props.leading ? styles.leading : styles.mark}>
                {props.leading ? props.leading : props.botFace ? (
                    <SessionBotFace facts={props.botFace} size={IDENTITY_MARK_SIZE} />
                ) : props.agentId ? (
                    <SessionAgentCatalogIdentityIcon
                        agentId={props.agentId}
                        machineId={props.machineId ?? null}
                        serverId={props.serverId ?? null}
                        color={theme.colors.text.secondary}
                        size={IDENTITY_MARK_SIZE}
                        testID={props.testID ? `${props.testID}-identity` : undefined}
                    />
                ) : null}
            </View>
            <View style={styles.textWrap}>
                <Text variant="body" emphasis="medium" numberOfLines={1} style={styles.title}>
                    {props.title}
                </Text>
                {asking ? (
                    props.subtitle ? (
                        <DesktopActivityOverlayContextLine
                            // A Bot's face leads, so its header names the Agent beside the context instead.
                            agentId={props.leading ? props.agentId : null}
                            machineId={props.machineId}
                            serverId={props.serverId}
                            text={props.subtitle}
                        />
                    ) : null
                ) : props.statusText || detail ? (
                    <Text variant="meta" numberOfLines={1} style={styles.detail}>
                        {props.statusText ? (
                            <Text variant="meta" style={workStatusWordStyle(tone)}>{props.statusText}</Text>
                        ) : null}
                        {props.statusText && detail ? ' · ' : null}
                        {detail}
                    </Text>
                ) : null}
            </View>
            {asking && asking.count > 1 ? (
                <Text
                    testID={props.testID ? `${props.testID}-ask-count` : undefined}
                    variant="meta"
                    numberOfLines={1}
                    style={styles.askCount}
                >
                    {t('settingsDesktop.overlay.notchAskCount', { count: asking.count })}
                </Text>
            ) : props.meta ? (
                <Text variant="meta" numberOfLines={1} style={styles.meta}>
                    {props.meta}
                </Text>
            ) : null}
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
        // Carried on the base row so the hover wash and the keyboard focus outline share one shape.
        borderRadius: theme.borderRadius.md,
    },
    hovered: {
        backgroundColor: theme.colors.surface.hover,
    },
    mark: {
        width: DESKTOP_ACTIVITY_OVERLAY_ROW_LEADING_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    leading: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    meta: {
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        flexShrink: 0,
    },
    textWrap: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text.primary,
    },
    detailLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        minWidth: 0,
    },
    detail: {
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    askCount: {
        color: theme.colors.state.attention.textForeground,
        fontVariant: ['tabular-nums'],
        flexShrink: 0,
    },
}));
