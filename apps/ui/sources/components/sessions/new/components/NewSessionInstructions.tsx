import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { NewSessionInstructionsCreationModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { AttachExistingMenu } from '@/components/sessions/work/instructions/SessionInstructionsSection';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import {
  promptStackEntryTitle,
  usePromptStackEntryPresentations,
} from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';

/** `creating` is the Create request in flight; `pending` is a document create waiting for approval. */
type CreateState = 'idle' | 'creating' | 'pending' | 'failed';

/** One primitive snapshot of the draft's Instructions, so the leaf re-renders on change, never on identity. */
function readInstructionsSnapshot(
  creation: NewSessionInstructionsCreationModel,
): string {
  const ref = creation.getEntry()?.ref;
  return JSON.stringify([
    ref?.serverId ?? null,
    ref?.artifactId ?? null,
    creation.getDraft() !== null,
    creation.getApprovalPending(),
  ]);
}

/** One key for the draft's Instructions chip, its popover slot and its rail placement. */
export const NEW_SESSION_INSTRUCTIONS_CHIP_KEY = 'new-session-instructions';

/** Lets the chip's menu hand the library picker to the chip, which outlives the menu that closes first. */
export type NewSessionInstructionsChipBridge = { openAttach?: () => void };

type InstructionsChipParams = Readonly<{
  creation: NewSessionInstructionsCreationModel;
  serverId: string;
  /** A New bot draft invites Instructions; other drafts only show ones they already carry. */
  invite: boolean;
  /** The draft's name, read at Create time: the new document is titled after it. */
  getName: () => string;
  bridge: NewSessionInstructionsChipBridge;
}>;

/** The draft's Instructions state, re-read whenever its store changes. */
function useInstructionsState(creation: NewSessionInstructionsCreationModel) {
  const subscribe = creation.subscribe;
  const snapshot = React.useCallback(() => readInstructionsSnapshot(creation), [creation]);
  React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const entry = creation.getEntry();
  return {
    entry,
    retained: entry === null && creation.getDraft() !== null,
    approvalPending: creation.getApprovalPending(),
  };
}

/**
 * Instructions before the first input (plan 60 §2, 61 I61-1; the same two choices as Work › Instructions,
 * lab `b-work S1`) are one composer chip (owner 2026-10-30): a New bot's header keeps its name and purpose,
 * and the Instructions ride the setup rail beside the model and mode they shape. The chip names the attached
 * document, or says Instructions; it opens a menu with Create instructions (a real Prompt Library document
 * through the draft's own Save, opened in its editor) and Attach existing, or Edit and Detach once one is
 * attached. Either way the draft carries the qualified reference into the spawn before the first input. A
 * Create that doesn't land keeps the authored draft (Send still creates it) and the chip and menu say so.
 * A New bot invites the choice; an ordinary draft shows the chip only while it carries Instructions.
 */
export function createNewSessionInstructionsChip(params: InstructionsChipParams): AgentInputExtraActionChip {
  const title = t('sessionInstructions.title');
  return {
    key: NEW_SESSION_INSTRUCTIONS_CHIP_KEY,
    controlId: 'shortcuts',
    // What the draft will start with is never tucked under +: shown whenever it is rendered.
    composerPreview: () => ({ absent: !params.invite && params.creation.getEntry() === null && params.creation.getDraft() === null }),
    placement: { id: `shortcuts:${NEW_SESSION_INSTRUCTIONS_CHIP_KEY}`, title, icon: 'file-text', defaultPlacement: 'pinned', pending: true },
    collapsedContentPopover: {
      title,
      label: title,
      icon: (tint: string) => normalizeNodeForView(<Icon name="file-text" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
      maxWidthCap: 320,
      renderContent: ({ requestClose }) => (
        <NewSessionInstructions
          creation={params.creation}
          serverId={params.serverId}
          getName={params.getName}
          onRequestClose={requestClose}
          onAttachRequest={() => params.bridge.openAttach?.()}
        />
      ),
    },
    render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle, chipAnchorRef, toggleCollapsedPopover }) => (
      <NewSessionInstructionsChip
        {...params}
        chipStyle={chipStyle}
        iconColor={iconColor}
        showLabel={showLabel}
        textStyle={textStyle}
        countTextStyle={countTextStyle}
        chipAnchorRef={chipAnchorRef}
        onPress={() => toggleCollapsedPopover?.(NEW_SESSION_INSTRUCTIONS_CHIP_KEY)}
      />
    ),
  };
}

