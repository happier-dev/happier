import * as React from 'react';
import { View } from 'react-native';

import { HappierChevron } from '../presentation/collection/DisclosureChevron.js';
import { Button, PluginUiButtonFillContext } from './Button.js';
import { Row } from './Layout.js';
import { Menu, type MenuGroup } from './Overlay.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

/**
 * How an agent action launches when its main face is pressed (owner ruling 2026-11-07, "Agent actions: one shared
 * flow"). `start` runs it in the background with the action's prompt, Profile, placement and checkout; `review` opens
 * the same New Session composer as Ask, prefilled, so the person edits and sends.
 */
export type AgentActionLaunchMode = 'start' | 'review';

export type AgentActionButtonProps = Readonly<{
  /** The action in the person's words ("Fix with Claude"). */
  title: string;
  titleKey?: string;
  /** The action's own name when `title` adds who it starts with; it names the chevron ("Fix options"). */
  actionName?: string;
  /** Why "Start now" cannot run this action (it names no task); the row stays, disabled, with this reason. */
  startUnavailableReason?: string;
  /** The action's configured launch mode, used by the main press. */
  launchMode: AgentActionLaunchMode;
  /** One launch, in the mode the person chose: the main press passes `launchMode`, the chevron the other one. */
  onLaunch(mode: AgentActionLaunchMode): void;
  /** Opens this action's record where it is edited. Without it the chevron offers no Edit row. */
  onEdit?: () => void;
  /** Where else the same action can go (a few recent Sessions), drawn after the launch choices. */
  groups?: readonly MenuGroup[];
  onSelectDestination?: (id: string) => void;
  /** Draw the groups' headings (default); a lone destination row can say what it does itself. */
  showGroupLabels?: boolean;
  /** The chevron's menu opened or closed, for a caller that reads its destinations only while it is open. */
  onMenuOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** A phone's band: the main face gives up width first and ends in "…". */
  compact?: boolean;
  /** `secondary` where the page already has a primary action (Deploy on an Environment); an action stays one control either way. */
  emphasis?: 'primary' | 'secondary';
}>;

const START_ID = 'agent-action:start';
const REVIEW_ID = 'agent-action:review';
const EDIT_ID = 'agent-action:edit';

/**
 * The one agent-action control: a split button whose face launches in the action's own mode and whose chevron offers
 * "Start now", "Add instructions…" and "Edit action…", then any destinations the caller adds. Triage, Deployments,
 * Workflow Runs, Projects and plugins draw this one control rather than their own split, so the words, the order and
 * the two launch modes cannot drift between features. It decides nothing about the launch itself: the caller's
 * owner resolves prompt, Profile, placement and checkout for the mode it is handed.
 */
export function AgentActionButton(
  props: AgentActionButtonProps,
): React.ReactElement {
  const text = usePluginTranslation();
  const theme = usePluginTheme();
  const [open, setOpen] = React.useState(false);
  const face = props.emphasis ?? 'primary';
  const { onMenuOpenChange } = props;
  const setMenuOpen = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onMenuOpenChange?.(next);
    },
    [onMenuOpenChange],
  );
  const optionsLabel = text(
    'happier.plugin-ui.agentAction.options',
    '{action} options',
    { action: props.actionName ?? props.title },
  );
  const items = [
    {
      id: START_ID,
      label: text('happier.plugin-ui.agentAction.startNow', 'Start now'),
      ...(props.startUnavailableReason === undefined
        ? {}
        : { disabled: true, subtitle: props.startUnavailableReason }),
    },
    {
      id: REVIEW_ID,
      label: text(
        'happier.plugin-ui.agentAction.addInstructions',
        'Add instructions…',
      ),
    },
    ...(props.onEdit === undefined
      ? []
      : [
          {
            id: EDIT_ID,
            label: text('happier.plugin-ui.agentAction.edit', 'Edit action…'),
          },
        ]),
  ];
  const select = (id: string) => {
    setMenuOpen(false);
    if (id === START_ID) props.onLaunch('start');
    else if (id === REVIEW_ID) props.onLaunch('review');
    else if (id === EDIT_ID) props.onEdit?.();
    else props.onSelectDestination?.(id);
  };
  const mainFace = (
      <Button
        {...(props.titleKey === undefined ? {} : { titleKey: props.titleKey })}
        title={props.title}
        variant={face}
        size="small"
        joinedEdge="end"
        {...(props.compact === true ? { singleLine: true } : {})}
        disabled={props.disabled === true}
        onPress={() => {
          props.onLaunch(props.launchMode);
        }}
      />
  );
  return (
    <Row
      align="center"
      style={props.compact === true ? COMPACT_SPLIT_STYLE : SPLIT_STYLE}
    >
      {props.compact === true ? (
        // A phone's split takes the width its column gives it (stacked controls read at one width); the face grows
        // and the chevron keeps its size. In a row that sizes it to its content this changes nothing.
        <View style={COMPACT_FACE_STYLE}>
          <PluginUiButtonFillContext.Provider value>{mainFace}</PluginUiButtonFillContext.Provider>
        </View>
      ) : mainFace}
      <Menu
        open={open}
        onOpenChange={setMenuOpen}
        trigger={optionsLabel}
        triggerAccessibilityLabel={optionsLabel}
        triggerAppearance={face === 'primary' ? 'primary' : 'control'}
        triggerSize="small"
        triggerJoinedEdge="start"
        triggerContent={
          <HappierChevron
            direction="down"
            size={12}
            color={face === 'primary' ? theme.colors.onAccent : theme.colors.text}
          />
        }
        disabled={props.disabled === true}
        sheet={{ title: optionsLabel }}
        items={items}
        {...(props.groups === undefined || props.groups.length === 0
          ? {}
          : { groups: props.groups, showGroupLabels: props.showGroupLabels ?? true })}
        onSelect={select}
      />
    </Row>
  );
}

/** A hairline of the page between the split's two presses. */
const SPLIT_STYLE = Object.freeze({ gap: 1 });
/** The compact face's box: it grows into room the split is given and gives it up first. */
const COMPACT_FACE_STYLE = Object.freeze({ flexGrow: 1, flexShrink: 1, minWidth: 0 });
/** On a phone the main face takes the row's room and gives it up first. */
const COMPACT_SPLIT_STYLE = Object.freeze({
  gap: 1,
  flexShrink: 1,
  minWidth: 0,
});
