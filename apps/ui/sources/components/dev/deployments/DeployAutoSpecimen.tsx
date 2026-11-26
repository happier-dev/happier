import * as React from 'react';
import { View } from 'react-native';
import type { Message } from '@happier-dev/session-core/messages';
import { DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
  DeploySuggestionCatalogV1Schema,
  checkDeploySuggestionV1,
  type DeploySuggestionRecommendationV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

import { NewAppMakingSteps } from '@/components/projects/starters/NewAppMakingSteps';
import {
  NewAppAutoStep,
  type NewAppAutoView,
} from '@/components/projects/starters/auto/NewAppAutoStep';
import { deploySuggestionFailedReason } from '@/components/projects/starters/auto/useNewAppAutoSuggestions';
import { useOpenNewApp } from '@/components/projects/starters/newAppPresentation';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { MessageView } from '@/components/sessions/transcript/MessageView';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useDemoMessages } from '@/hooks/session/useDemoMessages';
import { t } from '@/text';

/**
 * Dev-only specimen of Deploy an app's auto mode (DESIGN-ACCEPT-4) over fixtures, drawn by the real owners. `?state=`:
 * `session` (a Session agent's checked suggestion in the transcript, through the real MessageView and result card),
 * `cards` (the real Deploy an app dialog opened on those cards, as Use this setup from a Session opens it), `failed`
 * (a Run its Machine refused, under the kept description, as the narrow page shows it), `making` (Making's checklist
 * on the page column). It proves composition only; the loaded flow is judged on a real Account.
 */
const catalog = DeploySuggestionCatalogV1Schema.parse({
  starters: [
    {
      id: 'static',
      title: 'Static website',
      deploy: { framework: 'html', output: 'static' },
    },
  ],
  apps: [],
  targets: [
    {
      id: 'own',
      title: 'Own server',
      targetClass: 'ownServer',
      availability: 'available',
      accepts: ['static'],
      needs: [],
      sources: { gitIntegration: ['github'], upload: false },
    },
  ],
  machines: [
    {
      machineId: 'machine-nldw4',
      label: 'NLDW4-5-40-40',
      online: true,
      homeDir: '/home/baker',
      readiness: 'ready',
    },
  ],
  stores: [],
  forges: [{ providerKind: 'github', title: 'GitHub' }],
});
const bakery = {
  source: { kind: 'starter', starterId: 'static' },
  targetId: 'own',
  repositoryProviderKind: 'github',
  title: 'Bakery site',
  why: 'A menu and opening hours change rarely, so plain pages load fast and need no database to keep up.',
  whatToBuild:
    'A small private bakery website with a menu and opening hours, as static HTML and CSS',
  stack: { framework: 'html', output: 'static' },
  data: { kind: 'none' },
  variables: [],
} satisfies DeploySuggestionRecommendationV1;
const DESCRIPTION =
  'Build a tiny, private bakery website with a menu and opening hours.';
const checked = checkDeploySuggestionV1({ recommendations: [bakery] }, catalog);

const checkCall = {
  id: 'deploy-check-specimen',
  name: 'mcp__happier__action_execute',
  state: 'completed' as const,
  input: {
    actionId: DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1,
    input: {
      description: DESCRIPTION,
      suggestion: { recommendations: [bakery] },
    },
  },
  result: { ok: true, result: checked },
  createdAt: 1,
  startedAt: 1,
  completedAt: 2,
  description: null,
};

// The check as a transcript tool message, drawn by the transcript's own MessageView (its row chrome and indent).
const sessionMessages = [
  {
    id: 'deploy-check-specimen-message',
    localId: null,
    createdAt: 1,
    kind: 'tool-call',
    tool: checkCall,
    children: [],
  },
] as unknown as Message[];

function SessionCard() {
  const source = useDemoMessages(sessionMessages);
  const messagesById = source.useMessagesById();
  return (
    <SessionTranscriptSourceProvider source={source}>
      <View testID="deployAuto.session" style={{ flex: 1, paddingVertical: 20 }}>
        {sessionMessages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            metadata={null}
            sessionId={source.sessionId}
            getMessageById={(id: string) => messagesById[id] ?? null}
          />
        ))}
      </View>
    </SessionTranscriptSourceProvider>
  );
}

function OpenCards() {
  const openNewApp = useOpenNewApp();
  const recommendation = checked.recommendations[0];
  React.useEffect(() => {
    if (recommendation)
      openNewApp(null, null, {
        startOn: 'describe',
        suggestion: { description: DESCRIPTION, recommendation, catalog },
      });
  }, [openNewApp, recommendation]);
  return <View testID="deployAuto.cards" />;
}

const failedView: NewAppAutoView = {
  kind: 'failed',
  code: 'execution_run_target_unavailable',
  reason: deploySuggestionFailedReason(
    {
      kind: 'failed',
      code: 'execution_run_target_unavailable',
      stage: 'run',
      runner: {
        v: 1,
        modelSelection: {
          agentTargetKey: 'agent:muse',
          providerConnectionId: null,
          modelId: 'muse-spark-1.3-contributor',
        },
      } as never,
    },
    {
      kind: 'runner',
      machineId: 'machine-nldw4',
      label: 'NLDW4-5-40-40',
      agentTargetKey: 'agent:muse',
      agentTitle: 'muse-spark-1.3-contributor',
    },
  ),
  runner: null,
};

function Failed(props: Readonly<{ phone: boolean }>) {
  const [description, setDescription] = React.useState(DESCRIPTION);
  return (
    <ItemList testID="deployAuto.failed">
      <PageHeader
        title={t('newApp.auto.title')}
        description={t('newApp.auto.description')}
        alwaysShowTitle
      />
      <NewAppAutoStep
        view={failedView}
        description={description}
        onDescriptionChange={setDescription}
        chosenCardId={null}
        onChooseCard={() => {}}
        onEditDescription={() => {}}
        onTryAgain={() => {}}
        onChooseStarter={() => {}}
        phone={props.phone}
      />
    </ItemList>
  );
}

function Making(props: Readonly<{ opening: boolean }>) {
  return (
    <ItemList testID="deployAuto.making">
      <PageHeader
        title={t('newApp.creatingTitle', { name: 'Replay 50 Reviewed Bakery' })}
        description={t('newApp.creatingDescription')}
        alwaysShowTitle
      />
      <NewAppMakingSteps
        opening={props.opening}
        codeLivesOn="GitHub · baker/replay-50-reviewed-bakery · Private"
      />
    </ItemList>
  );
}

export function DeployAutoSpecimen(
  props: Readonly<{ state: string; phone: boolean }>,
) {
  switch (props.state) {
    case 'cards':
      return <OpenCards />;
    case 'failed':
      return <Failed phone={props.phone} />;
    case 'making':
      return <Making opening={false} />;
    case 'opening':
      return <Making opening />;
    default:
      return <SessionCard />;
  }
}
