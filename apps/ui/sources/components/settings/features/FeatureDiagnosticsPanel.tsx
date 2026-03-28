import * as React from 'react';
import type { FeatureId } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { FeatureDecisionScopeParams } from '@/hooks/server/useFeatureDecision';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { t } from '@/text';

function formatDecisionSubtitle(decision: ReturnType<typeof useFeatureDecision>): string {
    if (!decision) return t('settingsFeatures.featureDiagnostics.decisionUnknown');
    if (decision.state === 'enabled') return t('settingsFeatures.featureDiagnostics.decisionEnabled');

    return t('settingsFeatures.featureDiagnostics.decisionBlocked', {
        state: decision.state,
        blockedBy: decision.blockedBy ?? null,
        code: decision.blockerCode,
    });
}

const FeatureDiagnosticsRow = React.memo(function FeatureDiagnosticsRow(props: { featureId: FeatureId; scope?: FeatureDecisionScopeParams }) {
    const decision = useFeatureDecision(props.featureId, props.scope);
    return (
        <Item
            title={props.featureId}
            subtitle={formatDecisionSubtitle(decision)}
            showChevron={false}
        />
    );
});

export function FeatureDiagnosticsPanel(props: { featureIds: readonly FeatureId[]; scope?: FeatureDecisionScopeParams }) {
    return (
        <ItemGroup
            title={t('settingsFeatures.featureDiagnostics.title')}
            footer={t('settingsFeatures.featureDiagnostics.footer')}
        >
            {props.featureIds.map((featureId) => (
                <FeatureDiagnosticsRow key={featureId} featureId={featureId} scope={props.scope} />
            ))}
        </ItemGroup>
    );
}
