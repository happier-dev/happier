import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { SourceControlBranchSummary } from '@/components/sessions/files/SourceControlBranchSummary';
import type { ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { SourceControlRemoteActionsRail, type SourceControlRemoteAction } from '@/components/sessions/sourceControl/remoteActions/SourceControlRemoteActionsRail';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

export type SessionRightPanelGitUpdateTabProps = Readonly<{
    theme: any;
    sessionId: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled?: boolean;
    disabled?: boolean;
    actions: readonly SourceControlRemoteAction[];
    hint?: string | null;
    scmStatusFiles: ScmStatusFiles | null;
    showBranchSummary?: boolean;
}>;

export const SessionRightPanelGitUpdateTab = React.memo((props: SessionRightPanelGitUpdateTabProps) => {
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
                        sessionId={props.sessionId}
                        scmSnapshot={props.scmSnapshot}
                        scmWriteEnabled={props.scmWriteEnabled}
                        disabled={props.disabled}
                    />
                ) : null}
                <SourceControlRemoteActionsRail theme={props.theme} actions={props.actions} hint={props.hint} />
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
