import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Href } from 'expo-router';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import { ApprovalPromptCard } from '@/components/tools/shell/approvals/ApprovalPromptCard';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { preparePluginInstallReviewHttpFixture } from '@/components/dev/plugins/pluginInstallReviewHttpFixture';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import {
  APPROVAL_CHECKS_PERSON_SCENES,
  APPROVAL_CHECKS_RUN_ID,
  type ApprovalChecksPersonScene,
  APPROVAL_CHECKS_SCENE_LABELS,
  APPROVAL_CHECKS_SCENES,
  APPROVAL_CHECKS_WORKFLOW_TITLES,
  createApprovalChecksSceneFixture,
  type ApprovalChecksScene,
} from '@/dev/testkit/fixtures/approvalAutomaticChecksFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
  storage,
  useActiveServerAccountScope,
} from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';

const SESSION_ID = 'dev-approval-checks';

/**
 * The asking Session and the running check's Run, client-local and removed on unmount, so the real card names its
 * Agent and reads "step 1 of 2" and the elapsed time from a Run exactly as it does live. Neither reaches the server.
 */
function useSeededChecksContext(
  scope: ServerAccountScope,
  nowMs: number,
): void {
  React.useEffect(() => {
    const session = createSessionFixture({
      id: SESSION_ID,
      serverId: scope.serverId,
      active: true,
      metadata: {
        path: '/Users/dev/happier-web',
        host: 'nl-build-3',
        homeDir: '/Users/dev',
        machineId: SESSION_ID,
        flavor: 'claude',
      } as Session['metadata'],
    });
    const run = workflowRunRowFromSummary(
      createWorkflowRunSummaryFixture({
        id: APPROVAL_CHECKS_RUN_ID,
        ownerAccountId: scope.accountId,
        state: 'running',
        stepProgress: { completed: 1, total: 2 },
        createdAt: new Date(nowMs - 42_000).toISOString(),
        updatedAt: new Date(nowMs - 2_000).toISOString(),
      }),
    );
    const state = storage.getState();
    // Never replace an existing local entry, even in a dev specimen.
    const seedsSession = !state.sessions[SESSION_ID];
    if (seedsSession)
      storage.setState({
        sessions: { ...state.sessions, [SESSION_ID]: session },
      });
    state.upsertWorkflowRuns([run], scope);
    // The checks' saved workflows, by their headers' names, as the card reads them live.
    const workflows = Object.entries(APPROVAL_CHECKS_WORKFLOW_TITLES)
      .filter(([id]) => !state.artifacts[id])
      .map(([id, title]): DecryptedArtifact => ({
        id, title, headerVersion: 1, seq: 1, createdAt: nowMs, updatedAt: nowMs, isDecrypted: true,
        ownerAccountId: scope.accountId, access: 'owner',
        rawHeader: { kind: 'workflow-definition.v1', definitionId: id, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title } },
      }));
    if (workflows.length > 0) storage.setState((current) => ({
      artifacts: { ...current.artifacts, ...Object.fromEntries(workflows.map((artifact) => [artifact.id, artifact])) },
    }));
    return () => {
      if (workflows.length > 0) storage.setState((current) => {
        const artifacts = { ...current.artifacts };
        for (const artifact of workflows) if (artifacts[artifact.id] === artifact) delete artifacts[artifact.id];
        return { artifacts };
      });
      storage.getState().removeWorkflowRun(APPROVAL_CHECKS_RUN_ID, scope);
      if (!seedsSession) return;
      storage.setState((current) => {
        if (current.sessions[SESSION_ID] !== session) return current;
        const sessions = { ...current.sessions };
        delete sessions[SESSION_ID];
        return { sessions };
      });
    };
  }, [nowMs, scope]);
}

function useSpecimenTranscriptSource(): SessionTranscriptSource {
  const router = useRouter();
  return React.useMemo(
    () => ({
      ...createReadOnlySessionTranscriptSource({
        sessionId: SESSION_ID,
        messages: [],
        agentState: null,
        metadata: null,
        reducerState: null,
        interaction: { canSendMessages: true, canApprovePermissions: true },
        // Decisions go nowhere: the specimen shows the card, it never answers a real request.
        actions: {
          respondToPermission: async () => {},
          answerUserAction: async () => {},
          abort: async () => {},
          submitMessage: async () => {},
        },
      }),
      navigate: (route: string) => router.push(route as Href),
    }),
    [router],
  );
}

/**
 * Dev-only: the Agent approval card while an Action's before checks hold it, in every lab scene
 * (`consent-v-*`, `wait-v-a*`, `override-v-aoverride`), drawn by the real `ApprovalPromptCard` over the testkit's
 * check fixtures. `scene` shows one; without it the page lists them all.
 */
