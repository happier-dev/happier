import * as React from 'react';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

import type { ProjectSurfaceTargetV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { SubjectTriggersSection } from '@/components/workflows/triggers/SubjectTriggersSection';
import { workflowProjectTargetFromCheckout } from '@/sync/domains/workflows/workflowProjectTarget';

/**
 * The Project Overview's Automations widget (Plan 05 S5, lab automations-v-project): the shared resource section on
 * the logical Project, headed by its widget frame. The selected checkout only places execution; it is never the
 * attachment's identity.
 */
export function ProjectAutomationsWidgetBody(props: Readonly<{ target: ProjectSurfaceTargetV1; serverId: string }>): React.ReactElement {
    const { projectKey, checkout } = props.target;
    const subject = React.useMemo((): AutomationSubjectV1 => ({ kind: 'project', serverId: props.serverId, projectKey }),
        [props.serverId, projectKey]);
    const executionContext = React.useMemo(() => checkout ? workflowProjectTargetFromCheckout(checkout) : undefined, [checkout]);
    const name = props.target.source?.source.name ?? (checkout ? resolveWorkspaceRefDisplayName(checkout) : projectKey);
    return <SubjectTriggersSection subject={subject} subjectName={name} executionContext={executionContext} presentation="widget" />;
}
