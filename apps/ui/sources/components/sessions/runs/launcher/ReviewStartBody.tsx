import * as React from 'react';
import { View } from 'react-native';
import { ReviewStartSteps } from '@/components/reviews/start/ReviewStartSteps';
import { ReviewStartOptions, type ReviewStartOptionsProps } from '@/components/reviews/start/ReviewStartOptions';
import { ContextualStartComposerBody, useContextualStartComposer, type ContextualStartSource } from '@/components/sessions/authoring/ContextualStartComposer';
import { useExecutableParticipantLabels } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { t } from '@/text';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import { readReviewLauncherSteps, selectReviewLauncherEngines } from './reviewLauncherSelection';

const ADMISSIBLE = { who: ['newAgent', 'engine', 'session', 'bot', 'person'], machine: 'fixed', folder: 'fixed' } as const;

type Props = Readonly<{
    input: Record<string, unknown>;
    onChange: (input: Record<string, unknown>) => void;
    source: ContextualStartSource;
    choices: readonly ExecutionRunLauncherBackendChoice[];
    transcriptAvailable: boolean;
    disabled: boolean;
    details?: ReadonlyMap<string, () => React.ReactNode>;
    whoAccessory?: React.ComponentProps<typeof ContextualStartComposerBody>['whoAccessory'];
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
            walkthrough={Array.isArray(props.input.outputs) && props.input.outputs.includes('walkthrough')}
            onWalkthroughChange={walkthrough => props.onChange({ ...props.input, outputs: walkthrough ? ['walkthrough'] : [] })}
            narrator={props.narrator} credentials={props.credentials} cost={props.cost ?? null} disabled={props.disabled} />
    </View>;
}

function StepWho(props: Props & Readonly<{ stepIndex: number; steps: ReturnType<typeof readReviewLauncherSteps>;
    onStepsChange: (steps: ReturnType<typeof readReviewLauncherSteps>) => void }>) {
    const step = props.steps[props.stepIndex]!;
    const engineIds = new Set(step.reviewers.flatMap(reviewer => reviewer.kind === 'engine' ? [reviewer.engineId] : []));
    const source: ContextualStartSource = { ...props.source, where: null,
        selectedIds: new Set(props.choices.filter(choice => engineIds.has(choice.reviewEngineId ?? choice.backendId)).map(choice => choice.targetKey)),
        sections: props.source.sections.map(entry => ({ ...entry, section: entry.section.kind !== 'static' ? entry.section : { ...entry.section,
            options: entry.section.options.map(option => {
                const choice = props.choices.find(choice => choice.targetKey === option.id);
                if (!choice) return option;
                const id = choice.reviewEngineId ?? choice.backendId;
                return { ...option, onSelect: choice.disabled || !option.onSelect ? option.onSelect : () => {
                    const selected = engineIds.has(id) ? [...engineIds].filter(value => value !== id) : [...engineIds, id];
                    const reviewers = selectReviewLauncherEngines({ reviewers: step.reviewers }, selected).reviewers;
                    props.onStepsChange(props.steps.map((current, index) => index === props.stepIndex
                        ? { ...current, reviewers: reviewers as typeof step.reviewers } : current));
                } };
            }),
        } })),
    };
    const model = useContextualStartComposer(source, ADMISSIBLE);
    return <ContextualStartComposerBody model={model} whoLabel={t('reviewWalkthrough.start.whoReviews')}
        details={props.stepIndex === 0 ? props.details : undefined} whoAccessory={props.whoAccessory} />;
}
