import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { SourceControlBranchSummary } from '@/components/workspaces/scm/SourceControlBranchSummary';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { SourceControlRemoteActionsRail, type SourceControlRemoteAction } from '@/components/workspaces/scm/SourceControlRemoteActionsRail';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

export type WorkspaceScmUpdateTabProps = Readonly<{
    theme: any;
    actions: readonly SourceControlRemoteAction[];
    hint?: string | null;
    scmStatusFiles: ScmStatusFiles | null;
    showBranchSummary?: boolean;
    branchTrigger?: React.ReactNode;
    branchSummaryActionSlot?: React.ReactNode;
    children?: React.ReactNode;
}>;

export const WorkspaceScmUpdateTab = React.memo((props: WorkspaceScmUpdateTabProps) => {
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 12 }}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
                scrollEventThrottle={16}
            >
                {props.showBranchSummary !== false && props.scmStatusFiles ? (
                    <SourceControlBranchSummary
                        theme={props.theme}
                        scmStatusFiles={props.scmStatusFiles}
                        variant="rail"
                        branchTrigger={props.branchTrigger}
                        actionSlot={props.branchSummaryActionSlot}
                    />
                ) : null}
                <SourceControlRemoteActionsRail theme={props.theme} actions={props.actions} hint={props.hint} />
                {props.children}
            </ScrollView>
            <ScrollEdgeFades
                color={props.theme.colors.surface}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={props.theme.colors.textSecondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
