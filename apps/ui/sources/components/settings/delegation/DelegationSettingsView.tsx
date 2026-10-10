import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { DELEGATION_SETTINGS } from './delegationSettings';

/** The depths offered side by side; a stored value outside them joins the set so it stays visible. */
const OFFERED_DEPTH_LIMITS = [2, 3, 4, 6] as const;

export function resolveDepthLimitChoices(current: number): readonly number[] {
    const choices = new Set<number>(OFFERED_DEPTH_LIMITS);
    choices.add(current);
    return [...choices].sort((a, b) => a - b);
}

/**
 * Settings › Delegation: how far agents may hand work on. The one limit is `workDepthLimit`; the
 * ladder shows what it means — work you start is level 0 and never limited, each agent hand-off is
 * one level, and the hand-off past the limit is refused so the agent does the work itself.
 */
export const DelegationSettingsView = React.memo(function DelegationSettingsView() {
    const [workDepthLimit, setWorkDepthLimit] = useSettingMutable('workDepthLimit');
    const [approvalReviewerEnabled, setApprovalReviewerEnabled] = useSettingMutable('approvalReviewerEnabled');
    const limit = workDepthLimit;
    const options = React.useMemo(() => resolveDepthLimitChoices(limit).map((value) => ({
        id: String(value),
        label: String(value),
    })), [limit]);

    return (
        <ItemList testID="settings.delegation">
            <SettingsPageHeader description={t('roles.delegation.description')} />
            <SettingSection section={DELEGATION_SETTINGS.sectionRefs.approvalReviewer}>
                {/* One row that names itself: a section title over it would only repeat "Approval reviewer". */}
                <ItemGroup>
                    <SettingRow
                        setting={DELEGATION_SETTINGS.settings.approvalReviewerEnabled}
                        testID="settings.delegation.approvalReviewerEnabled"
                        subtitleLines={0}
                        showChevron={false}
                        onPress={() => setApprovalReviewerEnabled(!approvalReviewerEnabled)}
                        rightElement={<Switch value={approvalReviewerEnabled} onValueChange={setApprovalReviewerEnabled} />}
                    />
                </ItemGroup>
            </SettingSection>
            <SettingSection section={DELEGATION_SETTINGS.sectionRefs.workDepth}>
                <ItemGroup title={t('roles.delegation.depthTitle')} description={t('roles.delegation.depthDescription')}>
                    <SettingAnchor setting={DELEGATION_SETTINGS.settings.workDepthLimit}>
                        <SegmentedChoiceItem<string>
                            testIDPrefix="settings.delegation.workDepthLimit"
                            title={t(DELEGATION_SETTINGS.settings.workDepthLimit.titleKey)}
                            subtitle={t('roles.delegation.depthSettingDescription', { count: limit })}
                            subtitleLines={0}
                            options={options}
                            value={String(limit)}
                            onChange={(next) => setWorkDepthLimit(Number(next))}
                        />
                    </SettingAnchor>
                    <SectionContentRow testID="settings.delegation.ladder">
                        <DepthLadder limit={limit} />
                    </SectionContentRow>
                </ItemGroup>
            </SettingSection>
        </ItemList>
    );
});

/** Level 0 (work you start) through the limit, then the refused hand-off. */
export function DepthLadder(props: Readonly<{ limit: number }>) {
    const { theme } = useUnistyles();
    const levels = Array.from({ length: props.limit }, (_, index) => index + 1);
    return (
        <View style={styles.ladder} accessibilityRole="list">
            <LadderStep
                testID="settings.delegation.ladder.root"
                glyph={<Icon name="person" size={14} color={theme.colors.text.secondary} />}
                title={t('roles.delegation.ladderRoot')}
                detail={t('roles.delegation.ladderRootDetail')}
                connected
            />
            {levels.map((level) => (
                <LadderStep
                    key={level}
                    testID={`settings.delegation.ladder.level.${level}`}
                    glyph={<Text style={styles.levelNumber}>{level}</Text>}
                    title={t('roles.delegation.ladderLevel', { level })}
                    detail={t('roles.delegation.ladderLevelDetail', { level })}
                    connected
                />
            ))}
            <LadderStep
                testID="settings.delegation.ladder.refused"
                glyph={<Icon name="x" size={14} color={theme.colors.text.tertiary} />}
                title={t('roles.delegation.ladderRefused')}
                detail={t('roles.delegation.ladderRefusedDetail', { level: props.limit + 1 })}
                refused
            />
        </View>
    );
}

function LadderStep(props: Readonly<{
    glyph: React.ReactNode;
    title: string;
    detail: string;
    connected?: boolean;
    refused?: boolean;
    testID?: string;
}>) {
    return (
        <View testID={props.testID} style={styles.step} accessible accessibilityLabel={`${props.title}. ${props.detail}`}>
            <View style={styles.rail}>
                <View style={styles.glyph}>{props.glyph}</View>
                {props.connected ? <View style={styles.connector} /> : null}
            </View>
            <View style={[styles.stepText, props.refused ? styles.refused : null]}>
                <Text style={styles.stepTitle}>{props.title}</Text>
                <Text style={styles.stepDetail}>{props.detail}</Text>
            </View>
        </View>
    );
}

const GLYPH_SIZE = 24;

const styles = StyleSheet.create((theme) => ({
    ladder: {
        paddingVertical: 4,
    },
    step: {
        flexDirection: 'row',
        gap: 12,
    },
    rail: {
        width: GLYPH_SIZE,
        alignItems: 'center',
    },
    glyph: {
        width: GLYPH_SIZE,
        height: GLYPH_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    connector: {
        flex: 1,
        width: StyleSheet.hairlineWidth,
        minHeight: 10,
        backgroundColor: theme.colors.border.default,
    },
    stepText: {
        flex: 1,
        minWidth: 0,
        paddingTop: 3,
        paddingBottom: 12,
        gap: 1,
    },
    refused: {
        opacity: 0.6,
    },
    stepTitle: {
        fontSize: 14,
        color: theme.colors.text.primary,
    },
    stepDetail: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    levelNumber: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
}));
