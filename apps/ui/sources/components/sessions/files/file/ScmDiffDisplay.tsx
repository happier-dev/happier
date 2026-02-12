import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';

export type ScmDiffDisplayProps = {
    diffContent: string;
    selectedLineIndexes?: ReadonlySet<number>;
    onToggleLine?: (index: number) => void;
};

export function ScmDiffDisplay({ diffContent, selectedLineIndexes, onToggleLine }: ScmDiffDisplayProps) {
    const { theme } = useUnistyles();
    const lines = diffContent.split('\n');
    const selected = selectedLineIndexes ?? new Set<number>();

    return (
        <View>
            {lines.map((line, index) => {
                const baseStyle = { ...Typography.mono(), fontSize: 14, lineHeight: 20 };
                let lineStyle: any = baseStyle;
                let backgroundColor = 'transparent';

                if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.addedText };
                    backgroundColor = theme.colors.diff.addedBg;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.removedText };
                    backgroundColor = theme.colors.diff.removedBg;
                } else if (line.startsWith('@@')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.hunkHeaderText, fontWeight: '600' };
                    backgroundColor = theme.colors.diff.hunkHeaderBg;
                } else if (line.startsWith('+++') || line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.text, fontWeight: '600' };
                } else {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.contextText };
                }

                const selectable =
                    (line.startsWith('+') && !line.startsWith('+++'))
                    || (line.startsWith('-') && !line.startsWith('---'));

                return (
                    <Pressable
                        key={index}
                        onPress={selectable && onToggleLine ? () => onToggleLine(index) : undefined}
                        style={{
                            backgroundColor: selected.has(index) ? theme.colors.surfaceHigh : backgroundColor,
                            paddingHorizontal: 8,
                            paddingVertical: 1,
                            borderLeftWidth:
                                line.startsWith('+') && !line.startsWith('+++')
                                    ? 3
                                    : line.startsWith('-') && !line.startsWith('---')
                                      ? 3
                                      : 0,
                            borderLeftColor:
                                line.startsWith('+') && !line.startsWith('+++')
                                    ? theme.colors.diff.addedBorder
                                    : theme.colors.diff.removedBorder,
                        }}
                    >
                        <Text style={lineStyle}>{line || ' '}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