export function ApprovalChecksSpecimen(
  props: Readonly<{ scene: ApprovalChecksScene | ApprovalChecksPersonScene | null }>,
) {
  const scope = useActiveServerAccountScope();
  const [nowMs] = React.useState(() => Date.now());
  if (!scope) return null;
  const { scene } = props;
  if (scene !== null && scene in APPROVAL_CHECKS_PERSON_SCENES) {
    return <PersonChecksScene scope={scope} nowMs={nowMs} scene={scene as ApprovalChecksPersonScene} />;
  }
  return (
    <ApprovalChecksScenes scope={scope} nowMs={nowMs} scene={scene as ApprovalChecksScene | null} />
  );
}

/**
 * A person's own deploy held by its checks (`?scene=pconsent|pchecking|prefused|pfailed|poverride`): the real in-place
 * approval review opens over a dev-only Artifact overlay, as the deploy confirmation opens it live.
 */
function PersonChecksScene(props: Readonly<{ scope: ServerAccountScope; nowMs: number; scene: ApprovalChecksPersonScene }>) {
  const { scope, nowMs, scene } = props;
  useSeededChecksContext(scope, nowMs);
  const artifactId = `dev-approval-checks-person-${scene}`;
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    const request = createApprovalChecksSceneFixture(APPROVAL_CHECKS_PERSON_SCENES[scene], {
      serverId: scope.serverId, accountId: scope.accountId, nowMs, asker: 'person' }).approval;
    const artifact = { id: artifactId, header: buildApprovalRequestArtifactHeaderV1(request), title: request.summary ?? '',
      body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      isDecrypted: true } satisfies DecryptedArtifact;
    void preparePluginInstallReviewHttpFixture(scope.serverId, [artifact], controller.signal).then((install) => {
      if (controller.signal.aborted) return;
      dispose = install();
      setReady(true);
    });
    return () => { controller.abort(); dispose?.(); setReady(false); };
  }, [artifactId, nowMs, scene, scope.accountId, scope.serverId]);
  useInPlaceApprovalReview({ approvalId: ready ? artifactId : null, approvalPending: true, serverId: scope.serverId });
  return <View style={styles.page} testID="dev-approval-checks-person" />;
}

function ApprovalChecksScenes(
  props: Readonly<{
    scope: ServerAccountScope;
    nowMs: number;
    scene: ApprovalChecksScene | null;
  }>,
) {
  useSeededChecksContext(props.scope, props.nowMs);
  const source = useSpecimenTranscriptSource();
  const scenes = props.scene ? [props.scene] : APPROVAL_CHECKS_SCENES;
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      testID="dev-approval-checks-screen"
    >
      <View style={styles.column}>
        <SessionTranscriptSourceProvider source={source}>
          {scenes.map((scene) => (
            <ApprovalChecksSceneCard
              key={scene}
              scene={scene}
              scope={props.scope}
              nowMs={props.nowMs}
              labeled={props.scene === null}
            />
          ))}
        </SessionTranscriptSourceProvider>
      </View>
    </ScrollView>
  );
}

const ApprovalChecksSceneCard = React.memo(function ApprovalChecksSceneCard(
  props: Readonly<{
    scene: ApprovalChecksScene;
    scope: ServerAccountScope;
    nowMs: number;
    labeled: boolean;
  }>,
) {
  const { scene, scope, nowMs } = props;
  const fixture = React.useMemo(
    () =>
      createApprovalChecksSceneFixture(scene, {
        serverId: scope.serverId,
        accountId: scope.accountId,
        nowMs,
      }),
    [nowMs, scene, scope.accountId, scope.serverId],
  );
  const artifact = React.useMemo(
    () => ({
      id: `dev-approval-checks-${scene}`,
      header: { title: null, serverId: scope.serverId },
    }),
    [scene, scope.serverId],
  );
  return (
    <View style={styles.scene} testID={`dev-approval-checks:${scene}`}>
      {props.labeled ? (
        <Text variant="meta" style={styles.label}>
          {APPROVAL_CHECKS_SCENE_LABELS[scene]}
        </Text>
      ) : null}
      <ApprovalPromptCard
        artifact={artifact}
        approval={fixture.approval}
        sessionId={SESSION_ID}
        canApprove
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.background.canvas },
  content: { alignItems: 'center', padding: theme.space.s16 },
  column: { width: '100%', maxWidth: PAGE_LIST_METRICS.columnMaxWidthPx.reading, gap: theme.space.s24 },
  scene: { gap: theme.space.s6 },
  label: { color: theme.colors.text.tertiary },
}));
