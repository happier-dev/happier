import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { validateDeploySuggestionV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { InteractionTransientQuestionAnswerV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import type {
  DeploySuggestionCatalogV1,
  DeploySuggestionRecommendationV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import {
  suggestDeploySetup,
  type DeploySuggestionOutcome,
  type DeploySuggestionProgress,
  type DeploySuggestionUnavailableMachine,
} from '@/execution/llmTasks/suggestDeploySetup';
import { presentExecutionRunFailureSummary } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import type {
  NewAppAutoMachine,
  NewAppAutoView,
} from './NewAppAutoStep';
import { deploySuggestionCardId, deploySuggestionCardIndex, presentDeploySuggestionCard, useDeclaredTargetPlans } from './DeploySuggestionCards';

type Runner = Extract<DeploySuggestionProgress, { kind: 'runner' }>;
type RunStop = Extract<DeploySuggestionProgress, { kind: 'run' }>['stop'];
type Phase =
  | Readonly<{ kind: 'describe' }>
  | Readonly<{
      kind: 'working';
      counts:
        | Extract<DeploySuggestionProgress, { kind: 'catalog' }>['counts']
        | null;
      runner: Runner | null;
      running: boolean;
      stop: 'idle' | 'stopping' | Readonly<{ refused: string }>;
    }>
  | Readonly<{
      kind: 'settled';
      outcome: Exclude<DeploySuggestionOutcome, { kind: 'stopped' }>;
      runner: Runner | null;
      /** The person skipped the questions that came with these cards. */
      skippedQuestions?: boolean;
    }>;

export type NewAppAutoChosen = Readonly<{
  recommendation: DeploySuggestionRecommendationV1;
  catalog: DeploySuggestionCatalogV1;
}>;

/**
 * Describe your app's state: the person's description and what the suggestion owner (`suggestDeploySetup`) last
 * reported. Stop and leaving the step abort the accepted run; the owner settles it once (Accepted imperfections:
 * closing drops the run, the description stays while the dialog is open).
 */
export function useNewAppAutoSuggestions(
  params: Readonly<{ serverId: string | null; active: boolean; initial?: Readonly<{ description: string; chosen: NewAppAutoChosen }> | null }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [runnerChoice] = useSettingMutable('deploySuggestionRunnerV1');
  const [description, setDescription] = React.useState(params.initial?.description ?? '');
  const [phase, setPhase] = React.useState<Phase>(() => params.initial ? {
    kind: 'settled', outcome: { kind: 'recommendations', recommendations: [params.initial.chosen.recommendation], catalog: params.initial.chosen.catalog, dropped: [] }, runner: null,
  } : { kind: 'describe' });
  const [chosenCardId, setChosenCardId] = React.useState<string | null>(params.initial ? deploySuggestionCardId(0) : null);
  const abort = React.useRef<AbortController | null>(null);
  const round = React.useRef<Readonly<{
    serverId: string;
    catalog: DeploySuggestionCatalogV1;
    answers: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>;
  }> | null>(null);
  // The accepted Run's own Stop, for a Retry after its target refused the first one.
  const runStop = React.useRef<RunStop | null>(null);
  const lastRecommendations = React.useRef<Extract<DeploySuggestionOutcome, { kind: 'recommendations' }> | null>(null);

  // Stop is a request: the step stays on the Run until its target confirms the stop, and a refusal stays on screen.
  const stop = React.useCallback(() => {
    const controller = abort.current;
    if (!controller) {
      setPhase((current) => (current.kind === 'describe' ? current : { kind: 'describe' }));
      return;
    }
    setPhase((current) => (current.kind === 'working' ? { ...current, stop: 'stopping' } : current));
    if (!controller.signal.aborted) {
      controller.abort();
      return;
    }
    const retry = runStop.current;
    if (!retry) return;
    void retry().then((result) => {
      if (abort.current !== controller) return;
      if (result.ok) {
        abort.current = null;
        runStop.current = null;
        setPhase({ kind: 'describe' });
        return;
      }
      setPhase((current) => (current.kind === 'working' ? { ...current, stop: { refused: result.errorCode } } : current));
    });
  }, []);
  // Leaving the step or closing the dialog stops the run (request_response, ephemeral).
  React.useEffect(() => {
    if (!params.active) stop();
  }, [params.active, stop]);
  React.useEffect(() => () => abort.current?.abort(), []);

  const runSuggestion = React.useCallback((followUp?: Readonly<{
    answers?: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>;
    note?: string;
    refreshCatalog?: boolean;
  }>) => {
    if (!params.serverId || !description.trim()) return;
    const serverId = params.serverId;
    const previous = followUp && round.current?.serverId === params.serverId ? round.current : null;
    const answers = previous ? { ...previous.answers, ...followUp?.answers } : followUp?.answers;
    if (!followUp) { round.current = null; lastRecommendations.current = null; }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    if (!followUp) setChosenCardId(null);
    runStop.current = null;
    setPhase({ kind: 'working', counts: null, runner: null, running: false, stop: 'idle' });
    let runner: Runner | null = null;
    void suggestDeploySetup({
      serverId: params.serverId,
      description,
      ...(previous && !followUp?.refreshCatalog ? { catalog: previous.catalog } : {}),
      ...(answers ? { answers } : {}),
      ...(followUp?.note === undefined ? {} : { note: followUp.note }),
      choice: runnerChoice ?? null,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.kind === 'run') runStop.current = progress.stop;
        if (controller.signal.aborted) return;
        if (progress.kind === 'runner') runner = progress;
        setPhase((current) =>
          current.kind !== 'working'
            ? current
            : progress.kind === 'catalog'
              ? { ...current, counts: progress.counts }
              : progress.kind === 'runner'
                ? { ...current, runner: progress }
                : { ...current, running: true },
        );
      },
    }).then((outcome) => {
      if (abort.current !== controller) return;
      if (controller.signal.aborted && outcome.kind === 'failed') {
        // Stop was asked and refused: the Run may still be going. Keep it on screen with the refusal.
        setPhase((current) => (current.kind === 'working' ? { ...current, stop: { refused: outcome.code } } : current));
        return;
      }
      abort.current = null;
      runStop.current = null;
      if (outcome.kind === 'stopped') {
        setPhase({ kind: 'describe' });
        return;
      }
      if ('catalog' in outcome) round.current = { serverId, catalog: outcome.catalog, answers: answers ?? {} };
      if (outcome.kind === 'recommendations') { lastRecommendations.current = outcome; setChosenCardId(cardId(0)); }
      setPhase({ kind: 'settled', outcome, runner });
    });
  }, [description, params.serverId, runnerChoice]);

  const suggest = React.useCallback(() => runSuggestion(), [runSuggestion]);
  const answerQuestions = React.useCallback((answers: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>) =>
    runSuggestion({ answers }), [runSuggestion]);
  const suggestAgain = React.useCallback((note: string) => runSuggestion({ note }), [runSuggestion]);
  // Connecting changes catalog facts. Only this explicit refresh reloads a follow-up snapshot.
  const refreshSuggestions = React.useCallback(() => runSuggestion({ refreshCatalog: true }), [runSuggestion]);

  // Questions that came with cards are asked first; skipping shows those cards, with no new run (PLAN §4 steps 2 → 3).
  const skipQuestions = React.useCallback(() => setPhase((current) =>
    current.kind === 'settled' ? { ...current, skippedQuestions: true } : current), []);

  const backToDescription = React.useCallback(
    () => setPhase({ kind: 'describe' }),
    [],
  );

  const openMachineSetup = React.useCallback(
    (machineId: string) => {
      if (!params.serverId) return;
      router.push(
        machinePageHref({
          door: 'rail',
          target: { machineId, serverId: params.serverId },
          tab: { id: 'setup' },
        }) as never,
      );
    },
    [params.serverId, router],
  );

  // The cards' plans come from the Account's declared targets, as on a Session card (review D1).
  const shown = phase.kind === 'settled' && phase.outcome.kind === 'recommendations' ? phase.outcome : null;
  const declaredPlans = useDeclaredTargetPlans(shown?.recommendations ?? null, shown?.catalog ?? null);
  const view = React.useMemo((): NewAppAutoView => {
    if (phase.kind === 'describe') return { kind: 'describe' };
    if (phase.kind === 'working')
      return {
        kind: 'working',
        steps: workingSteps(phase),
        runsOn: phase.runner ? runsOnLine(phase.runner) : null,
        stop: typeof phase.stop === 'object'
          ? { refused: phase.stop.refused, machine: phase.runner?.label ?? null, onRetry: stop }
          : phase.stop,
      };
    const outcome = phase.outcome;
    if (outcome.kind === 'recommendations' && outcome.questions && !phase.skippedQuestions)
      return { kind: 'questions', questions: outcome.questions.questions, skippable: true };
    if (outcome.kind === 'recommendations') {
      return {
        kind: 'recommendations',
        source: phase.runner
          ? t('newApp.auto.sourceNote', { machine: phase.runner.label })
          : null,
        cards: outcome.recommendations.map((recommendation, index) =>
          presentDeploySuggestionCard(
            recommendation,
            outcome.catalog,
            index,
            <Icon
              name="sparkle"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />,
            declaredPlans,
          ),
        ),
      };
    }
    if (outcome.kind === 'noAgent') {
      return {
        kind: 'noAgent',
        serverId: params.serverId,
        machines: outcome.machines.map((machine) =>
          presentMachine(machine, openMachineSetup),
        ),
      };
    }
    if (outcome.kind === 'questions') return { kind: 'questions', questions: outcome.questions.questions, skippable: false };
    if (outcome.kind === 'failed') return { kind: 'failed', code: outcome.code, reason: failedReason(outcome) };
    // Why the check dropped each part of the answer, by its typed reason, for Details.
    const reasons = [...new Set([...outcome.dropped, ...outcome.droppedQuestions].map((row) => row.reason))];
    return { kind: 'nothing', code: reasons.length ? reasons.join(', ') : null };
  }, [declaredPlans, openMachineSetup, params.serverId, phase, stop, theme.colors.text.secondary]);

  const settled = phase.kind === 'settled' ? phase.outcome : phase.kind === 'working' ? lastRecommendations.current : null;
  const chosen = React.useMemo((): NewAppAutoChosen | null => {
    if (settled?.kind !== 'recommendations' || chosenCardId === null)
      return null;
    const recommendation =
      settled.recommendations[deploySuggestionCardIndex(chosenCardId) ?? -1];
    return recommendation ? { recommendation, catalog: settled.catalog } : null;
  }, [chosenCardId, settled]);
  const adjustChosen = React.useCallback((changes: Partial<Pick<DeploySuggestionRecommendationV1, 'source' | 'targetId' | 'data'>>) => {
    if (!chosen || phase.kind !== 'settled' || phase.outcome.kind !== 'recommendations') return false;
    const source = changes.source ?? chosen.recommendation.source;
    const starter = source.kind === 'starter' ? chosen.catalog.starters.find(item => item.id === source.starterId) : undefined;
    const candidate = { ...chosen.recommendation, ...changes, ...(starter?.deploy ? { stack: starter.deploy } : {}) };
    const checked = validateDeploySuggestionV1({ recommendations: [candidate] }, chosen.catalog);
    const recommendation = checked.recommendations[0];
    if (!recommendation) return false;
    const outcome = { ...phase.outcome, recommendations: phase.outcome.recommendations.map((item, index) =>
      cardId(index) === chosenCardId ? recommendation : item) };
    lastRecommendations.current = outcome;
    setPhase({ ...phase, outcome });
    return true;
  }, [chosen, chosenCardId, phase]);
  const questions = settled?.kind === 'questions' ? settled.questions
    : view.kind === 'questions' && settled?.kind === 'recommendations' ? settled.questions ?? null : null;
  const runner = phase.kind === 'describe' ? null : phase.runner;

  return {
    description,
    setDescription,
    view,
    suggest,
    questions,
    answerQuestions,
    skipQuestions,
    suggestAgain,
    refreshSuggestions,
    adjustChosen,
    stop,
    backToDescription,
    chosenCardId,
    chooseCard: setChosenCardId,
    chosen,
    suggestedBy:
      runner && view.kind === 'recommendations'
        ? t('newApp.auto.suggestedBy', {
            agent: runnerAgentTitle(runner),
            machine: runner.label,
          })
        : null,
  };
}


/** The runner as its owner reports it (Auto's resolved title); an explicit choice is named by the Agent catalog. */
function runnerAgentTitle(runner: Runner): string {
  if (runner.agentTitle) return runner.agentTitle;
  try {
    const target = parseBackendTargetKeyV2(runner.agentTargetKey);
    if (target.kind === 'agent') return resolveAgentCatalogTitle(target.identity.localId);
  } catch {
    // A key the parser refuses still names the runner; say it as reported.
  }
  return runner.agentTargetKey;
}
const cardId = deploySuggestionCardId;

function runsOnLine(runner: Runner): string {
  return t('newApp.auto.runsOn', {
    machine: runner.label,
    agent: runnerAgentTitle(runner),
  });
}

function workingSteps(phase: Extract<Phase, { kind: 'working' }>): SetupStep[] {
  const stored = phase.counts !== null;
  const placed = phase.runner !== null;
  return [
    {
      key: 'store',
      state: stored ? 'done' : 'running',
      title: t(
        stored ? 'newApp.auto.stepStore' : 'newApp.auto.stepStoreRunning',
      ),
      ...(phase.counts
        ? {
            detail: t('newApp.auto.storeDetail', {
              starters: phase.counts.starters,
              apps: phase.counts.apps,
            }),
          }
        : {}),
    },
    {
      key: 'where',
      state: placed ? 'done' : stored ? 'running' : 'upcoming',
      title: t(
        placed ? 'newApp.auto.stepWhere' : 'newApp.auto.stepWhereRunning',
      ),
      ...(phase.runner
        ? { detail: t('newApp.auto.online', { names: phase.runner.label }) }
        : {}),
    },
    {
      key: 'suggest',
      state: phase.running ? 'running' : 'upcoming',
      title: t(
        phase.running
          ? 'newApp.auto.stepSuggestRunning'
          : 'newApp.auto.stepSuggest',
      ),
    },
  ];
}

/** Each Machine in the runner owner's words: offline, or the owner's reason, with the Machine's setup as the next step. */
function presentMachine(
  machine: DeploySuggestionUnavailableMachine,
  openSetup: (machineId: string) => void,
): NewAppAutoMachine {
  const base = { machineId: machine.machineId, title: machine.label ?? null, glyph: 'hard-drives' as const };
  // Each reason in the runner owner's words (Settings' runner picker says the same); its next step is the Machine's setup.
  switch (machine.reason) {
    case 'offline':
      return { ...base, attention: true, status: t('status.offline'), action: null };
    case 'home_directory_unavailable':
      return { ...base, attention: false, status: t('llmTaskRunner.unavailable'), action: null };
    case 'no_ready_agent':
    case 'no_matching_model':
      return { ...base, attention: false,
        status: t(machine.reason === 'no_ready_agent' ? 'llmTaskRunner.noReadyAgent' : 'llmTaskRunner.noMatchingModel'),
        action: { label: t('machineAgents.setUp'), onPress: () => openSetup(machine.machineId) } };
  }
}

/**
 * Why the suggestion failed, said for where it failed: a Run's cause in the run card's words (a usage limit is the
 * limit), an answer the check refused as unusable, anything earlier as Happier not reaching an agent.
 */
function failedReason(outcome: Extract<DeploySuggestionOutcome, { kind: 'failed' }>): string {
    if (outcome.stage === 'answer') return t('newApp.auto.failedBody');
    if (outcome.stage === 'setup') return t('newApp.auto.failedSetupBody');
    const run = presentExecutionRunFailureSummary(outcome.runError ?? { code: outcome.code });
    return run ? [run.summary, run.reset].filter(Boolean).join(' · ') : t('newApp.auto.failedSetupBody');
}
