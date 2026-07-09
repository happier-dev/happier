import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    resolveTranscriptNavigationEntryAccessibilityLabel,
    resolveTranscriptNavigationEntryPrimaryText,
    resolveTranscriptNavigationEntrySecondaryText,
} from './transcriptNavigationAccessibility';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationEntryJumpOutcome,
    TranscriptNavigationEntryPressHandler,
    TranscriptNavigationEntryPressResult,
} from './transcriptNavigationTypes';

type KeyboardEventLike = Readonly<{
    key?: string;
    nativeEvent?: Readonly<{ key?: string }>;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

type KeyboardViewProps = React.ComponentProps<typeof View> & Readonly<{
    onKeyDown?: (event: KeyboardEventLike) => void;
    tabIndex?: number;
}>;

const KeyboardView = View as React.ComponentType<KeyboardViewProps>;

export type TranscriptNavigationEntryListProps = Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    activeEntryId: string | null;
    onEntryPress: TranscriptNavigationEntryPressHandler;
    onRequestClose?: () => void;
    testIDPrefix: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    content: {
        paddingVertical: 6,
        paddingHorizontal: 8,
        gap: 4,
    },
    row: {
        minHeight: 48,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 7,
        borderWidth: 1,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
    },
    rowActive: {
        backgroundColor: theme.colors.surface.selected,
        borderColor: theme.colors.border.default,
    },
    rowFocused: {
        backgroundColor: theme.colors.surface.inset,
    },
    markerColumn: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'stretch',
    },
    activeAccent: {
        width: 3,
        borderRadius: 2,
        alignSelf: 'stretch',
        backgroundColor: theme.colors.state.info.foreground,
    },
    quietAccent: {
        width: 3,
        borderRadius: 2,
        alignSelf: 'stretch',
        backgroundColor: theme.colors.border.default,
        opacity: 0.55,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    primaryText: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    secondaryText: {
        color: theme.colors.text.secondary,
    },
    unloadedText: {
        color: theme.colors.text.secondary,
    },
    trailing: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorRow: {
        marginTop: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
    },
    errorText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.state.danger.foreground,
    },
    retryText: {
        color: theme.colors.state.info.foreground,
        ...Typography.default('semiBold'),
    },
}));

function normalizeKey(event: KeyboardEventLike): string | null {
    const key = event.key ?? event.nativeEvent?.key;
    return typeof key === 'string' ? key : null;
}

type EntryPressState = 'pending' | 'error';

