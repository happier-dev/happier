import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildHappierWorkMap } from '@happier-dev/plugin-ui/presentation';
import { WorkMapView } from '@/components/work/map/WorkMapView';
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
                </ItemGroup>
                {/* The levels are cards of their own, so they stand on the page under the choice, never inside its sheet. */}
                <ItemGroup surface="none">
                    <View testID="settings.delegation.ladder">
                        <DepthLadder limit={limit} />
                    </View>
                </ItemGroup>
            </SettingSection>
        </ItemList>
    );
});

type LadderGlyph = 'person' | 'git-branch' | 'x';

/**
 * Level 0 (work you start) through the limit, then the refused hand-off (lab `settings-D`): the one
 * Work map renderer in read-only mode draws the levels as cards joined by a connector, so the ladder
 * reads like the chains it limits. The refused level is the same card, quieter.
 */
export function DepthLadder(props: Readonly<{ limit: number }>) {
    const { theme } = useUnistyles();
    const map = React.useMemo(() => {
        const step = (nodeId: string, label: string, detail: string, glyph: LadderGlyph, refused = false) => (
            { nodeId, label, detail, glyph, refused, parentNodeId: null }
        );
        const declared = [
            step('root', t('roles.delegation.ladderRoot'), t('roles.delegation.ladderRootDetail'), 'person'),
            ...Array.from({ length: props.limit }, (_, index) => index + 1).map((level) => step(
                `level.${level}`, t('roles.delegation.ladderLevel', { level }), t('roles.delegation.ladderLevelDetail', { level }), 'git-branch',
            )),
            step('refused', t('roles.delegation.ladderRefused'), t('roles.delegation.ladderRefusedDetail', { level: props.limit + 1 }), 'x', true),
        ];
        return buildHappierWorkMap({ relationships: 'authored', nodes: declared });
    }, [props.limit]);
    return (
        <WorkMapView
            map={map}
            selectedNodeId={null}
            testIDPrefix="settings.delegation.ladder"
            rootLayout="sequence"
            accessibilityLabelForNode={(node) => `${node.label}. ${node.detail}`}
            presentNode={(node) => ({ muted: node.refused })}
            renderLeading={(node) => (
                <Icon name={node.glyph} size={16} color={node.refused ? theme.colors.text.tertiary : theme.colors.text.secondary} />
            )}
            renderSubtitle={(node) => <Text style={styles.stepDetail}>{node.detail}</Text>}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    stepDetail: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
