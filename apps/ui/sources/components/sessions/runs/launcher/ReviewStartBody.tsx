import * as React from 'react';
import { View } from 'react-native';
import { ReviewStartSteps } from '@/components/reviews/start/ReviewStartSteps';
import { ReviewStartOptions, type ReviewStartOptionsProps } from '@/components/reviews/start/ReviewStartOptions';
import { ContextualStartComposerBody, useContextualStartComposer, type ContextualStartSource } from '@/components/sessions/authoring/ContextualStartComposer';
import { reviewReviewerIdForSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { useExecutableParticipantLabels } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { t } from '@/text';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import { readReviewLauncherSteps, updateReviewLauncherStepInput } from './reviewLauncherSelection';

const ADMISSIBLE = { who: ['newAgent', 'engine', 'session', 'bot', 'person'], machine: 'fixed', folder: 'fixed' } as const;

type Props = Readonly<{
    input: Record<string, unknown>;
    onChange: (input: Record<string, unknown>) => void;
    source: ContextualStartSource;
    choices: readonly ExecutionRunLauncherBackendChoice[];
    transcriptAvailable: boolean;
    walkthrough: boolean;
    disabled: boolean;
    details?: ReadonlyMap<string, () => React.ReactNode>;
    whoAccessory?: React.ComponentProps<typeof ContextualStartComposerBody>['whoAccessory'];
    stepControls?: (input: Record<string, unknown>, setInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>, stepIndex: number) => Readonly<{
        details?: React.ComponentProps<typeof ContextualStartComposerBody>['details'];
        whoAccessory?: React.ComponentProps<typeof ContextualStartComposerBody>['whoAccessory'];
    }>;
    children?: React.ReactNode;
    narrator?: React.ReactNode;
    credentials?: React.ReactNode;
    cost?: ReviewStartOptionsProps['cost'];
}>;

/** Bind the visual owner's steps to the retained Run draft and its existing Who source. */
export function ReviewStartBody(props: Props) {
    const steps = readReviewLauncherSteps(props.input);
    const selections = React.useMemo(() => steps.flatMap(step => step.reviewers), [steps]);
    const labels = useExecutableParticipantLabels(selections, props.source.where?.accountLifetime?.scope.serverId ?? null);
    const update = (next: typeof steps) => props.onChange({ ...props.input, steps: next, reviewers: next[0]?.reviewers ?? [] });
    return <View>
        <ReviewStartSteps steps={steps} onStepsChange={update} disabled={props.disabled}
            transcriptAvailable={props.transcriptAvailable}
            presentReviewer={(reviewer, index, stepIndex) => {
                const offset = steps.slice(0, stepIndex).reduce((total, step) => total + step.reviewers.length, 0);
                const choice = reviewer.kind === 'engine' ? props.choices.find(choice => (choice.reviewEngineId ?? choice.backendId) === reviewer.engineId) : null;
                return { name: choice?.title ?? labels[offset + index] ?? (reviewer.kind === 'engine' ? reviewer.engineId : t('session.collaboration.discussion.controls.whoFilterPeople')),
                    mark: choice ? <ExecutionRunAgentMark agentId={choice.agentId} size={16} /> : null };
            }}
            renderWho={stepIndex => <StepWho {...props} stepIndex={stepIndex} steps={steps} onStepsChange={update} />} />
        {props.children}
        <ReviewStartOptions then={props.input.then === 'fix' ? 'fix' : 'report'}
            onThenChange={then => props.onChange({ ...props.input, then })}
            walkthrough={props.walkthrough}
            onWalkthroughChange={walkthrough => props.onChange({ ...props.input, outputs: walkthrough ? ['walkthrough'] : [] })}
            narrator={props.narrator} credentials={props.credentials} cost={props.cost ?? null} disabled={props.disabled} />
    </View>;
}

function StepWho(props: Props & Readonly<{ stepIndex: number; steps: ReturnType<typeof readReviewLauncherSteps>;
    onStepsChange: (steps: ReturnType<typeof readReviewLauncherSteps>) => void }>) {
    const step = props.steps[props.stepIndex]!;
    const enginePositions = new Map<string, number[]>();
    for (const [index, reviewer] of step.reviewers.entries()) {
        if (reviewer.kind !== 'engine') continue;
        const positions = enginePositions.get(reviewer.engineId) ?? [];
        positions.push(index);
        enginePositions.set(reviewer.engineId, positions);
    }
    const changeReviewers = (reviewers: typeof step.reviewers) => props.onStepsChange(props.steps.map((current, index) =>
        index === props.stepIndex ? { ...current, reviewers } : current));
    const source: ContextualStartSource = { ...props.source, where: null,
        selectedIds: new Set(props.choices.flatMap(choice => {
            const positions = enginePositions.get(choice.reviewEngineId ?? choice.backendId) ?? [];
            return positions.length > 1 ? positions.map(index => reviewReviewerIdForSelectionV1(index))
                : positions.length === 1 ? [choice.targetKey] : [];
        })),
        sections: props.source.sections.map(entry => ({ ...entry, section: entry.section.kind !== 'static' ? entry.section : { ...entry.section,
            options: entry.section.options.flatMap(option => {
                const choice = props.choices.find(choice => choice.targetKey === option.id);
                if (!choice) return [option];
                const id = choice.reviewEngineId ?? choice.backendId;
                const positions = enginePositions.get(id) ?? [];
                const selectable = !choice.disabled && option.onSelect !== undefined;
                const remove = (position: number) => changeReviewers(step.reviewers.filter((_reviewer, index) => index !== position));
                if (positions.length > 1) return positions.map(position => ({ ...option,
                    id: reviewReviewerIdForSelectionV1(position),
                    testID: `review-start-reviewer:${reviewReviewerIdForSelectionV1(position)}`,
                    onSelect: selectable ? () => remove(position) : option.onSelect,
                }));
                return [{ ...option, onSelect: selectable ? () => positions.length === 1 ? remove(positions[0]!)
                    : changeReviewers([...step.reviewers, { kind: 'engine', engineId: id }]) : option.onSelect }];
            }),
        } })),
    };
    const model = useContextualStartComposer(source, ADMISSIBLE);
    const { steps: _steps, ...shared } = props.input;
    const input = { ...shared, reviewers: step.reviewers };
    const setInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>> = update =>
        props.onChange(updateReviewLauncherStepInput(props.input, props.stepIndex, update));
    const controls = props.stepControls?.(input, setInput, props.stepIndex) ?? { details: props.stepIndex === 0 ? props.details : undefined,
        whoAccessory: props.stepIndex === 0 ? props.whoAccessory : undefined };
    return <ContextualStartComposerBody model={model} whoLabel={t('reviewWalkthrough.start.whoReviews')} {...controls} />;
}
