import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { VOICE_LAB_TRANSCRIPT, type VoiceLabEntry } from './voiceLabModel';
import { light, useVoiceLabTokens } from './voiceLabTokens';

/**
 * One timeline, not two.
 *
 * Spoken conversation and delegated coding work belong to the same assistant, so
 * they share one chronological stream. What separates them is provenance, and
 * provenance is one quiet word — never a coloured pill, never a second panel.
 *
 * Delegated messages are *referenced* here, not duplicated: the line says what
 * happened and where, and the session remains the owner of the real transcript.
 */

function toneFor(kind: VoiceLabEntry['kind'], tokens: ReturnType<typeof useVoiceLabTokens>) {
    switch (kind) {
        case 'spoken-user':
            return { ink: tokens.ink, marker: light('violet', 0.85, tokens), weight: 'semiBold' as const };
        case 'spoken-assistant':
            return { ink: tokens.ink, marker: light('warm', 0.85, tokens), weight: 'regular' as const };
        case 'work':
            return { ink: tokens.inkMuted, marker: light('deep', 0.8, tokens), weight: 'regular' as const };
        case 'permission':
            return { ink: tokens.inkMuted, marker: light('warm', 0.95, tokens), weight: 'regular' as const };
        case 'result':
        default:
            return { ink: tokens.inkMuted, marker: light('cool', 0.7, tokens), weight: 'regular' as const };
    }
}

const Entry = React.memo(function Entry(props: Readonly<{ entry: VoiceLabEntry; compact: boolean }>) {
    const tokens = useVoiceLabTokens();
    const tone = toneFor(props.entry.kind, tokens);
    const spoken = props.entry.kind === 'spoken-user' || props.entry.kind === 'spoken-assistant';

    return (
        <View style={{ flexDirection: 'row', gap: 9 }}>
            {/* A 2px lit edge carries provenance without a badge. */}
            <View
                style={{
                    width: 2,
                    borderRadius: 2,
                    backgroundColor: tone.marker,
                    marginTop: 3,
                    marginBottom: 1,
                    opacity: spoken ? 1 : 0.55,
                }}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
                {props.entry.provenance ? (
                    <Text
                        style={{
                            ...Typography.default('semiBold'),
                            fontSize: 10,
                            lineHeight: 13,
                            letterSpacing: 0.3,
                            color: tokens.inkFaint,
                            marginBottom: 1,
                        }}
                    >
                        {props.entry.provenance}
                    </Text>
                ) : null}
                <Text
                    numberOfLines={props.compact ? 2 : undefined}
                    style={{
                        ...Typography.default(tone.weight),
                        fontSize: props.compact ? 12.5 : 14,
                        lineHeight: props.compact ? 17 : 20,
                        letterSpacing: -0.08,
                        color: tone.ink,
                        // A partial transcript is never presented as a final one.
                        opacity: props.entry.provisional ? 0.7 : 1,
                        fontStyle: props.entry.provisional ? 'italic' : 'normal',
                    }}
                >
                    {props.entry.text}
                </Text>
            </View>
            <Text
                style={{
                    ...Typography.timestamp(),
                    color: tokens.inkFaint,
                    opacity: 0.7,
                }}
            >
                {props.entry.at}
            </Text>
        </View>
    );
});

export const TranscriptStream = React.memo(function TranscriptStream(props: Readonly<{
    compact?: boolean;
    entries?: readonly VoiceLabEntry[];
    limit?: number;
}>) {
    const entries = props.entries ?? VOICE_LAB_TRANSCRIPT;
    const shown = props.limit ? entries.slice(-props.limit) : entries;
    const compact = props.compact === true;

    return (
        <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ gap: compact ? 9 : 14, paddingBottom: 4 }}
            showsVerticalScrollIndicator={false}
        >
            {shown.map((entry) => (
                <Entry key={entry.id} entry={entry} compact={compact} />
            ))}
        </ScrollView>
    );
});
