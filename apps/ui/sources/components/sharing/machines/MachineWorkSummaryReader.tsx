import * as React from 'react';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { describeMachinePresenceSummary } from '@/utils/sessions/machinePresenceLine';

import { MachineWorkSummarySection } from './MachineWorkSummarySection';
import { machineWorkSummaryKey, useMachineWorkSummaries } from './machineWorkSummary';

type Props = Readonly<{
    machineId: string;
    machineName: string;
    scope: ServerAccountScope;
    online: boolean | null;
    /** The incumbent page's explicit refresh; not a timer or a work census. */
    refreshKey?: number;
    execute?: ReturnType<typeof createDefaultActionExecutor>['execute'];
}>;

function ScopedMachineWorkSummaryReader(props: Props) {
    const presence = useMachinePresenceSummary(props.scope.serverId, props.machineId);
    const nativeWord = describeMachinePresenceSummary(presence).nativeWord;
    const targets = React.useMemo(() => [{ machineId: props.machineId, scope: props.scope, online: props.online }],
        [props.machineId, props.scope.serverId, props.scope.accountId, props.online]);
    const summary = useMachineWorkSummaries(targets, props.execute);
    const previousRefresh = React.useRef(props.refreshKey);
    React.useEffect(() => {
        if (previousRefresh.current !== props.refreshKey) summary.refresh();
        previousRefresh.current = props.refreshKey;
    }, [props.refreshKey, summary.refresh]);
    return <MachineWorkSummarySection machineName={props.machineName} nativeWord={nativeWord}
        state={summary.states.get(machineWorkSummaryKey(targets[0]!)) ?? { kind: 'loading' }}
        onRetry={summary.refresh} testID="machine-work-summary" />;
}

/** The existing Machine page reads only the safe Action, with the same focused Home wake as Sharing. */
export function MachineWorkSummaryReader(props: Props) {
    return <ScopedMachineWorkSummaryReader key={serverAccountScopedResourceKey(props.scope, props.machineId)} {...props} />;
}
