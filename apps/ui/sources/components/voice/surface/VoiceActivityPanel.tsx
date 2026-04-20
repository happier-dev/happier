import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import type { VoiceTranscriptEntry } from '@/voice/transcript/voiceTranscriptSelectors';

type VoiceActivityPanelStyles = Readonly<Record<string, unknown>>;

export function VoiceActivityPanel(props: Readonly<{
    count: number;
    emptyLabel: string;
    expanded: boolean;
    entries: ReadonlyArray<VoiceTranscriptEntry>;
    eventTextColor: string;
    countTestID?: string;
    entryTestIdPrefix?: string;
    onToggleExpanded: () => void;
    styles: VoiceActivityPanelStyles;
    title: string;
    titleColor: string;
    toggleLabel: string;
    toggleTestID?: string;
}>) {
    return (
        <View style={props.styles.feedContainer as any}>
            <View style={props.styles.feedHeader as any}>
                <Pressable
                    testID={props.toggleTestID}
                    onPress={props.onToggleExpanded}
                    accessibilityRole="button"
                    accessibilityLabel={props.toggleLabel}
                    style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }, props.styles.feedHeaderLeft as any] as any}
                >
                    <Ionicons name={props.expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={props.titleColor} />
                    <Text style={[props.styles.feedTitle as any, { color: props.titleColor }]}>
                        {props.title}
                    </Text>
                    <Text testID={props.countTestID} style={[props.styles.feedCount as any, { color: props.titleColor }]}>
                        {`${props.count}`}
                    </Text>
                </Pressable>
            </View>

            {props.expanded ? (
                <ScrollView style={props.styles.feedScroll as any} contentContainerStyle={props.styles.feedScrollContent as any}>
                    {props.count === 0 ? (
                        <Text style={[props.styles.emptyText as any, { color: props.titleColor }]}>{props.emptyLabel}</Text>
                    ) : (
                        props.entries.map((entry) => {
                            const entryTestID = props.entryTestIdPrefix ? `${props.entryTestIdPrefix}${entry.id}` : undefined;
                            if (Platform.OS === 'web' && entryTestID) {
                                return (
                                    <div key={entry.id} data-testid={entryTestID}>
                                        <Text
                                            style={[props.styles.eventText as any, { color: props.eventTextColor }]}
                                            numberOfLines={3}
                                        >
                                            {entry.text}
                                        </Text>
                                    </div>
                                );
                            }
                            return (
                                <View
                                    key={entry.id}
                                    testID={entryTestID}
                                    collapsable={false}
                                >
                                    <Text
                                        style={[props.styles.eventText as any, { color: props.eventTextColor }]}
                                        numberOfLines={3}
                                    >
                                        {entry.text}
                                    </Text>
                                </View>
                            );
                        })
                    )}
                </ScrollView>
            ) : null}
        </View>
    );
}
