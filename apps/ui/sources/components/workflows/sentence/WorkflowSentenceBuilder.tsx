import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';
import { useActionFieldOptionsForMachine } from '@/components/sessions/actions/useSessionActionFieldOptions';
import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover/Popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineListForServer, useServerScopedMachine } from '@/sync/domains/state/storage';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import { useWorkflowSentenceDraft } from '../authoring/useWorkflowSentenceDraft';
import type { WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
import { useWorkflowEditorComposerCustody } from '../editor/useWorkflowEditorComposerCustody';
import {
  addWorkflowEditorBlock,
  WorkflowBlockListEditor,
} from '../editor/WorkflowBlockListEditor';
import {
  WorkflowAddBlockMenu,
  type WorkflowAddBlockRequest,
} from '../editor/WorkflowAddBlockMenu';
import { useWorkflowEditorSelector } from '../editor/workflowEditorDraftStore';
import { WorkflowDocumentGridContext } from '../editor/workflowEditorStyles';
import { formatWorkflowWhereSummary } from '../editor/WorkflowProjectTargetControl';
import { readWorkflowActionFieldRequests } from '../presentation/workflowActionFieldRequests';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '../presentation/workflowBlockKindGlyph';
import { formatWorkflowSummaryStepName } from '../presentation/workflowSummaryLine';
import { useWorkflowAuthoringHost } from '../screens/useWorkflowAuthoringHost';
import { validateWorkflowEditorPage } from '../screens/WorkflowEditorBody';
import { WorkflowTriggerSection } from '../triggers/WorkflowTriggerSection';
import { WorkflowSentenceChip } from './WorkflowSentenceChip';
import { WorkflowSentenceView } from './WorkflowSentenceView';

/** The lab's builder width (05 S3): the sentence reads on one or two lines beside its verb body. */
const BUILDER_WIDTH_PX = 600;
const BUILDER_MAX_HEIGHT_PX = 720;
const TEST_ID = 'workflow-builder';

const NO_INPUTS: readonly never[] = [];
const readBlocks = (draft: { blocks: readonly WorkflowBlock[] }) =>
  draft.blocks;
const readName = (draft: { name: string }) => draft.name;
const sameRetainedValue = <T,>(left: T, right: T): boolean =>
  retainDeep(left, right) === left;

export type WorkflowSentenceBuilderProps = Readonly<{
  anchorRef: React.RefObject<View | null>;
  /** The source the sentence starts from (a resource's place, an event, a starter's trigger). One per mount. */
  intent: WorkflowSentenceEditorIntent;
  accountLifetime: ServerAccountScopeLifetime;
  onRequestClose: () => void;
}>;

/**
 * "Automate this…" (D10, 05 S3): one sentence — When ⟨event⟩, ⟨verb ▾⟩ on ⟨Machine⟩ in ⟨folder⟩ — and the
 * verb's own step card under it. Save writes an ordinary one-step workflow and its trigger through the
 * sentence draft's Save; Add another step… opens the same draft in the editor. Anchored on wide, the shared
 * sheet on a phone.
 */
export function WorkflowSentenceBuilder(
  props: WorkflowSentenceBuilderProps,
): React.ReactElement {
  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      boundaryRef={null}
      placement="auto-vertical"
      phonePresentation="sheet"
      sheetMaterial="solid"
      accessibilityLabel={t('workflows.sentence.builder.title')}
      edgePadding={{ horizontal: 12, vertical: 12 }}
      portal={{
        web: { target: 'body' },
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
      maxWidthCap={BUILDER_WIDTH_PX}
      maxHeightCap={BUILDER_MAX_HEIGHT_PX}
      onRequestClose={props.onRequestClose}
    >
      {({ maxHeight, maxWidth, presentation }) => (
        <WorkflowSentenceBuilderBody
          {...props}
          maxHeight={maxHeight}
          width={Math.min(maxWidth, BUILDER_WIDTH_PX)}
          sheet={presentation === 'sheet'}
        />
      )}
    </Popover>
  );
}

function WorkflowSentenceBuilderBody(
  props: WorkflowSentenceBuilderProps &
    Readonly<{ maxHeight: number; width: number; sheet: boolean }>,
) {
  const router = useRouter();
  const lifetime = props.accountLifetime;
  const serverId = lifetime.scope.serverId;
  const sentence = useWorkflowSentenceDraft(props.intent, lifetime);
  const { draftStore, onChange, project } = sentence;
  const blocks = useWorkflowEditorSelector(draftStore, readBlocks);
  const name = useWorkflowEditorSelector(draftStore, readName);
  const step = blocks[0] ?? null;
  const machine = useServerScopedMachine(serverId, project?.machineId ?? null);
  const machines = useMachineListForServer(serverId, true) ?? undefined;
  const machineName = machine ? getMachineDisplayName(machine) : null;
  const host = useWorkflowAuthoringHost({ projectTarget: project, serverId });
  const readDraft = draftStore.get;
  const composerCustody = useWorkflowEditorComposerCustody({
    readDraft,
    draftId: readDraft().draftId,
    blockIds: React.useMemo(() => blocks.map((block) => block.id), [blocks]),
    scope: host.composerScope,
    editable: true,
    onChange,
    onSelect: () => {},
    focusPrompt: () => {},
  });
  const actionFieldRequests = useWorkflowEditorSelector(
    draftStore,
    readWorkflowActionFieldRequests,
    sameRetainedValue,
  );
  const resolveActionFieldOptions = useActionFieldOptionsForMachine({
    machineId: project?.machineId ?? null,
    serverId,
    enabled: actionFieldRequests.hasActionBlocks,
    requests: actionFieldRequests.requests,
  });
  const triggers = sentence.triggers;
  const whenClause = (
    <WorkflowTriggerSection
      presentation="sentence"
      accountLifetime={lifetime}
      testIDPrefix={TEST_ID}
      set={triggers.set}
      draft={triggers.draft}
      onChangeDraft={triggers.setDraft}
      status={triggers.status}
      onRetry={triggers.retry}
      whereTarget={project}
      whereSummary={formatWorkflowWhereSummary({
        target: project,
        machineName,
      })}
      inputs={NO_INPUTS}
      stepsUnsaved
      incomplete={{
        state: triggers.incomplete,
        onChange: triggers.updateIncomplete,
      }}
    />
  );
  // The verb replaces the sentence's one step: a new verb starts that step afresh.
  const changeVerb = (request: WorkflowAddBlockRequest) => {
    addWorkflowEditorBlock({
      draft: { ...draftStore.get(), blocks: [] },
      list: { kind: 'root' },
      request,
      onChange,
      onSelect: () => {},
    });
  };
  const verbClause = (
    <WorkflowAddBlockMenu
      purpose="verb"
      onAdd={changeVerb}
      scopeLabel={t('workflows.sentence.verbs.title')}
      composerScope={host.composerScope}
      renderTrigger={({ open, toggle, anchorRef }) => (
        <WorkflowSentenceChip
          anchorRef={anchorRef}
          kind={step === null ? 'placeholder' : 'verb'}
          title={t('workflows.sentence.builder.does')}
          label={
            step === null
              ? t('workflows.sentence.verbs.choose')
              : describeVerb(step)
          }
          icon={step === null ? 'plus' : verbGlyph(step)}
          open={open}
          hasPopup="menu"
          onPress={toggle}
          testID={`${TEST_ID}-verb`}
        />
      )}
      testID={`${TEST_ID}-verb-menu`}
    />
  );
  const validation = validateWorkflowEditorPage(draftStore.get(), {
    stagedAttachments: composerCustody.readStagedAttachments(),
    authoringFacts: host.authoringFacts,
    triggerEvents: triggers.triggerEvents,
  });
  const close = props.onRequestClose;
  const save = async () => {
    const outcome = await sentence.save();
    if (outcome.status === 'applied' || outcome.status === 'unchanged') close();
  };
  const openEditor = () => {
    const route = sentence.openInEditor();
    if (route === null) return;
    close();
    router.push(route);
  };
  const canSave = step !== null && validation.valid && !sentence.saving;
  return (
    <FloatingOverlay
      maxHeight={props.maxHeight}
      scrollEnabled
      surfaceChrome="theme"
      containerStyle={{ width: props.width }}
      footer={
        <RoundButtonSizeScope size="small" presentation="uniform">
          <View style={styles.foot}>
            {sentence.failed === null ? null : (
              <Text
                testID={`${TEST_ID}-failed`}
                accessibilityLiveRegion="polite"
                style={styles.failed}
              >
                {sentence.failed}
              </Text>
            )}
            <RoundButton
              size="small"
              display="inverted"
              leading={<Icon name="plus" size={ICON_SIZE.xs} />}
              testID={`${TEST_ID}-open-editor`}
              title={t('workflows.sentence.builder.addAnotherStep')}
              onPress={openEditor}
            />
            <View style={styles.footEnd}>
              <RoundButton
                size="small"
                display="inverted"
                testID={`${TEST_ID}-cancel`}
                title={t('common.cancel')}
                onPress={close}
              />
              <RoundButton
                size="small"
                testID={`${TEST_ID}-save`}
                title={t('common.save')}
                disabled={!canSave}
                loading={sentence.saving}
                onPress={() => {
                  void save();
                }}
              />
            </View>
          </View>
        </RoundButtonSizeScope>
      }
    >
      <View testID={TEST_ID} style={styles.body}>
        {props.sheet ? null : (
          <Text style={styles.title}>
            {t('workflows.sentence.builder.title')}
          </Text>
        )}
        <WorkflowDocumentGridContext.Provider value="compact">
          <WorkflowSentenceView
            draftStore={draftStore}
            onChange={onChange}
            documentEditable
            selectedBlockId={step?.id ?? null}
            onSelectBlock={() => {}}
            whenClause={whenClause}
            verbClause={verbClause}
            place={{
              target: project,
              machineName,
              ...(machines === undefined ? {} : { machines }),
              accountLifetime: lifetime,
              onChange: (target) => {
                if (isWorkflowProjectTarget(target))
                  sentence.changeProject(target);
              },
            }}
            composerScope={host.composerScope}
            renderStepCard={(blockId) => (
              <WorkflowBlockListEditor
                draft={draftStore.get()}
                readDraft={readDraft}
                list={{ kind: 'root' }}
                blocks={blocks}
                depth={0}
                selectedBlockId={blockId}
                validation={validation}
                composerScope={host.composerScope}
                composerCustody={composerCustody}
                onChange={onChange}
                onSelect={() => {}}
                onCustomize={() => {}}
                onlyBlockId={blockId}
                // A new sentence is incomplete by design; Save stays disabled until it is not.
                revealIssues={false}
                authoringFacts={host.authoringFacts}
                resolveActionFieldOptions={resolveActionFieldOptions}
                testIDPrefix={TEST_ID}
              />
            )}
            testIDPrefix={TEST_ID}
          />
        </WorkflowDocumentGridContext.Provider>
        {step === null ? (
          <Text style={styles.blank}>
            {t('workflows.sentence.builder.blank')}
          </Text>
        ) : null}
        <View style={styles.name}>
          <Text style={styles.nameLabel}>
            {t('workflows.sentence.builder.savesAs')}
          </Text>
          <View style={styles.nameField}>
            <FieldTextInput
              testID={`${TEST_ID}-name`}
              value={name}
              onChangeText={(next) =>
                onChange({ ...draftStore.get(), name: next })
              }
              accessibilityLabel={t('workflows.sentence.builder.savesAs')}
              placeholder={t('workflows.sentence.builder.namePlaceholder')}
            />
          </View>
        </View>
      </View>
    </FloatingOverlay>
  );
}

/** The verb as the sentence says it: the three presets by name, any other step as the summary line names it. */
function describeVerb(step: WorkflowBlock): string {
  if (step.kind === 'step') return t('workflows.sentence.verbs.session');
  if (step.kind === 'action' && step.actionId === 'machines.command.run')
    return t('workflows.sentence.verbs.command');
  if (step.kind === 'action' && step.actionId === 'session.message.send')
    return t('workflows.sentence.verbs.message');
  return formatWorkflowSummaryStepName(step);
}

function verbGlyph(
  step: WorkflowBlock,
): React.ComponentProps<typeof WorkflowSentenceChip>['icon'] {
  if (step.kind === 'action' && step.actionId === 'machines.command.run')
    return 'terminal';
  if (step.kind === 'action' && step.actionId === 'session.message.send')
    return 'chat-circle';
  if (step.kind === 'step') return 'sparkle';
  return WORKFLOW_BLOCK_KIND_GLYPH[step.kind];
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s16,
  },
  title: {
    ...Typography.variant('heading', 'semiBold'),
    color: theme.colors.text.primary,
  },
  blank: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  name: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  nameLabel: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
  nameField: {
    flex: 1,
    minWidth: 0,
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s16,
  },
  footEnd: {
    marginLeft: 'auto',
    flexDirection: 'row',
    gap: theme.space.s8,
  },
  failed: {
    ...Typography.variant('meta'),
    color: theme.colors.state.danger.foreground,
    width: '100%',
  },
}));
