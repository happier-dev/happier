import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, usePreferredLanguage } from '@/text';

import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';
import type { WalkthroughInventoryRow, WalkthroughOtherChange } from './walkthroughReading';
import { ChangedFilesReviewFindCount } from '@/components/workspaces/scm/review/ChangedFilesReviewFind';
import { WalkthroughHunkCard, type WalkthroughFindProps } from './WalkthroughStopSection';
import { walkthroughOtherFindKey } from './walkthroughFind';

/** Before a word is written: every file in the comparison, its counts, and what the model has read (lab WT2-1). */
export const WalkthroughInventory = React.memo(function WalkthroughInventory(props: Readonly<{
    rows: readonly WalkthroughInventoryRow[];
    phone?: boolean;
    /** Nothing is being read: a file not yet read carries no progress mark. */
    uncertain?: boolean;
    onOpenFile?: (path: string) => void;
}>) {
    usePreferredLanguage();
    const { theme } = useUnistyles();
    return (
        <View testID="walkthrough-inventory" style={[styles.inventory, props.phone ? styles.inventoryPhone : null]}>
            <Text style={styles.inventoryTitle}>{t('walkthrough.inventory.title')}</Text>
            {props.rows.map((row) => (
                <ScmChangeRow key={row.path} theme={theme} file={scmFileStatusFromChange(row)}
                    testID={`walkthrough-inventory-${row.path}`} density="compact" phone={props.phone}
                    style={styles.inventoryRow}
                    onPress={props.onOpenFile ? () => props.onOpenFile!(row.path) : undefined}
                    tag={row.lockfile ? t('scmComparison.lockfileTag') : row.generated ? t('scmComparison.generatedTag') : null}
                    trailingElement={!row.lockfile && !row.generated && !(props.uncertain && row.reading === 'reading') ? <View style={styles.readState}>
                        <Icon name={row.reading === 'read' ? 'check' : row.reading === 'unavailable' ? 'lock' : 'circle'}
                            size={12} color={row.reading === 'read' ? theme.colors.state.success.foreground : theme.colors.text.tertiary} />
                        <Text style={styles.readStateText}>{row.reading === 'read' ? t('walkthrough.inventory.read') : row.reading === 'unavailable' ? t('walkthrough.inventory.unavailable') : t('walkthrough.inventory.reading')}</Text>
                    </View> : null} />
            ))}
        </View>
    );
});

function otherWhy(other: WalkthroughOtherChange): string | null {
    if (other.unavailableReason && other.unavailableReason !== 'binary') return t('walkthrough.evidence.unavailable', { reason: other.unavailableReason });
    if (other.binary) return t('walkthrough.evidence.binary');
    return null;
}

/** The tail of the story: everything no stop explains, still one press from its diff (lab WT1-A). */
export const WalkthroughOtherChanges = React.memo(function WalkthroughOtherChanges(props: Readonly<{
    others: readonly WalkthroughOtherChange[];
    phone?: boolean;
    onOpenFile?: (path: string) => void;
    /** Find over the reading: a match outside the stops opens that change's code beneath its row. */
    find?: WalkthroughFindProps | null;
    /** Find keys of the other changes a Find step has opened; they stay open until Find closes. */
    revealed?: ReadonlySet<string>;
}>) {
    const { theme } = useUnistyles();
    if (props.others.length === 0) return null;
    return (
        <View testID="walkthrough-other-changes" style={[styles.others, props.phone ? styles.othersPhone : null]}>
            <Text accessibilityRole="header" style={styles.othersTitle}>
                {t('walkthrough.otherChanges')}
                <Text style={styles.othersCount}>{`  ${props.others.length}`}</Text>
            </Text>
            <Text style={styles.othersDescription}>{t('walkthrough.otherChangesDescription')}</Text>
            {props.others.map((other, index) => {
                const why = otherWhy(other);
                const findKey = walkthroughOtherFindKey(other.path);
                const open = Boolean(props.find?.active && props.revealed?.has(findKey));
                // A change Find has opened reads as code, its card header standing in for the row.
                if (open) return (
                    <WalkthroughHunkCard key={other.path} testID={`walkthrough-other-code-${other.path}`} file={{ ...other, rangeLabel: null }}
                        phone={props.phone} onOpenFile={props.onOpenFile} findKey={findKey} find={props.find} />
                );
                return (
                    <ScmChangeRow key={other.path} theme={theme} file={scmFileStatusFromChange(other)}
                        testID={`walkthrough-other-${other.path}`} density="compact" phone={props.phone}
                        style={styles.otherRow} showDivider={index > 0}
                        onPress={props.onOpenFile ? () => props.onOpenFile!(other.path) : undefined}
                        accessibilityQualification={why ?? undefined}
                        pathAccessory={why ? <Text style={styles.why} numberOfLines={1}>{why}</Text> : null}
                        tag={other.lockfile ? t('scmComparison.lockfileTag') : other.generated ? t('scmComparison.generatedTag') : null}
                        trailingElement={props.find ? <ChangedFilesReviewFindCount model={props.find.model} path={findKey} /> : undefined} />
                );
            })}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    inventory: { paddingTop: 18 },
    inventoryPhone: { paddingHorizontal: theme.space.s16 },
    inventoryTitle: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.secondary, marginBottom: theme.space.s6,  },
    inventoryRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10, minHeight: 34, borderRadius: 6, paddingHorizontal: theme.space.s4 },
    readState: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 82 },
    readStateText: { ...Typography.variant('meta'), color: theme.colors.text.tertiary,  },
    others: {
        marginTop: 22,
        paddingTop: 22,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    othersPhone: { marginHorizontal: theme.space.s16 },
    othersTitle: { ...Typography.variant('heading'), color: theme.colors.text.primary,  },
    othersCount: { color: theme.colors.text.tertiary, ...Typography.default('medium') },
    othersDescription: { marginTop: theme.space.s4, marginBottom: theme.space.s10, ...Typography.variant('body'), color: theme.colors.text.secondary,  },
    otherRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10, minHeight: 40, paddingHorizontal: theme.space.s12 },
    why: { ...Typography.variant('meta'), color: theme.colors.text.tertiary,  },
}));
