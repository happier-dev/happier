import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@happier-dev/session-core/messages';
import type { BotTemplateContentV1, BotTemplateInstanceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { buildAccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/importActionV1';
import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import { SharedBotPetOffer } from '@/components/sessions/bots/SharedBotPetOffer';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { BotTemplateDraftCard } from '@/components/sessions/bots/templates/BotTemplateDraftCard';
import { BotTemplateEditorBody } from '@/components/sessions/bots/templates/BotTemplateEditor';
import { BotTemplateRecipientBody } from '@/components/sessions/bots/templates/BotTemplateRecipientScreen';
import { BotTemplateRecipientInfo } from '@/components/sessions/bots/templates/BotTemplateRecipientInfo';
import { BotTemplateUpdateForm } from '@/components/sessions/bots/templates/BotTemplateUpdateReview';
import type { useBotTemplateUpdate } from '@/components/sessions/bots/templates/useBotTemplateUpdate';
import type { BotTemplateOpenRefusal } from '@/components/sessions/bots/templates/botTemplateOpenRefusal';
import {
  createBotTemplateEditorBuffer,
  type BotTemplateSave,
} from '@/components/sessions/bots/templates/botTemplateEditorBuffer';
import { SavedSkillCardSpecimen } from '@/components/dev/pluginUi/SavedSkillCardSpecimen';
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
 * for side-by-side lab comparison without an Agent turn. `?frame=card|pane|page|preview|preview-pet|page-pet|pet-offer|refused-not_found|refused-no_access|refused-plain_account|info|update|update-conflict|update-done|saved-skill`.
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
  // PET-SHARE: a template carrying Milo as a bundled package (its Copy shows "Pet: Milo"), and a shared Bot's offer.
  if (frame === 'preview-pet') return <PetPreviewFrame serverId={serverId} />;
  if (frame === 'page-pet') return <PetEditorFrame serverId={serverId} />;
  if (frame === 'pet-offer')
    return (
      <ItemList>
        {/* As Info's identity draws it: under where the Bot runs, no sheet. Nothing shows where pets or their sync are off. */}
        <ItemGroup surface="none" header="none">
          <SharedBotPetOffer face={SPECIMEN_SHARED_PET_FACE} />
        </ItemGroup>
      </ItemList>
    );
  // The skill a Bot saves in its own turn, in a transcript-width column (lab r2 skills-states).
  if (frame === 'saved-skill')
    return (
      <ScrollView contentContainerStyle={styles.transcript}>
        <View style={styles.column}>
          <SavedSkillCardSpecimen />
        </View>
      </ScrollView>
    );
  const refusal = REFUSALS.find(value => frame === `refused-${value}`);
  if (refusal) return <PreviewFrame serverId={serverId} refusal={refusal} />;
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
  props: Readonly<{ serverId: string; presentation: 'pane' | 'page'; pet?: BotTemplateContentV1['pet'] }>,
) {
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const execution = useMountedActionExecution(binding?.scope ?? null);
  const buffer = React.useMemo(
    () =>
      createBotTemplateEditorBuffer({
        draft: {
          ...SPECIMEN_TEMPLATE_DRAFT,
          ...(props.pet ? { content: { ...SPECIMEN_TEMPLATE_DRAFT.content, pet: props.pet } } : {}),
          sourceSessionRef: {
            ...SPECIMEN_TEMPLATE_DRAFT.sourceSessionRef,
            serverId: props.serverId,
          },
        },
        revision: { headerVersion: 1, bodyVersion: 1 },
      }),
    [props.serverId, props.pet],
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

/** A Bot someone shared, wearing a catalog pet the viewer doesn't hold yet. */
const SPECIMEN_SHARED_PET_FACE: SessionBotFaceV1 = { seed: 'release-captain', pet: { kind: 'accountPet',
  accountPetId: 'owner-capy', displayName: 'Capy', origin: { kind: 'registry', sourceId: 'builtin:petdex', itemId: 'capy' } } };

/** The built-in Milo's real sheet, read once and carried as a template's bundled package (what a created pet ships as). */
function useSpecimenBundledPet(): BotTemplateContentV1['pet'] | null {
  const [pet, setPet] = React.useState<BotTemplateContentV1['pet'] | null>(null);
  React.useEffect(() => {
    const source = resolveBuiltInPetPackage('milo').spritesheetSource;
    const uri = typeof source === 'string' ? source : source && typeof source === 'object' && 'uri' in source ? source.uri : null;
    if (!uri) return;
    let active = true;
    void fetch(uri).then(response => response.arrayBuffer()).then(buffer => {
      const bytes = new Uint8Array(buffer);
      if (!active) return;
      setPet({ name: 'Milo', source: { kind: 'package', package: buildAccountPetCreateRequestV1({
        manifest: { id: 'milo-copy', displayName: 'Milo', description: 'A small companion', spritesheetPath: 'spritesheet.webp' },
        mediaType: 'image/webp', spritesheetBytes: bytes, origin: { kind: 'manualImport' } }) } });
    });
    return () => { active = false; };
  }, []);
  return pet;
}

function PetEditorFrame(props: Readonly<{ serverId: string }>) {
  const pet = useSpecimenBundledPet();
  if (!pet) return null;
  return <EditorFrame serverId={props.serverId} presentation="page" pet={pet} />;
}

function PetPreviewFrame(props: Readonly<{ serverId: string }>) {
  const pet = useSpecimenBundledPet();
  if (!pet) return null;
  return <PreviewFrame serverId={props.serverId} pet={pet} />;
}

const REFUSALS: readonly BotTemplateOpenRefusal[] = ['not_found', 'no_access', 'plain_account'];

/** `refusal` renders the refused open (deleted, no longer shared, Plain recipient) instead of the release. */
function PreviewFrame(props: Readonly<{ serverId: string; refusal?: BotTemplateOpenRefusal; pet?: BotTemplateContentV1['pet'] }>) {
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
      preview: props.refusal ? null : { ...SPECIMEN_PREVIEW, source, ...(props.pet ? { release: { ...SPECIMEN_PREVIEW.release,
        content: { ...SPECIMEN_PREVIEW.release.content, pet: props.pet } } } : {}) },
      failed: Boolean(props.refusal),
      refusal: props.refusal ?? null,
      reload: async () => null,
      execution,
    }),
    [source, execution, props.refusal, props.pet],
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
