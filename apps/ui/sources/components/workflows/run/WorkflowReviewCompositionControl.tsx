import * as React from 'react';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { REVIEW_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { walkWorkflowBlocks, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { Item } from '@/components/ui/lists/Item';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import { readReviewLauncherReviewers } from '@/components/sessions/runs/launcher/reviewLauncherSelection';
import type { presentReviewExecutionRunLaunchSelection } from '@/components/sessions/runs/launcher/reviewExecutionRunLaunchSelection';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { t } from '@/text';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

type CompositionInputs = Readonly<{ reviewers: string; instructions: string; cwd: string; steps?: string }>;

/** Bind saved Hunts as well as the built-in through their authored Action inputs. */
export function readWorkflowReviewCompositionInputs(definition: WorkflowDefinitionV1 | undefined): CompositionInputs | null {
    const review = definition && walkWorkflowBlocks(definition.blocks).find(block => block.kind === 'action'
        && block.actionId === REVIEW_START_ACTION_ID_V1 && block.input.scope?.kind === 'literal' && block.input.scope.value === 'repository');
    if (!review || review.kind !== 'action') return null;
    const { reviewers, steps, instructions, cwd } = review.input;
    if (reviewers?.kind !== 'input' || reviewers.path?.length || instructions?.kind !== 'input'
        || instructions.path?.length || cwd?.kind !== 'input' || cwd.path?.length) return null;
    return { reviewers: reviewers.name, instructions: instructions.name, cwd: cwd.name,
        steps: steps?.kind === 'input' && !steps.path?.length ? steps.name : undefined };
}

/** The workflow retains its inputs; the existing Review author owns runner, model and Account selection. */
export function WorkflowReviewCompositionControl(props: Readonly<{
    inputs: CompositionInputs;
    values: Readonly<Record<string, JsonValue | undefined>>;
    onChangeValues: (values: Readonly<Record<string, JsonValue | undefined>>) => void;
    machineId?: string | null;
    directory?: string | null;
    serverId?: string | null;
    disabled: boolean;
    testID: string;
}>) {
    const lifetime = useWorkflowAccountLifetime();
    const mounted = React.useRef(false);
    const presentation = React.useRef<ReturnType<typeof presentReviewExecutionRunLaunchSelection> | null>(null);
    const current = React.useRef(props);
    current.current = props;
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; presentation.current?.close(); };
    }, []);
    const reviewers = readReviewLauncherReviewers({ reviewers: props.values[props.inputs.reviewers] });
    const labels = reviewers.flatMap(reviewer => reviewer.kind === 'engine'
        ? [resolveExecutionRunBackendLabel(resolveReviewEngineTarget(reviewer.engineId)) ?? reviewer.engineId] : []);
    const choose = useEventCallback(async () => {
        if (props.disabled || !props.serverId || lifetime === null) return;
        const { presentReviewExecutionRunLaunchSelection } = await import('@/components/sessions/runs/launcher/reviewExecutionRunLaunchSelection');
        const isCurrent = () => mounted.current && !current.current.disabled
            && current.current.inputs === props.inputs && current.current.machineId === props.machineId
            && current.current.directory === props.directory && current.current.serverId === props.serverId
            && (lifetime?.isCurrent() ?? true);
        if (!isCurrent()) return;
        const cwd = props.values[props.inputs.cwd] ?? props.directory;
        presentation.current = presentReviewExecutionRunLaunchSelection({ sessionId: null, serverId: props.serverId,
            ...(props.machineId && typeof cwd === 'string' ? { workspace: { machineId: props.machineId, cwd } } : {}),
            draft: { target: { kind: 'detached' }, scope: 'repository', cwd,
                instructions: props.values[props.inputs.instructions] ?? '', reviewers: props.values[props.inputs.reviewers] ?? [],
                ...(props.inputs.steps && props.values[props.inputs.steps] !== undefined ? { steps: props.values[props.inputs.steps] } : {}) },
            projection: 'composition', isCurrent });
        const selected = await presentation.current.result;
        presentation.current = null;
        if (!isCurrent() || selected?.kind !== 'reviewComposition') return;
        const latest = current.current;
        latest.onChangeValues({ ...latest.values,
            [latest.inputs.reviewers]: projectNativeJsonValueForTransport(selected.input.reviewers),
            [latest.inputs.instructions]: selected.input.instructions,
            [latest.inputs.cwd]: selected.input.cwd,
            ...(latest.inputs.steps ? { [latest.inputs.steps]: selected.input.steps === undefined
                ? undefined : projectNativeJsonValueForTransport(selected.input.steps) } : {}),
        });
    });
    return <Item testID={props.testID} title={t('workflows.tabs.steps')}
        subtitle={labels.join(', ') || t('workflows.start.required')}
        disabled={props.disabled || !props.serverId || lifetime === null} onPress={() => { void choose(); }} />;
}
