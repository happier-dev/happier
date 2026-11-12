import * as React from 'react';
import type { ApprovalFieldsRequest } from './ActionApprovalFieldsCard';
import { MachineGuardSessionCeilingSetInputV1Schema } from '@happier-dev/protocol/actions/specs/machineGuard';
import { describeApprovalActionFields, type ApprovalActionFieldsPresentation } from './approvalFieldValues';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';

/** The existing proposal memory reader supplies Room; no caller-supplied claim becomes a Machine fact. */
export function MachineGuardCeilingApprovalFields(props: Readonly<{
    request: ApprovalFieldsRequest;
    serverId: string | null;
    children: (presentation: ApprovalActionFieldsPresentation) => React.ReactNode;
}>) {
    const input = React.useMemo(() => MachineGuardSessionCeilingSetInputV1Schema.safeParse(props.request.actionArgs), [props.request.actionArgs]);
    const machineId = input.success ? input.data.machineId : null;
    const keys = React.useMemo(() => machineId && props.serverId
        ? [{ machineId, serverId: props.serverId }] : [], [machineId, props.serverId]);
    // This leaf mounts only for a presented ceiling request, and shares the normal summary watch.
    useMachineResourceLiveDemand(keys, { detail: 'summary' });
    return machineId && props.serverId ? <CeilingFieldsReading request={props.request} machineId={machineId} serverId={props.serverId}>
        {props.children}
    </CeilingFieldsReading> : props.children(describeApprovalActionFields(props.request));
}

function CeilingFieldsReading(props: Readonly<{
    request: ApprovalFieldsRequest;
    machineId: string;
    serverId: string | null;
    children: (presentation: ApprovalActionFieldsPresentation) => React.ReactNode;
}>) {
    const summary = useMachineResourceSummary({ machineId: props.machineId, serverId: props.serverId });
    const memory = summary?.kind === 'reporting' && summary.freshness === 'live' ? summary.summary?.memory : null;
    const presentation = React.useMemo(() => describeApprovalActionFields({ ...props.request,
        context: { ...(memory ? { machineMemory: { machineId: props.machineId,
                availableBytes: memory.availableBytes, totalBytes: memory.totalBytes } } : {}) } }),
    [props.request, props.machineId, memory]);
    return props.children(presentation);
}
