import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text, TextInput } from '@/components/ui/text/Text';

import { createDesktopActivityOverlayInteriorSurfaceStyle } from '../DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayHoverablePressableState } from '../DesktopActivityOverlayHoverablePressableState';
import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import type { DesktopActivityOverlayActionDescriptor } from '../shared/desktopActivityOverlayUiModel';
import {
    resolveDesktopActivityOverlayCardActionInstanceTestID,
    resolveDesktopActivityOverlayCardActionKindTestID,
} from '../shared/desktopActivityOverlaySelectors.mjs';

function resolveActionPalette(
    theme: ReturnType<typeof useUnistyles>['theme'],
    tone: DesktopActivityOverlayActionDescriptor['tone'],
): Readonly<{
    backgroundColor: string;
    color: string;
}> {
    switch (tone) {
        case 'primary':
            return {
                backgroundColor: theme.colors.overlay.text,
                color: theme.colors.text,
            };
        case 'danger':
            return {
                backgroundColor: theme.colors.permissionButton.deny.background,
                color: theme.colors.permissionButton.deny.text,
            };
        case 'secondary':
        default:
            return {
                backgroundColor: 'transparent',
                color: theme.colors.overlay.text,
            };
    }
}

export function DesktopActivityOverlayCardActions(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    cardId: string;
    actions: readonly DesktopActivityOverlayActionDescriptor[];
    inlineQuestionText?: string | null;
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const [inlineTextByActionId, setInlineTextByActionId] = React.useState<Record<string, string>>({});
    const inlineTextByActionIdRef = React.useRef<Record<string, string>>({});

    if (props.actions.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            {props.actions.map((action) => {
                const palette = resolveActionPalette(theme, action.tone);
                const inlineText = inlineTextByActionId[action.id] ?? '';
                const inlineAnswer = inlineText.trim();
                const inlineQuestionText = props.inlineQuestionText?.trim() ?? '';
                const inlineTextActionDisabled = action.inputKind === 'inline_text' && (!inlineAnswer || !inlineQuestionText);
                const resolveAction = (): DesktopActivityOverlayActionDescriptor => {
                    if (action.inputKind !== 'inline_text') return action;
                    return {
                        ...action,
                        data: {
                            ...(action.data ?? {}),
                            answers: [{
                                question: inlineQuestionText,
                                answer: (inlineTextByActionIdRef.current[action.id] ?? '').trim(),
                            }],
                        },
                    };
                };

                return (
                    <View
                        key={action.id}
                        testID={resolveDesktopActivityOverlayCardActionKindTestID(action.id)}
                        style={styles.actionItem}
                    >
                        <Pressable
                            accessibilityLabel={action.accessibilityLabel ?? action.label}
                            testID={resolveDesktopActivityOverlayCardActionInstanceTestID(props.cardId, action.id)}
                            disabled={inlineTextActionDisabled}
                            onPress={() => props.onAction?.(resolveAction())}
                            style={(state) => {
                                const hovered = (state as DesktopActivityOverlayHoverablePressableState).hovered === true;

                                return [
                                    styles.button,
                                    createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                        visualMode: props.visualMode,
                                        kind: action.tone === 'secondary' ? 'badge' : 'card',
                                    }),
                                    action.tone !== 'secondary' ? { backgroundColor: palette.backgroundColor } : null,
                                    hovered ? { opacity: 0.98 } : null,
                                    state.pressed ? { opacity: 0.9 } : null,
                                    inlineTextActionDisabled ? styles.disabledAction : null,
                                ];
                            }}
                        >
                            <Text style={[styles.buttonText, { color: palette.color }]}>
                                {action.label}
                            </Text>
                        </Pressable>
                        {action.inputKind === 'inline_text' ? (
                            <TextInput
                                testID={`desktop-activity-overlay-question-other-input-${props.cardId}`}
                                accessibilityLabel={action.label}
                                value={inlineText}
                                onChangeText={(value) => {
                                    inlineTextByActionIdRef.current = {
                                        ...inlineTextByActionIdRef.current,
                                        [action.id]: value,
                                    };
                                    setInlineTextByActionId((previous) => ({
                                        ...previous,
                                        [action.id]: value,
                                    }));
                                }}
                                style={[
                                    styles.inlineInput,
                                    { color: theme.colors.overlay.text },
                                    createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                        visualMode: props.visualMode,
                                        kind: 'badge',
                                    }),
                                ]}
                            />
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    actionItem: {
        flex: 1,
    },
    button: {
        flex: 1,
        minHeight: 34,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonText: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0,
    },
    inlineInput: {
        minHeight: 32,
        marginTop: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        fontSize: 11,
        letterSpacing: 0,
    },
    disabledAction: {
        opacity: 0.45,
    },
});