const NewSessionInstructionsChip = React.memo(function NewSessionInstructionsChip(
  props: InstructionsChipParams & Readonly<{
    chipStyle: (pressed: boolean) => any;
    iconColor: string;
    showLabel: boolean;
    textStyle: any;
    countTextStyle: any;
    chipAnchorRef?: React.RefObject<any>;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { entry, retained, approvalPending } = useInstructionsState(props.creation);
  const [attachOpen, setAttachOpen] = React.useState(false);
  const { bridge } = props;
  React.useEffect(() => {
    bridge.openAttach = () => setAttachOpen(true);
    return () => { bridge.openAttach = undefined; };
  }, [bridge]);
  const localAnchor = React.useRef<View>(null);
  const anchorRef = props.chipAnchorRef ?? localAnchor;
  if (!entry && !retained && !props.invite) return null;
  // A Create that didn't land is the one state that needs the reader; it takes the warning glyph.
  const icon = retained && !approvalPending ? 'warning' : 'file-text';
  const iconColor = icon === 'warning' ? theme.colors.state.warning.foreground : props.iconColor;
  return (
    <>
      <AgentInputRailChip
        ref={anchorRef}
        testID="new-session-instructions-chip"
        accessibilityRole="button"
        accessibilityLabel={t('sessionInstructions.title')}
        onPress={() => {
          hapticsLight();
          props.onPress();
        }}
        style={props.chipStyle}
      >
        {normalizeNodeForView(<Icon name={icon} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
        {props.showLabel ? (
          entry
            ? <AttachedInstructionsTitle entry={entry} serverId={props.serverId} textStyle={props.textStyle} />
            : <AgentInputChipLabel label={t('sessionInstructions.title')} textStyle={props.textStyle} countTextStyle={props.countTextStyle} />
        ) : null}
      </AgentInputRailChip>
      {attachOpen ? (
        <AttachExistingMenu
          testID="new-session-instructions-attach-menu"
          anchorRef={anchorRef}
          serverId={props.serverId}
          onClose={() => setAttachOpen(false)}
          onAttach={(ref) => {
            setAttachOpen(false);
            props.creation.selectReference(ref);
          }}
        />
      ) : null}
    </>
  );
});

/** The attached document by its Prompt Library title, on the chip. */
function AttachedInstructionsTitle(props: Readonly<{ entry: PromptStackEntryV1; serverId: string; textStyle?: any }>) {
  const entries = React.useMemo(() => [props.entry], [props.entry]);
  const presentations = usePromptStackEntryPresentations(entries, props.serverId);
  return <AgentInputChipLabel label={promptStackEntryTitle(props.entry, presentations)} textStyle={props.textStyle} />;
}

/** The chip's menu: what the draft starts with, and the operations that change it. */
export const NewSessionInstructions = React.memo(
  function NewSessionInstructions(
    props: Readonly<{
      creation: NewSessionInstructionsCreationModel;
      serverId: string;
      getName: () => string;
      onRequestClose: () => void;
      onAttachRequest: () => void;
    }>,
  ) {
    const { creation, serverId, getName, onRequestClose } = props;
    const { theme } = useUnistyles();
    const router = useRouter();
    const { entry, retained, approvalPending } = useInstructionsState(creation);
    const [createState, setCreateState] = React.useState<CreateState>('idle');
    const mounted = React.useRef(true);
    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);

    const create = React.useCallback(async () => {
      setCreateState('creating');
      // A retry reuses the retained draft; a first Create starts an empty document under the draft's name.
      if (!creation.getDraft()) {
        creation.onDraftChange({
          title: getName().trim() || t('sessionInstructions.title'),
          markdown: '',
        });
      }
      // A thrown Save is a Create that didn't land: the retained draft and the failed line say so.
      const created = await creation.saveDraft().catch(() => null);
      if (!mounted.current) return;
      const ref = created?.createdRef ?? null;
      if (ref) {
        setCreateState('idle');
        const currentRef = creation.getEntry()?.ref;
        // A newer choice or authored body stays on screen, even though this document is reusable.
        if (creation.getDraft() !== null || currentRef?.artifactId !== ref.artifactId || currentRef.serverId !== ref.serverId) return;
        onRequestClose();
        router.push(
          promptCollectionItemHref('doc', ref.artifactId, {
            serverId: ref.serverId ?? serverId,
          }) as never,
        );
        return;
      }
      const awaitingApproval =
        created?.result.ok === true &&
        ActionApprovalRequestCreatedResultSchema.safeParse(
          created.result.result,
        ).success;
      setCreateState(creation.getDraft() === null ? 'idle' : awaitingApproval ? 'pending' : 'failed');
    }, [creation, getName, onRequestClose, router, serverId]);
    const edit = React.useCallback(() => {
      if (!entry) return;
      onRequestClose();
      router.push(
        promptCollectionItemHref('doc', entry.ref.artifactId, {
          serverId: entry.ref.serverId ?? serverId,
        }) as never,
      );
    }, [entry, onRequestClose, router, serverId]);
    const detach = React.useCallback(() => {
      setCreateState('idle');
      creation.selectReference(null);
      onRequestClose();
    }, [creation, onRequestClose]);
    const attach = React.useCallback(() => {
      setCreateState('idle');
      onRequestClose();
      props.onAttachRequest();
    }, [onRequestClose, props]);

    const failed = createState === 'failed' || (createState === 'idle' && retained);
    const tint = theme.colors.text.secondary;
    const menuIcon = (name: 'file-plus' | 'files' | 'pencil-simple' | 'x') => <Icon name={name} size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />;
    const actions: ActionListItem[] = entry
      ? [
        { id: 'edit', testID: 'new-session-instructions-edit', label: t('sessionInstructions.edit'), icon: menuIcon('pencil-simple'), onPress: edit },
        { id: 'attach', testID: 'new-session-instructions-attach', label: t('sessionInstructions.attach'), icon: menuIcon('files'), onPress: attach },
        { id: 'detach', testID: 'new-session-instructions-detach', label: t('sessionInstructions.detach'), icon: menuIcon('x'), onPress: detach },
      ]
      : [
        { id: 'create', testID: 'new-session-instructions-create', label: t('sessionInstructions.create'), icon: menuIcon('file-plus'), onPress: create, disabled: createState === 'creating' },
        { id: 'attach', testID: 'new-session-instructions-attach', label: t('sessionInstructions.attach'), icon: menuIcon('files'), onPress: attach },
      ];
    return (
      <View testID="new-session-instructions">
        {createState === 'pending' || approvalPending ? (
          <View style={stylesheet.status}>
            <SurfaceFreshnessLine
              testID="new-session-instructions.pending"
              busy
              reason={t('sessionInstructions.savePending')}
            />
          </View>
        ) : failed ? (
          <View style={stylesheet.status}>
            <SurfaceFreshnessLine
              testID="new-session-instructions.failed"
              tone="warning"
              reason={t('bots.create.documentFailed')}
            />
          </View>
        ) : null}
        <ActionListSection actions={actions} />
      </View>
    );
  },
);

const stylesheet = StyleSheet.create((theme) => ({
  // The one cause, above the operations that repair it, on the menu rows' text edge.
  status: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
  },
}));
