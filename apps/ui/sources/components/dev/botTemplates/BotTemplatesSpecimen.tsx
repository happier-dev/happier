import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@happier-dev/session-core/messages';
import type { BotTemplateInstanceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { BotTemplateDraftCard } from '@/components/sessions/bots/templates/BotTemplateDraftCard';
import { BotTemplateEditorBody } from '@/components/sessions/bots/templates/BotTemplateEditor';
import { BotTemplateRecipientBody } from '@/components/sessions/bots/templates/BotTemplateRecipientScreen';
import { BotTemplateRecipientInfo } from '@/components/sessions/bots/templates/BotTemplateRecipientInfo';
import { BotTemplateUpdateForm } from '@/components/sessions/bots/templates/BotTemplateUpdateReview';
import type { useBotTemplateUpdate } from '@/components/sessions/bots/templates/useBotTemplateUpdate';
import {
  createBotTemplateEditorBuffer,
  type BotTemplateSave,
} from '@/components/sessions/bots/templates/botTemplateEditorBuffer';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  SPECIMEN_DRAFT_RESULT,
  SPECIMEN_PREVIEW,
  SPECIMEN_TEMPLATE_DRAFT,
  SPECIMEN_UPDATE_REVIEW,
} from './botTemplateSpecimenFixtures';

const DRAFT_TOOL: ToolCall = {
  name: 'mcp__happier__action_execute',
  state: 'completed',
  createdAt: 0,
  startedAt: 0,
  completedAt: 0,
  description: null,
  input: { actionId: 'template.draft', input: {} },
  result: { ok: true, result: SPECIMEN_DRAFT_RESULT },
};

/**
 * Dev-only: the Bot template surfaces through their real components on the round-2 lab's content,
 * for side-by-side lab comparison without an Agent turn. `?frame=card|pane|page|preview|info|update|update-conflict|update-done`.
 * Never linked from product surfaces; nothing here writes.
 */
export function BotTemplatesSpecimen(
  props: Readonly<{ frame: string | null }>,
) {
  const { serverId } = useActiveServerSnapshot();
  const frame = props.frame ?? 'card';
  if (frame === 'pane' || frame === 'page')
    return <EditorFrame serverId={serverId} presentation={frame} />;
  if (frame === 'preview') return <PreviewFrame serverId={serverId} />;
  if (frame === 'update' || frame === 'update-conflict' || frame === 'update-done') return <UpdateFrame key={frame} frame={frame} />;
  if (frame === 'info')
    return (
      <ItemList>
        <ItemGroup>
          <BotTemplateRecipientInfo
            serverId={serverId}
            sessionRef={{ serverId, sessionId: 'specimen-release-captain' }}
            instance={{
              v: 1,
              source: {
                ...SPECIMEN_PREVIEW.source,
                serverId,
              } as BotTemplateInstanceV1['source'],
              acceptedVersion: '1.2.0',
              acceptedBase: {
                serverId,
                artifactId: '00000000-0000-4000-8000-0000000000b3',
              },
              skillIds: {},
              mcpServerIds: {},
              follow: true,
            }}
          />
        </ItemGroup>
      </ItemList>
    );
  return (
    <ScrollView contentContainerStyle={styles.transcript}>
      <View style={styles.column}>
        <BotTemplateDraftCard tool={DRAFT_TOOL} />
      </View>
    </ScrollView>
  );
}

function UpdateFrame({ frame }: Readonly<{ frame: string }>) {
  type Mutation = ReturnType<typeof useBotTemplateUpdate>['mutation'];
  const result = { acceptedVersion: SPECIMEN_UPDATE_REVIEW.upstream.release.version,
    applied: ['instructions'], kept: ['skill:release-notes'], resourceIds: [] };
  const [mutation, setMutation] = React.useState<Mutation>(() => frame === 'update-done' ? { kind: 'updated', result }
    : frame === 'update-conflict' ? { kind: 'failed', result: { ok: false, errorCode: 'revision_conflict', error: 'revision_conflict',
        details: { applied: [], remaining: ['instructions', 'skill:release-notes'], resourceIds: [] } } } : { kind: 'idle' });
  return <BotTemplateUpdateForm review={SPECIMEN_UPDATE_REVIEW} ready update={{ mutation, errorCode: null,
    reload: async () => { setMutation({ kind: 'idle' }); },
    apply: async () => { setMutation({ kind: 'updated', result }); },
    skip: async () => { setMutation({ kind: 'skipped' }); },
    stop: async () => { setMutation({ kind: 'stopped' }); } }} />;
}

const saveLocally: BotTemplateSave = async ({ revision }) => ({
  ok: true,
  revision,
});

function EditorFrame(
  props: Readonly<{ serverId: string; presentation: 'pane' | 'page' }>,
) {
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const execution = useMountedActionExecution(binding?.scope ?? null);
  const buffer = React.useMemo(
    () =>
      createBotTemplateEditorBuffer({
        draft: {
          ...SPECIMEN_TEMPLATE_DRAFT,
          sourceSessionRef: {
            ...SPECIMEN_TEMPLATE_DRAFT.sourceSessionRef,
            serverId: props.serverId,
          },
        },
        revision: { headerVersion: 1, bodyVersion: 1 },
      }),
    [props.serverId],
  );
  if (!binding) return null;
  const body = (
    <BotTemplateEditorBody
      artifactId={SPECIMEN_DRAFT_RESULT.draftArtifactId}
      serverId={props.serverId}
      presentation={props.presentation}
      buffer={buffer}
      scope={binding.scope}
      save={saveLocally}
      execute={execution.execute}
    />
  );
  return props.presentation === 'pane' ? (
    <View style={styles.paneRow}>
      <View style={styles.chat} />
      <View style={styles.pane}>{body}</View>
    </View>
  ) : (
    body
  );
}

function PreviewFrame(props: Readonly<{ serverId: string }>) {
  const execution = useMountedActionExecution(props.serverId);
  const source = React.useMemo(
    () =>
      ({
        ...SPECIMEN_PREVIEW.source,
        serverId: props.serverId,
      }) as typeof SPECIMEN_PREVIEW.source,
    [props.serverId],
  );
  const reader = React.useMemo(
    () => ({
      preview: { ...SPECIMEN_PREVIEW, source },
      failed: false,
      reload: async () => null,
      execution,
    }),
    [source, execution],
  );
  return (
    <BotTemplateRecipientBody
      reader={reader}
      source={source}
      serverId={props.serverId}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  transcript: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    padding: theme.space.s24,
  },
  column: { width: '100%', maxWidth: 980, alignSelf: 'center' },
  paneRow: { flex: 1, flexDirection: 'row' },
  chat: { flex: 1 },
  pane: {
    width: 480,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
  },
}));
