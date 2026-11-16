import * as React from 'react';

import { useActiveHomeUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

import type { WorkflowDefinitionLibrary } from './workflowLibraryReads';

/** Retained Library content carries the saved-definition reader's failure and recovery together. */
export function WorkflowLibraryFreshness(props: Readonly<{
    library: WorkflowDefinitionLibrary;
    hasRows: boolean;
}>): React.ReactElement | null {
    const homeUnavailable = useActiveHomeUnavailable();
    const { library } = props;
    if (library.status !== 'failed' || homeUnavailable || !props.hasRows) return null;
    return <SurfaceFreshnessLine testID="workflow-library:refresh-failed" tone="warning"
        reason={library.failure?.message ?? t('workflows.loadFailedBody')}
        action={{ label: t('workflows.retry'), onPress: library.retry }} />;
}
