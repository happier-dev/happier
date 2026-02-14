import * as React from 'react';
import type { FeatureId } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

function formatDecisionSubtitle(decision: ReturnType<typeof useFeatureDecision>): string {
    if (!decision) return 'unknown';
    if (decision.state === 'enabled') return 'enabled';

    const blockedBy = decision.blockedBy ? `blockedBy=${decision.blockedBy}` : 'blockedBy=null';
    return `${decision.state} (${blockedBy}, code=${decision.blockerCode})`;
}

const FeatureDiagnosticsRow = React.memo(function FeatureDiagnosticsRow(props: { featureId: FeatureId }) {
    const decision = useFeatureDecision(props.featureId);
    return (
        <Item
            title={props.featureId}
            subtitle={formatDecisionSubtitle(decision)}
            showChevron={false}
        />
    );
});

export function FeatureDiagnosticsPanel(props: { featureIds: readonly FeatureId[] }) {
    return (
        <ItemGroup
            title="Feature diagnostics"
            footer="Resolved feature decisions (build policy, local policy, daemon/server probes, and scope)."
        >
            {props.featureIds.map((featureId) => (
                <FeatureDiagnosticsRow key={featureId} featureId={featureId} />
            ))}
        </ItemGroup>
    );
}

