import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View, type View as RNView } from 'react-native';
import { ResumeChip } from './ResumeChip';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';


export type PathAndResumeRowStyles = {
    pathRow: any;
    actionButtonsLeft: any;
    actionChip: any;
    actionChipIconOnly: any;
    actionChipPressed: any;
    actionChipText: any;
};

export type PathAndResumeRowProps = {
    styles: PathAndResumeRowStyles;
    leadingControls?: ReadonlyArray<React.ReactNode>;
    fillAvailableWidth?: boolean;
    showChipLabels: boolean;
    iconColor: string;
    currentPath?: string | null;
    pathChipAnchorRef?: React.RefObject<RNView | null>;
    onPathClick?: () => void;
    emptyPathLabel: string;
    resumeSessionId?: string | null;
    resumeChipAnchorRef?: React.RefObject<RNView | null>;
    onResumeClick?: () => void;
    resumeLabelTitle: string;
    resumeLabelOptional: string;
};

export function PathAndResumeRow(props: PathAndResumeRowProps) {
    const leadingControls = props.leadingControls?.filter(Boolean) ?? [];
    const hasPath = Boolean(props.onPathClick);
    const hasResume = Boolean(props.onResumeClick);
    if (leadingControls.length === 0 && !hasPath && !hasResume) return null;
    const widthFillStyle = props.fillAvailableWidth === false ? null : { flex: 1, minWidth: 0 };

    return (
        <View style={[props.styles.pathRow, widthFillStyle]} testID="agentInput-pathResumeRow">
            <View style={[props.styles.actionButtonsLeft, widthFillStyle]}>
                {leadingControls}
                {hasPath ? (
                    <Pressable
                        ref={props.pathChipAnchorRef}
                        testID="agent-input-path-chip"
                        onPress={props.onPathClick}
                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                        style={(p) => ([
                            props.styles.actionChip,
                            p.pressed ? props.styles.actionChipPressed : null,
                            // Keep the path chip readable on mobile: let the row wrap it as a whole instead of
                            // compressing the text into an icon-only sliver.
                            { flexShrink: 0, minWidth: 0, maxWidth: '100%' },
                        ])}
                    >
                        {normalizeNodeForView(
                            <Ionicons
                                name="folder-outline"
                                size={16}
                                color={props.iconColor}
                            />,
                        )}
                        <Text
                            numberOfLines={1}
                            ellipsizeMode="middle"
                            style={[props.styles.actionChipText, { flexShrink: 1 }]}
                        >
                            {typeof props.currentPath === 'string' && props.currentPath.length > 0
                                ? props.currentPath
                                : props.emptyPathLabel}
                        </Text>
                    </Pressable>
                ) : null}

                {hasResume ? (
                        <ResumeChip
                        anchorRef={props.resumeChipAnchorRef}
                        onPress={props.onResumeClick!}
                        showLabel={props.showChipLabels}
                        resumeSessionId={props.resumeSessionId}
                        labelTitle={props.resumeLabelTitle}
                        labelOptional={props.resumeLabelOptional}
                        iconColor={props.iconColor}
                        pressableStyle={(pressed) => ([
                            props.styles.actionChip,
                            !props.showChipLabels ? props.styles.actionChipIconOnly : null,
                            pressed ? props.styles.actionChipPressed : null,
                            // Prefer wrapping the chip onto a new line over shrinking it to fit the current line.
                            // Still cap to the row width so extremely long IDs don't overflow horizontally.
                            { flexShrink: 0, maxWidth: '100%' },
                        ])}
                        textStyle={props.styles.actionChipText}
                    />
                ) : null}
            </View>
        </View>
    );
}
