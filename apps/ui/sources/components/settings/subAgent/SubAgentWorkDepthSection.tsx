import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { SUB_AGENT_SETTINGS } from '@/components/settings/subAgent/subAgentSettings';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildHappierWorkMap } from '@happier-dev/plugin-ui/presentation';
import { WorkMapView } from '@/components/work/map/WorkMapView';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** The depths offered side by side; a stored value outside them joins the set so it stays visible. */
const OFFERED_DEPTH_LIMITS = [2, 3, 4, 6] as const;

export function resolveDepthLimitChoices(current: number): readonly number[] {
    const choices = new Set<number>(OFFERED_DEPTH_LIMITS);
    choices.add(current);
    return [...choices].sort((a, b) => a - b);
}

/**
 * Settings › Subagents › Work depth: how far agents may hand work on. The one limit is
 * `workDepthLimit`; the ladder shows what it means — work you start is level 0 and never limited,
 * each agent hand-off is one level, and the hand-off past the limit is refused so the agent does the
 * work itself.
 */
export const SubAgentWorkDepthSection = React.memo(function SubAgentWorkDepthSection() {
    const [limit, setWorkDepthLimit] = useSettingMutable('workDepthLimit');
    const options = React.useMemo(() => resolveDepthLimitChoices(limit).map((value) => ({
        id: String(value),
        label: String(value),
    })), [limit]);

    return (
        <SettingSection section={SUB_AGENT_SETTINGS.sectionRefs.workDepth}>
            <ItemGroup title={t('roles.delegation.depthTitle')} description={t('roles.delegation.depthDescription')}>
                <SettingAnchor setting={SUB_AGENT_SETTINGS.settings.workDepthLimit}>
                    <SegmentedChoiceItem<string>
                        testIDPrefix="settings.subAgent.workDepthLimit"
                        title={t(SUB_AGENT_SETTINGS.settings.workDepthLimit.titleKey)}
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
                <View testID="settings.subAgent.ladder">
                    <DepthLadder limit={limit} />
                </View>
            </ItemGroup>
        </SettingSection>
    );
});

type LadderGlyph = 'person' | 'git-branch' | 'x';

/**
 * Level 0 (work you start) through the limit, then the refused hand-off (lab `settings-D`): the one
 * Work map renderer in read-only mode draws the levels as cards joined by a connector, so the ladder
 * reads like the chains it limits. The refused level is the same card, quieter.
 */
function DepthLadder(props: Readonly<{ limit: number }>) {
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
            testIDPrefix="settings.subAgent.ladder"
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
