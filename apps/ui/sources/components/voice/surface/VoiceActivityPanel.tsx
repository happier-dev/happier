import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import type { VoiceSurfaceTranscriptEntry } from './mergeVoiceSurfaceTranscriptEntries';

type VoiceActivityPanelStyles = Readonly<Record<string, unknown>>;

const MINIMUM_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const MINIMUM_TARGET_STYLE = Object.freeze({
    minWidth: MINIMUM_TARGET_SIZE,
    minHeight: MINIMUM_TARGET_SIZE,
});
const CLAIMED_ANNOUNCEMENT_LIMIT = 512;
const claimedAnnouncements = new Set<string>();
const claimedAnnouncementOrder: string[] = [];

type AnnouncementHistory = {
    ids: Set<string>;
    order: string[];
};

function rememberAnnouncement(history: AnnouncementHistory, key: string): boolean {
    if (history.ids.has(key)) return false;
    history.ids.add(key);
    history.order.push(key);
    while (history.order.length > CLAIMED_ANNOUNCEMENT_LIMIT) {
        const retired = history.order.shift();
        if (retired) history.ids.delete(retired);
    }
    return true;
}

function claimAnnouncement(key: string): boolean {
    return rememberAnnouncement({ ids: claimedAnnouncements, order: claimedAnnouncementOrder }, key);
}

function announcementKey(entry: VoiceSurfaceTranscriptEntry): string {
    return entry.announcementId;
}

export const VoiceActivityPanel = React.memo(function VoiceActivityPanel(props: Readonly<{
    count: number;
    emptyLabel: string;
    expanded: boolean;
    entries: ReadonlyArray<VoiceSurfaceTranscriptEntry>;
    eventTextColor: string;
    countTestID?: string;
    entryTestIdPrefix?: string;
    onToggleExpanded: () => void;
    styles: VoiceActivityPanelStyles;
    title: string;
    titleColor: string;
    toggleLabel: string;
    expandEntryLabel: string;
    collapseEntryLabel: string;
    partialLabel: string;
    correctedLabel: string;
    interruptedLabel: string;
    toggleTestID?: string;
}>) {
    const initialized = React.useRef(false);
    const observedAnnouncements = React.useRef<AnnouncementHistory>({ ids: new Set(), order: [] });
    const [announcement, setAnnouncement] = React.useState<Readonly<{ key: string; text: string }> | null>(null);
    const [expandedEntryIds, setExpandedEntryIds] = React.useState<ReadonlySet<string>>(() => new Set());

    const toggleEntryExpanded = React.useCallback((entryId: string) => {
        setExpandedEntryIds((current) => {
            const next = new Set(current);
            if (next.has(entryId)) {
                next.delete(entryId);
            } else {
                next.add(entryId);
            }
            return next;
        });
    }, []);

    React.useEffect(() => {
        const candidates = props.entries.filter((entry) => entry.announce);
        if (!initialized.current) {
            initialized.current = true;
            for (const entry of candidates) rememberAnnouncement(observedAnnouncements.current, announcementKey(entry));
            return;
        }

        const nextKeys: string[] = [];
        const nextTexts: string[] = [];
        for (const entry of candidates) {
            const key = announcementKey(entry);
            if (!rememberAnnouncement(observedAnnouncements.current, key)) continue;
            if (!claimAnnouncement(key)) continue;
            nextKeys.push(key);
            nextTexts.push(entry.text);
        }
        if (nextTexts.length > 0) {
            setAnnouncement({ key: nextKeys.join('|'), text: nextTexts.join('. ') });
        }
    }, [props.entries]);

    return (
        <View style={props.styles.feedContainer as any}>
            {announcement ? (
                <Text
                    accessibilityLabel={announcement.text}
                    accessibilityLiveRegion="polite"
                    style={props.styles.liveRegion as any}
                >
                    <Text key={announcement.key}>{announcement.text}</Text>
                </Text>
            ) : null}
            <View style={props.styles.feedHeader as any}>
                <Pressable
                    testID={props.toggleTestID}
                    onPress={props.onToggleExpanded}
                    accessibilityRole="button"
                    accessibilityLabel={props.toggleLabel}
                    accessibilityState={{ expanded: props.expanded }}
                    style={({ pressed }) => [
                        { opacity: pressed ? 0.72 : 1 },
                        props.styles.feedHeaderLeft as any,
                        MINIMUM_TARGET_STYLE,
                    ] as any}
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
                            const entryExpanded = expandedEntryIds.has(entry.id);
                            const revealLabel = entryExpanded ? props.collapseEntryLabel : props.expandEntryLabel;
                            const stateLabel = entry.transcriptState === 'partial'
                                ? props.partialLabel
                                : entry.transcriptState === 'corrected'
                                    ? props.correctedLabel
                                    : entry.transcriptState === 'interrupted'
                                        ? props.interruptedLabel
                                    : null;
                            const content = (
                                <View style={props.styles.eventRow as any}>
                                    <Text
                                        accessibilityLiveRegion="none"
                                        style={[
                                            props.styles.eventText as any,
                                            entry.transcriptState === 'partial' ? props.styles.provisionalEventText as any : null,
                                            { color: props.eventTextColor },
                                        ]}
                                        accessibilityLabel={entry.text}
                                        numberOfLines={entryExpanded ? undefined : 3}
                                    >
                                        {entry.text}
                                    </Text>
                                    {stateLabel ? (
                                        <Text style={[props.styles.revisionLabel as any, { color: props.titleColor }]}>
                                            {stateLabel}
                                        </Text>
                                    ) : null}
                                    <Pressable
                                        testID={entryTestID ? `${entryTestID}:reveal` : undefined}
                                        accessibilityRole="button"
                                        accessibilityLabel={revealLabel}
                                        accessibilityState={{ expanded: entryExpanded }}
                                        onPress={() => toggleEntryExpanded(entry.id)}
                                        style={({ pressed }) => [
                                            { opacity: pressed ? 0.72 : 1 },
                                            props.styles.eventRevealAction as any,
                                            MINIMUM_TARGET_STYLE,
                                        ]}
                                    >
                                        <Text style={[props.styles.eventRevealText as any, { color: props.titleColor }]}>
                                            {revealLabel}
                                        </Text>
                                    </Pressable>
                                </View>
                            );
                            if (Platform.OS === 'web' && entryTestID) {
                                return (
                                    <div key={entry.id} data-testid={entryTestID}>
                                        {content}
                                    </div>
                                );
                            }
                            return (
                                <View
                                    key={entry.id}
                                    testID={entryTestID}
                                    collapsable={false}
                                >
                                    {content}
                                </View>
                            );
                        })
                    )}
                </ScrollView>
            ) : null}
        </View>
    );
});
