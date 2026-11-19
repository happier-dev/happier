import * as React from 'react';
import { View } from 'react-native';
import { ReviewStartSteps } from '@/components/reviews/start/ReviewStartSteps';
import { ReviewStartOptions, type ReviewStartOptionsProps } from '@/components/reviews/start/ReviewStartOptions';
import { ContextualStartComposerBody, useContextualStartComposer, useContextualStartParticipantSource, type ContextualStartSource } from '@/components/sessions/authoring/ContextualStartComposer';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { reviewReviewerIdForSelectionV1 } from '@happier-dev/protocol/reviews/reviewStart';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useExecutableParticipantLabels } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { t } from '@/text';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import { readReviewLauncherReviewers, readReviewLauncherSteps, updateReviewLauncherStepInput } from './reviewLauncherSelection';

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
    consumerSessionId?: string | null;
    stepControls?: (input: Record<string, unknown>, setInput: React.Dispatch<React.SetStateAction<Record<string, unknown>>>, stepIndex: number) => Readonly<{
        details?: React.ComponentProps<typeof ContextualStartComposerBody>['details'];
        whoAccessory?: React.ComponentProps<typeof ContextualStartComposerBody>['whoAccessory'];
    }>;
    children?: React.ReactNode;
    narrator?: React.ReactNode;
    credentials?: React.ReactNode;
    onSaveAsWorkflow?: () => void;
}>;

/** Bind the visual owner's steps to the retained Run draft and its existing Who source. */
export function ReviewStartBody(props: Props) {
    const steps = readReviewLauncherSteps(props.input);
    const selections = React.useMemo(() => steps.flatMap(step => step.reviewers), [steps]);
    const labels = useExecutableParticipantLabels(selections, props.source.where?.accountLifetime?.scope.serverId ?? null);
    const update = (next: typeof steps) => props.onChange({ ...props.input, steps: next, reviewers: next[0]?.reviewers ?? [] });
    const costs: ReviewStartOptionsProps['costs'] = steps.flatMap((step, stepIndex) => step.reviewers.flatMap((reviewer, reviewerIndex) => {
        if (reviewer.kind !== 'engine') return [];
        const choice = props.choices.find(choice => (choice.reviewEngineId ?? choice.backendId) === reviewer.engineId);
        if (!choice) return [];
        const consent = choice.reviewInventoryItem?.costConsent;
        if (!consent) return [];
        return [{ id: `${stepIndex}:${reviewerIndex}`, engine: choice.title, title: consent.title,
            description: consent.description, accepted: reviewer.options?.[consent.optionKey] === true,
            onAcceptedChange: (accepted: boolean) => props.onChange(updateReviewLauncherStepInput(props.input, stepIndex, current => ({
                ...current, reviewers: readReviewLauncherReviewers(current).map((value, index) => index === reviewerIndex && value.kind === 'engine'
                    ? { ...value, options: { ...value.options, [consent.optionKey]: accepted } } : value),
            }))) }];
    }));
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
            narrator={props.narrator} credentials={props.credentials} costs={costs} disabled={props.disabled}
            onSaveAsWorkflow={props.onSaveAsWorkflow} />
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
                if (positions.length === 0 && (choice.disabled || option.onSelect === undefined)) return [option];
                const remove = (position: number) => changeReviewers(step.reviewers.filter((_reviewer, index) => index !== position));
                if (positions.length > 1) return positions.map(position => ({ ...option,
                    id: reviewReviewerIdForSelectionV1(position),
                    testID: `review-start-reviewer:${reviewReviewerIdForSelectionV1(position)}`,
                    onSelect: () => remove(position),
                }));
                return [{ ...option, onSelect: () => positions.length === 1 ? remove(positions[0]!)
                    : changeReviewers([...step.reviewers, { kind: 'engine', engineId: id }]) }];
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
    const accountLifetime = props.source.where?.accountLifetime;
    return accountLifetime ? <ParticipantStepWho {...props} accountLifetime={accountLifetime} source={source}
        input={input} onChange={next => setInput(next)} controls={controls} />
        : <ContextualStartComposerBody model={model} whoLabel={t('reviewWalkthrough.start.whoReviews')} {...controls} />;
}

const NO_PROJECT_CHANGE = () => undefined;

/** Each visible step consumes the same exact-Home participant and recipe owner as second opinions. */
function ParticipantStepWho(props: Props & Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    controls: Pick<React.ComponentProps<typeof ContextualStartComposerBody>, 'details' | 'whoAccessory'>;
}>) {
    const reviewers = readReviewLauncherSteps(props.input)[0]!.reviewers;
    const selected = reviewers.filter((reviewer): reviewer is ExecutableParticipantSelectionV1 =>
        reviewer.kind === 'session' || reviewer.kind === 'model');
    const replace = (next: typeof reviewers) => props.onChange({ ...props.input, reviewers: next });
    const onChoose = (selection: ExecutableParticipantSelectionV1) => {
        const has = (reviewer: typeof reviewers[number]) => reviewer === selection || (reviewer.kind === 'session'
            && selection.kind === 'session' && reviewer.session.serverId === selection.session.serverId
            && reviewer.session.sessionId === selection.session.sessionId);
        replace(reviewers.some(has) ? reviewers.filter(reviewer => !has(reviewer)) : [...reviewers, selection]);
    };
    const people = {
        includeModels: true,
        title: t('session.collaboration.discussion.participants.peopleGroup'),
        chosen: reviewers.flatMap(reviewer => reviewer.kind === 'person'
            ? [presentSharePrincipal({ ref: reviewer.principal, viewerAccountId: props.accountLifetime.scope.accountId })] : []),
        onChoose: (principal: Readonly<{ kind: 'account'; accountId: string }>) => {
            const has = (reviewer: typeof reviewers[number]) => reviewer.kind === 'person'
                && reviewer.principal.kind === 'account' && reviewer.principal.accountId === principal.accountId;
            replace(reviewers.some(has) ? reviewers.filter(reviewer => !has(reviewer))
                : [...reviewers, { kind: 'person', principal, required: false }]);
        },
    };
    const participantSource = useContextualStartParticipantSource({ accountLifetime: props.accountLifetime,
        enabled: props.source.enabled, busy: props.disabled, selected, onChoose, people,
        onReplace: (previous, next) => replace(reviewers.map(reviewer => reviewer === previous ? next : reviewer)),
        consumerSessionId: props.consumerSessionId,
        question: '', onQuestionChange: NO_PROJECT_CHANGE, showWhere: false, onProject: NO_PROJECT_CHANGE,
        sessionsContext: t('session.collaboration.discussion.secondOpinion.yourSession'),
    });
    const source: ContextualStartSource = { ...participantSource,
        sections: [...participantSource.sections, ...props.source.sections.map(entry => ({ ...entry, category: 'engine' as const }))],
        selectedIds: new Set([...participantSource.selectedIds, ...props.source.selectedIds]),
    };
    const model = useContextualStartComposer(source, ADMISSIBLE);
    return <ContextualStartComposerBody model={model} whoLabel={t('reviewWalkthrough.start.whoReviews')} {...props.controls} />;
}
