import { SurfaceStateCard } from '@/components/ui/surfaces';
import { describeWorkflowOperationProblem } from '@/components/workflows/presentation/workflowProblemPresentation';
import { isWorkflowOperationErrorCode } from '@/sync/domains/workflows/workflowActionError';
import { t } from '@/text';

import type { InputFieldOptionsState } from './inputFieldOptionsStore';

export function ActionInputOptionsNotice(props: Readonly<{
    state: Pick<InputFieldOptionsState, 'errorCode' | 'diagnostic' | 'requestId'>;
    retry?: (() => void) | undefined;
}>) {
    const code = props.state.errorCode ?? null;
    const reason = isWorkflowOperationErrorCode(code) ? describeWorkflowOperationProblem(code).message : undefined;
    const diagnosticDetail = [props.state.diagnostic?.reason, props.state.requestId].filter(Boolean).join(' · ');
    return (
        <SurfaceStateCard
            kind="error"
            size="line"
            title={t('workflows.start.choicesFailed')}
            {...(reason === undefined ? {} : { reason })}
            diagnosticCode={code}
            diagnosticDetail={diagnosticDetail || null}
            {...(props.retry === undefined ? {} : { action: { label: t('common.retry'), onPress: props.retry } })}
        />
    );
}
