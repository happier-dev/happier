import * as React from 'react';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { HappierWorkUpdateCard } from '@happier-dev/plugin-ui/presentation';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { renderWorkUpdateCardSurface, useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { formatTriggerSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { writeAccountTriggerEnabled } from '@/sync/domains/workflows/workflowTriggerActions';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import { useOptionalSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { isRecord, readHappierActionToolResultCandidates } from './happierActionToolResult';

function readDraft(tool: ToolCall) {
    if (tool.state !== 'completed') return null;
    for (const candidate of readHappierActionToolResultCandidates(tool.result, tool.input)) {
        const result = isRecord(candidate) && candidate.ok === true && 'result' in candidate ? candidate.result : candidate;
        const parsed = WorkflowTriggerWriteResultV1Schema.safeParse(result);
        if (!parsed.success) continue;
        const { set, triggerId } = parsed.data;
        const trigger = set.triggers.find(row => row.id === triggerId);
        if (set.enabled && trigger?.enabled === false) return { set, trigger };
    }
    return null;
}

export const AutomationDraftActionResultReference = React.memo(function AutomationDraftActionResultReference(props: Readonly<{
    tool: ToolCall;
    serverId?: string;
}>) {
    const draft = React.useMemo(() => readDraft(props.tool), [props.tool]);
    return draft ? <SavedAutomationDraft draft={draft} serverId={props.serverId} /> : null;
});

type Draft = NonNullable<ReturnType<typeof readDraft>>;
type Activation = 'off' | 'pending' | 'on' | { message: string; canRetry: boolean };

function SavedAutomationDraft({ draft, serverId }: Readonly<{ draft: Draft; serverId?: string }>) {
    const source = useOptionalSessionTranscriptSource();
    const { binding } = useServerCredentialAccountScopeBinding(source?.kind === 'app' ? serverId ?? source.serverId : null);
    const theme = useWorkTheme();
    const [state, setState] = React.useState<Activation>('off');
    const { set, trigger } = draft;
    const enable = async () => {
        if (!binding) return;
        setState('pending');
        try {
            await writeAccountTriggerEnabled(set, trigger.id, true, binding);
            setState('on');
        } catch (error) {
            const problem = resolveWorkflowProblemPresentation(error);
            setState({ message: problem.message, canRetry: problem.repair === 'retry' });
        }
    };

    const canEnable = binding && state !== 'on' && (typeof state !== 'object' || state.canRetry);
    return <HappierWorkUpdateCard
        testID="transcript-automation-draft"
        theme={theme}
        host={WORK_HOST}
        renderSurface={renderWorkUpdateCardSurface}
        mark={<Icon name="clock" size={16} />}
        title={set.name ?? t('workflows.triggers.section.title')}
        tone="neutral"
        meta={formatTriggerSummary(trigger)}
        state={t(state === 'on' ? 'common.done' : 'workflows.triggers.row.off')}
        actions={canEnable && <RoundButton
            testID="transcript-automation-draft-enable"
            size="small"
            display="secondary"
            title={t('workflows.triggers.popover.turnOn')}
            loading={state === 'pending'}
            disabled={state === 'pending'}
            action={enable}
        />}
    >{typeof state === 'object' ? <Text variant="meta" accessibilityLiveRegion="polite">{state.message}</Text> : null}</HappierWorkUpdateCard>;
}