function isThenable(value: unknown): value is Promise<TranscriptNavigationEntryJumpOutcome | void> {
    return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

function classifySettledOutcome(outcome: TranscriptNavigationEntryJumpOutcome | void): EntryPressState | null {
    if (outcome && outcome.status === 'not-found') return 'error';
    return null;
}

export const TranscriptNavigationEntryList = React.memo((props: TranscriptNavigationEntryListProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [focusedIndex, setFocusedIndex] = React.useState(0);
    const [pressStates, setPressStates] = React.useState<ReadonlyMap<string, EntryPressState>>(() => new Map());
    const pressTokensRef = React.useRef(new Map<string, number>());
    const mountedRef = React.useRef(true);
    const entries = props.entries;
    const activeEntryId = props.activeEntryId;
    const onEntryPress = props.onEntryPress;
    const onRequestClose = props.onRequestClose;
    const testIDPrefix = props.testIDPrefix;

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        setFocusedIndex((current) => {
            if (entries.length === 0) return 0;
            return Math.min(current, entries.length - 1);
        });
    }, [entries]);

    const setEntryPressState = React.useCallback((entryId: string, state: EntryPressState | null) => {
        if (!mountedRef.current) return;
        setPressStates((current) => {
            if ((current.get(entryId) ?? null) === state) return current;
            const next = new Map(current);
            if (state === null) {
                next.delete(entryId);
            } else {
                next.set(entryId, state);
            }
            return next;
        });
    }, []);

    const handleEntryPress = React.useCallback((entry: TranscriptNavigationEntry) => {
        const token = (pressTokensRef.current.get(entry.id) ?? 0) + 1;
        pressTokensRef.current.set(entry.id, token);
        const isStale = () => pressTokensRef.current.get(entry.id) !== token;

        let result: TranscriptNavigationEntryPressResult;
        try {
            result = onEntryPress(entry);
        } catch {
            setEntryPressState(entry.id, 'error');
            return;
        }

        if (!isThenable(result)) {
            setEntryPressState(entry.id, classifySettledOutcome(result));
            return;
        }

        // Only surface a pending indicator when data is actually pending (unloaded target).
        setEntryPressState(entry.id, entry.loaded === false ? 'pending' : null);
        result.then(
            (outcome) => {
                if (isStale()) return;
                setEntryPressState(entry.id, classifySettledOutcome(outcome));
            },
            () => {
                if (isStale()) return;
                setEntryPressState(entry.id, 'error');
            },
        );
    }, [onEntryPress, setEntryPressState]);

    const activateFocusedEntry = React.useCallback(() => {
        const entry = entries[focusedIndex];
        if (entry) handleEntryPress(entry);
    }, [entries, focusedIndex, handleEntryPress]);

    const handleKeyDown = React.useCallback((event: KeyboardEventLike) => {
        const key = normalizeKey(event);
        if (!key) return;

        if (key === 'Escape') {
            if (!onRequestClose) return;
            event.preventDefault?.();
            event.stopPropagation?.();
            onRequestClose();
            return;
        }

        if (entries.length === 0) return;

        if (key === 'ArrowDown') {
            event.preventDefault?.();
            setFocusedIndex((current) => Math.min(entries.length - 1, current + 1));
            return;
        }
        if (key === 'ArrowUp') {
            event.preventDefault?.();
            setFocusedIndex((current) => Math.max(0, current - 1));
            return;
        }
        if (key === 'Home') {
            event.preventDefault?.();
            setFocusedIndex(0);
            return;
        }
        if (key === 'End') {
            event.preventDefault?.();
            setFocusedIndex(entries.length - 1);
            return;
        }
        if (key === 'Enter' || key === ' ') {
            event.preventDefault?.();
            activateFocusedEntry();
        }
    }, [activateFocusedEntry, entries.length, onRequestClose]);

    return (
        <KeyboardView
            testID={`${testIDPrefix}-entry-list`}
            style={styles.root}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            accessibilityRole="list"
        >
            <ScrollView
                style={styles.root}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
            >
                {entries.map((entry, index) => {
                    const active = activeEntryId === entry.id;
                    const focused = index === focusedIndex;
                    const primaryText = resolveTranscriptNavigationEntryPrimaryText(entry);
                    const secondaryText = resolveTranscriptNavigationEntrySecondaryText(entry);
                    const pressState = pressStates.get(entry.id) ?? null;
                    return (
                        <Pressable
                            key={entry.id}
                            testID={`${testIDPrefix}-entry:${entry.id}`}
                            onPress={() => handleEntryPress(entry)}
                            onFocus={() => setFocusedIndex(index)}
                            style={[
                                styles.row,
                                focused && !active ? styles.rowFocused : null,
                                active ? styles.rowActive : null,
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={resolveTranscriptNavigationEntryAccessibilityLabel(entry)}
                            accessibilityState={{ selected: active }}
                        >
                            <View style={styles.markerColumn}>
                                <View style={active ? styles.activeAccent : styles.quietAccent} />
                            </View>
                            <View style={styles.copy}>
                                <Text
                                    numberOfLines={2}
                                    style={[styles.primaryText, entry.loaded ? null : styles.unloadedText]}
                                >
                                    {primaryText}
                                </Text>
                                {secondaryText ? (
                                    <Text numberOfLines={1} style={styles.secondaryText}>
                                        {secondaryText}
                                    </Text>
                                ) : null}
                                {pressState === 'error' ? (
                                    <View testID={`${testIDPrefix}-entry-error:${entry.id}`} style={styles.errorRow}>
                                        <Text numberOfLines={1} style={styles.errorText}>
                                            {t('session.transcriptNavigation.jumpFailed')}
                                        </Text>
                                        <Pressable
                                            testID={`${testIDPrefix}-entry-retry:${entry.id}`}
                                            onPress={() => handleEntryPress(entry)}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('common.retry')}
                                            hitSlop={6}
                                        >
                                            <Text numberOfLines={1} style={styles.retryText}>
                                                {t('common.retry')}
                                            </Text>
                                        </Pressable>
                                    </View>
                                ) : null}
                            </View>
                            <View style={styles.trailing}>
                                {pressState === 'pending' ? (
                                    <ActivityIndicator
                                        testID={`${testIDPrefix}-entry-pending:${entry.id}`}
                                        size="small"
                                        color={theme.colors.text.secondary}
                                    />
                                ) : entry.pinned ? (
                                    <Octicons name="pin" size={14} color={theme.colors.state.info.foreground} />
                                ) : null}
                            </View>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </KeyboardView>
    );
});
