import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { resolveHappierWorkMapNodePosition, joinHappierFacts, type HappierWorkMapNodePresentation } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WorkMapView } from '@/components/work/map/WorkMapView';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { t } from '@/text';

import { readWorkFoldedFromMap, type SessionWorkMap, type SessionWorkMapNode } from './workMapProducer';
import type { WorkItem, WorkProjection } from './workProjection';

/**
 * The Work tab's Map (lab `session-A2`, `session-B`): the lead and what it started, drawn by the one
 * neutral map renderer. This producer supplies only its words — the state word in the status slot and
 * each node's spoken position — and opens a node exactly where its Work row opens.
 */

const stylesheet = StyleSheet.create((theme) => ({
    subtitle: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    root: {
        gap: 8,
    },
    foldNote: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        paddingHorizontal: 8,
    },
    status: {
        ...Typography.default(),
        flexShrink: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
}));

export const SessionWorkMapView = React.memo((props: Readonly<{
    map: SessionWorkMap;
    projection: WorkProjection;
    testIDPrefix: string;
    onOpenItem: (item: WorkItem) => void;
}>) => {
    const styles = stylesheet;
    const { map, projection, onOpenItem } = props;
    const itemByKey = React.useMemo(() => {
        const byKey = new Map<string, WorkItem>();
        for (const item of [...projection.sessions, ...projection.workflows, ...projection.backgroundRuns, ...projection.agents, ...projection.projectCommands]) {
            byKey.set(item.key, item);
        }
        return byKey;
    }, [projection]);

    const accessibilityLabelForNode = React.useCallback((node: SessionWorkMapNode) => {
        const position = resolveHappierWorkMapNodePosition(map, node);
        return [
            node.label,
            node.status?.word ?? null,
            position.parent
                ? t('sessionWork.map.positionUnder', { position: position.position, total: position.total, parent: position.parent.label })
                : null,
        ].filter(Boolean).join(', ');
    }, [map]);
    const renderStatus = React.useCallback((node: SessionWorkMapNode) => (
        node.status ? (
            <Text
                numberOfLines={1}
                style={[
                    styles.status,
                    workStatusWordStyle(node.status.tone),
                ]}
            >
                {node.status.word}
            </Text>
        ) : null
    ), [styles]);
    const onOpen = React.useCallback((node: SessionWorkMapNode) => {
        const item = itemByKey.get(node.nodeId);
        if (item) onOpenItem(item);
    }, [itemByKey, onOpenItem]);
    const isNodeDisabled = React.useCallback((node: SessionWorkMapNode) => node.kind === 'lead', []);
    // The lead's reports sit side by side under it (lab `session-A2`); a report's own reports stack
    // under it. Each node carries its own tone, and the shared treatment decides what that draws; the
    // lead has no state, so it is never tinted for what its reports need (S-6).
    const presentNode = React.useCallback((node: SessionWorkMapNode): HappierWorkMapNodePresentation => ({
        appearance: 'card',
        childLayout: node.kind === 'lead' ? 'lanes' : 'sequence',
        tone: node.status?.tone ?? 'neutral',
    }), []);
    const renderLeading = React.useCallback((node: SessionWorkMapNode) => (
        <ExecutionRunAgentMark agentId={node.agentId} size={28} />
    ), []);
    const renderSubtitle = React.useCallback((node: SessionWorkMapNode) => (
        node.facts.length > 0 ? <Text numberOfLines={1} style={styles.subtitle}>{joinHappierFacts(...node.facts)}</Text> : null
    ), [styles]);

    // Finished work leaves the map and is named once under it (lab `session-A2`, `session-B`); List keeps it.
    const foldNote = React.useMemo(() => {
        const folded = readWorkFoldedFromMap(projection);
        if (folded.length === 0) return null;
        const runs = folded.filter((item) => item.kind === 'background_run').length;
        const names = folded.filter((item) => item.kind !== 'background_run').map((item) => item.title);
        if (runs > 0) names.push(t('sessionWork.map.backgroundRuns', { count: runs }));
        return joinHappierFacts(t('sessionWork.map.folded'), names.join(', '));
    }, [projection]);

    return (
        <View style={styles.root}>
        <WorkMapView
            map={map}
            selectedNodeId={null}
            testIDPrefix={props.testIDPrefix}
            accessibilityLabelForNode={accessibilityLabelForNode}
            renderStatus={renderStatus}
            renderLeading={renderLeading}
            renderSubtitle={renderSubtitle}
            presentNode={presentNode}
            isNodeDisabled={isNodeDisabled}
            onOpen={onOpen}
        />
        {foldNote ? <Text testID={`${props.testIDPrefix}-fold-note`} numberOfLines={1} style={styles.foldNote}>{foldNote}</Text> : null}
        </View>
    );
});
