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
import { readWorkflowBlockShape } from '@/sync/domains/workflows/workflowAuthoring';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import { useWorkflowSentenceDraft } from '../authoring/useWorkflowSentenceDraft';
import type { WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
import { useWorkflowEditorComposerCustody } from '../editor/useWorkflowEditorComposerCustody';
import { WorkflowBlockListEditor } from '../editor/WorkflowBlockListEditor';
import { WorkflowInspector } from '../editor/WorkflowInspector';
import { useWorkflowEditorSelector } from '../editor/workflowEditorDraftStore';
import { renderWorkflowCardFieldRow } from '../editor/workflowCardFieldRow';
import { WorkflowDocumentGridContext } from '../editor/workflowEditorStyles';
import { formatWorkflowWhereSummary } from '../editor/WorkflowProjectTargetControl';
import { readWorkflowActionFieldRequests } from '../presentation/workflowActionFieldRequests';
import { useWorkflowAuthoringHost } from '../screens/useWorkflowAuthoringHost';
import { validateWorkflowEditorPage } from '../screens/WorkflowEditorBody';
import { WorkflowTriggerSection } from '../triggers/WorkflowTriggerSection';
import { WorkflowSentenceRowsContext } from './WorkflowSentenceChip';
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
  /** A view the builder never covers (its host's header line): it opens beyond it, still hanging from the anchor. */
  clearanceRef?: React.RefObject<View | null>;
  /** The source the sentence starts from (a resource's place, an event, a starter's trigger). One per mount. */
  intent: WorkflowSentenceEditorIntent;
  /** What is being automated, named in the title ("Automate Production · happier-web"); absent: "Automate this". */
  resourceName?: string;
  accountLifetime: ServerAccountScopeLifetime;
  onRequestClose: () => void;
}>;

/**
 * "Automate this…" (lab round 1116c host): the editor's own Sentence view on a new draft pre-filled from the
 * resource — When ⟨its event⟩, on ⟨Machine⟩ in ⟨folder⟩, "Add a first step" (none is preselected), "→ reports" once
 * there is a step — with the host's title naming the resource, "Saves as a workflow" (named from the sentence),
 * and a foot of Open in the editor (the same draft, every view) and Cancel/Save. Anchored on wide, the shared
 * sheet on a phone.
 */
export function WorkflowSentenceBuilder(
  props: WorkflowSentenceBuilderProps,
): React.ReactElement {
  return (
    <Popover
      open
      anchorRef={props.anchorRef}
      {...(props.clearanceRef === undefined ? {} : { clearanceRef: props.clearanceRef })}
      boundaryRef={null}
      placement="auto-vertical"
      phonePresentation="sheet"
      // The builder's own title is the one heading on a phone too (lab 1116c pop-v-*-390): no second header band.
      sheetHeader="none"
      sheetMaterial="solid"
      accessibilityLabel={builderTitle(props.resourceName)}
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
  const { blockIds } = useWorkflowEditorSelector(draftStore, readWorkflowBlockShape, sameRetainedValue);
  const name = useWorkflowEditorSelector(draftStore, readName);
  const step = blocks[0] ?? null;
  const [selectedBlockId, selectBlock] = React.useState<string | null>(null);
  const [customizingBlockId, customizeBlock] = React.useState<string | null>(null);
  const selectSentenceBlock = React.useCallback((blockId: string | null) => {
    customizeBlock(null);
    selectBlock(blockId);
  }, []);
  const machine = useServerScopedMachine(serverId, project?.machineId ?? null);
  const machines = useMachineListForServer(serverId, true) ?? undefined;
  const machineName = machine ? getMachineDisplayName(machine) : null;
  const host = useWorkflowAuthoringHost({ projectTarget: project, serverId });
  const readDraft = draftStore.get;
  const composerCustody = useWorkflowEditorComposerCustody({
    readDraft,
    draftId: readDraft().draftId,
    blockIds,
    scope: host.composerScope,
    editable: true,
    onChange,
    onSelect: selectSentenceBlock,
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
      startContext={sentence.startContext}
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
  const nameField = (
    <FieldTextInput
      testID={`${TEST_ID}-name`}
      value={name}
      onChangeText={(next) => onChange({ ...draftStore.get(), name: next })}
      accessibilityLabel={t('workflows.sentence.builder.savesAs')}
      placeholder={t('workflows.sentence.builder.namePlaceholder')}
    />
  );
  // On the sheet "Saves as" is one more labelled row, on the same label track as When and Machine.
  const savesAs = props.sheet ? renderWorkflowCardFieldRow('saves-as', t('workflows.sentence.builder.savesAs'), nameField) : (
    <View style={styles.name}>
      <Text style={styles.nameLabel}>{t('workflows.sentence.builder.savesAs')}</Text>
      <View style={styles.nameField}>{nameField}</View>
    </View>
  );
  const place = {
    target: project,
    machineName,
    ...(machines === undefined ? {} : { machines }),
    accountLifetime: lifetime,
    onChange: (target) => {
      if (isWorkflowProjectTarget(target)) sentence.changeProject(target);
    },
  } satisfies NonNullable<React.ComponentProps<typeof WorkflowInspector>['place']>;
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
              leading={<Icon name="arrow-square-out" size={ICON_SIZE.xs} />}
              testID={`${TEST_ID}-open-editor`}
              title={t('workflows.sentence.builder.openInEditor')}
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
        {/* The title names what is automated, on a phone's sheet too (lab round 1116c pop-v-*-390). */}
        <Text testID={`${TEST_ID}-title`} style={styles.title}>
          {builderTitle(props.resourceName)}
        </Text>
        <WorkflowSentenceRowsContext.Provider value={props.sheet}>
        <WorkflowDocumentGridContext.Provider value="compact">
          <WorkflowSentenceView
            draftStore={draftStore}
            onChange={onChange}
            documentEditable
            selectedBlockId={selectedBlockId}
            onSelectBlock={selectSentenceBlock}
            whenClause={whenClause}
            place={place}
            composerScope={host.composerScope}
            renderStepCard={(blockId) => customizingBlockId ? (
              <WorkflowInspector
                subject={{ kind: 'block', blockId: customizingBlockId }}
                presentation="popover"
                draft={draftStore.get()}
                onChange={onChange}
                documentEditable
                validation={validation}
                authoringFacts={host.authoringFacts}
                place={place}
                onDone={() => customizeBlock(null)}
                testIDPrefix={`${TEST_ID}-inspector`}
              />
            ) : (
              <WorkflowBlockListEditor
                draft={draftStore.get()}
                readDraft={readDraft}
                list={{ kind: 'root' }}
                blocks={blocks}
                depth={0}
                selectedBlockId={selectedBlockId ?? blockId}
                validation={validation}
                composerScope={host.composerScope}
                composerCustody={composerCustody}
                onChange={onChange}
                onSelect={selectSentenceBlock}
                onCustomize={customizeBlock}
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
        </WorkflowSentenceRowsContext.Provider>
        {savesAs}
      </View>
    </FloatingOverlay>
  );
}

/** The host names what it automates; without one the builder says "Automate this". */
function builderTitle(resourceName: string | undefined): string {
  return resourceName === undefined || resourceName.trim().length === 0
    ? t('workflows.sentence.builder.title')
    : t('workflows.sentence.builder.titleFor', { resource: resourceName });
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
    // The lab's hairline between the sentence and its actions (1116c pop-v).
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
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
    color: theme.colors.state.danger.textForeground,
    width: '100%',
  },
}));
