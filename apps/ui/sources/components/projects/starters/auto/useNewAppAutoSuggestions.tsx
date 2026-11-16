import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
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
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import type {
  NewAppAutoCard,
  NewAppAutoFact,
  NewAppAutoMachine,
  NewAppAutoView,
} from './NewAppAutoStep';

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
  params: Readonly<{ serverId: string | null; active: boolean }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [runnerChoice] = useSettingMutable('deploySuggestionRunnerV1');
  const [description, setDescription] = React.useState('');
  const [phase, setPhase] = React.useState<Phase>({ kind: 'describe' });
  const [chosenCardId, setChosenCardId] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  // The accepted Run's own Stop, for a Retry after its target refused the first one.
  const runStop = React.useRef<RunStop | null>(null);

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

  const suggest = React.useCallback(() => {
    if (!params.serverId || !description.trim()) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setChosenCardId(null);
    runStop.current = null;
    setPhase({ kind: 'working', counts: null, runner: null, running: false, stop: 'idle' });
    let runner: Runner | null = null;
    void suggestDeploySetup({
      serverId: params.serverId,
      description,
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
      if (outcome.kind === 'recommendations') setChosenCardId(cardId(0));
      setPhase({ kind: 'settled', outcome, runner });
    });
  }, [description, params.serverId, runnerChoice]);

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
    if (outcome.kind === 'recommendations') {
      return {
        kind: 'recommendations',
        source: phase.runner
          ? t('newApp.auto.sourceNote', { machine: phase.runner.label })
          : null,
        cards: outcome.recommendations.map((recommendation, index) =>
          presentCard(
            recommendation,
            outcome.catalog,
            index,
            <Icon
              name="sparkle"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />,
          ),
        ),
      };
    }
    if (outcome.kind === 'noAgent') {
      return {
        kind: 'noAgent',
        machines: outcome.machines.map((machine) =>
          presentMachine(machine, openMachineSetup),
        ),
      };
    }
    // Questions render in the step with U2's extracted question form; until then they read as no setup yet.
    if (outcome.kind === 'failed') return { kind: 'failed' };
    return { kind: 'nothing' };
  }, [openMachineSetup, phase, stop, theme.colors.text.secondary]);

  const settled = phase.kind === 'settled' ? phase.outcome : null;
  const chosen = React.useMemo((): NewAppAutoChosen | null => {
    if (settled?.kind !== 'recommendations' || chosenCardId === null)
      return null;
    const recommendation =
      settled.recommendations[Number(chosenCardId.slice(CARD_PREFIX.length))];
    return recommendation ? { recommendation, catalog: settled.catalog } : null;
  }, [chosenCardId, settled]);
  const runner = phase.kind === 'describe' ? null : phase.runner;

  return {
    description,
    setDescription,
    view,
    suggest,
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

const CARD_PREFIX = 'suggestion-';

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
const cardId = (index: number) => `${CARD_PREFIX}${index}`;

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

/** A card says the owner's facts in words: every title comes from the snapshot the suggestion was checked against. */
function presentCard(
  recommendation: DeploySuggestionRecommendationV1,
  catalog: DeploySuggestionCatalogV1,
  index: number,
  starterMark: React.ReactNode,
): NewAppAutoCard {
  const source = recommendation.source;
  const sourceTitle =
    source.kind === 'starter'
      ? catalog.starters.find((item) => item.id === source.starterId)?.title
      : source.kind === 'catalogApp'
        ? catalog.apps.find((item) => item.id === source.appId)?.title
        : undefined;
  const target = catalog.targets.find(
    (item) => item.id === recommendation.targetId,
  )?.title;
  const data = recommendation.data;
  const dataTitle =
    data.kind === 'store'
      ? data.engine
      : data.kind === 'catalogApp'
        ? catalog.apps.find((item) => item.id === data.appId)?.title
        : undefined;
  const facts: NewAppAutoFact[] = [
    ...(sourceTitle
      ? [
          {
            key: 'startsFrom' as const,
            value: sourceTitle,
            ...(source.kind === 'starter' ? { mark: starterMark } : {}),
          },
        ]
      : []),
    ...(target ? [{ key: 'runsOn' as const, value: target }] : []),
    ...(dataTitle ? [{ key: 'data' as const, value: dataTitle }] : []),
  ];
  const card = recommendation as DeploySuggestionRecommendationV1 &
    Partial<Readonly<{ title: string; why: string }>>;
  return {
    id: cardId(index),
    title: card.title ?? recommendation.whatToBuild,
    why: card.why ?? '',
    recommended: index === 0,
    facts,
  };
}

/** Each Machine in the runner owner's words: offline, or the owner's reason, with the Machine's setup as the next step. */
function presentMachine(
  machine: DeploySuggestionUnavailableMachine,
  openSetup: (machineId: string) => void,
): NewAppAutoMachine {
  const base = { machineId: machine.machineId, title: machine.label, glyph: 'hard-drives' as const };
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
