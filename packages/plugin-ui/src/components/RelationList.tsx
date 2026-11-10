import { useState, type ReactElement } from 'react';
import { View } from 'react-native';

import { IconButton } from './Button.js';
import { Icon } from './Icon.js';
import { Row, Stack } from './Layout.js';
import { Item, ItemGroup } from './List.js';
import { Menu } from './Overlay.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { propertyChoiceMenuItem, type PropertyChoice } from './PropertyList.js';
import { TaskStatusGlyph, type TaskStatusCategory } from './TaskStatusGlyph.js';
import { Text } from './Text.js';

/** One related thing: its status, short designation and title, and what can be done with it here. */
export type RelationListEntry = Readonly<{
  /** Stable within the list. */
  id: string;
  title: string;
  /** The related thing's short native designation ("CHK-214", "#2470"); presentation only. */
  designation?: string;
  /** Its task status category, drawn as the shared status glyph. */
  status?: TaskStatusCategory;
  /** One quiet trailing fact ("Ready to merge", "Codex"). */
  detail?: string;
  /** Opens the related thing. */
  onOpen?(): void;
  /** Removes this relation; one deliberate write. */
  onRemove?(): unknown;
}>;

export type RelationListProps = Readonly<{
  /**
   * Sentence-case title of the relation ("Blocked by", "Sub-tasks"). Omit it where an enclosing step or chapter
   * already names the relation (a detail's numbered story); `accessibilityLabel` then names the list, and the add
   * control follows the rows instead of sitting beside a title.
   */
  title?: string;
  /** The list's accessible name when it has no visible `title`. */
  accessibilityLabel?: string;
  entries: readonly RelationListEntry[];
  /**
   * What the source says about the whole relation ("3 of 5 done", "1 open"). Only facts the source read: when the
   * relation was not read, leave the list out instead of saying "None".
   */
  summary?: string;
  /** The relation holds more than these rows (a bounded read); said once beneath them. */
  more?: string;
  /** Shown when the source read the relation and it is empty. */
  emptyLabel?: string;
  /** Adds one relation from the given choices ("Add a blocker"). */
  add?: Readonly<{
    label: string;
    choices: readonly PropertyChoice[];
    onAdd(id: string): unknown;
  }>;
  /** Holds the add and remove controls while a write is in flight. */
  disabled?: boolean;
  testID?: string;
}>;

/**
 * A relation of one thing to others (its parent, what blocks it, its sub-tasks) as one titled section: each row is
 * the related thing's status glyph, designation and title, the section says the source's completeness, and an
 * optional add opens a picker. Rows are what the source read; an unread relation is absent, never "none".
 */
export function RelationList(props: RelationListProps): ReactElement {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const add = props.add;
  const action =
    add === undefined ? undefined : (
      <Menu
        open={adding && props.disabled !== true}
        onOpenChange={(open) => { setQuery(''); setAdding(open && props.disabled !== true); }}
        disabled={props.disabled === true || add.choices.length === 0}
        trigger={add.label}
        triggerContent={
          <Row gap="small" align="center">
            <Icon name="add" size="small" tone="secondary" />
            <Text variant="meta" tone="secondary" value={add.label} />
          </Row>
        }
        triggerAccessibilityLabel={add.label}
        sheet={{ title: add.label }}
        items={add.choices.map(propertyChoiceMenuItem)}
        // The same picker as the Parent and Blocked by values: find an entry by its title or designation.
        search={{ value: query, onValueChange: setQuery }}
        onSelect={(id) => {
          void add.onAdd(id);
        }}
        {...(props.testID === undefined
          ? {}
          : { testID: `${props.testID}.add` })}
      />
    );
  const removeLabel = translate(
    'happier.plugin-ui.relationList.remove',
    'Remove',
  );
  const titled = props.title !== undefined;
  const group = (
    <ItemGroup
      {...(titled ? { title: props.title } : {})}
      {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
      {...(props.summary === undefined || !titled ? {} : { description: props.summary })}
      {...(action === undefined || !titled ? {} : { action })}
    >
      {props.entries.length === 0 && props.emptyLabel !== undefined ? (
        <Item
          title={props.emptyLabel}
          {...(props.testID === undefined
            ? {}
            : { testID: `${props.testID}.empty` })}
        />
      ) : null}
      {props.entries.map((entry) => (
        <Item
          key={entry.id}
          title={entry.title}
          {...(entry.designation === undefined
            ? {}
            : { subtitle: entry.designation })}
          {...(entry.detail === undefined ? {} : { detail: entry.detail })}
          {...(entry.status === undefined
            ? {}
            : { icon: <TaskStatusGlyph category={entry.status} /> })}
          {...(entry.onOpen === undefined ? {} : { onPress: entry.onOpen })}
          {...(entry.onRemove === undefined
            ? {}
            : {
                accessoryOutsidePressable: true,
                accessory: (
                  <IconButton
                    icon={<Icon name="close" size="small" />}
                    disabled={props.disabled === true}
                    accessibilityLabel={`${removeLabel}, ${entry.title}`}
                    onPress={() => {
                      void entry.onRemove?.();
                    }}
                    {...(props.testID === undefined
                      ? {}
                      : { testID: `${props.testID}.${entry.id}.remove` })}
                  />
                ),
              })}
          {...(props.testID === undefined
            ? {}
            : { testID: `${props.testID}.${entry.id}` })}
        />
      ))}
      {props.more === undefined ? null : <Item title={props.more} />}
      {titled || action === undefined ? null : (
        <View style={{ paddingHorizontal: theme.spacing.medium, paddingVertical: theme.spacing.small, alignItems: 'flex-start' }}>{action}</View>
      )}
    </ItemGroup>
  );
  if (titled || action === undefined) return group;
  // Under a chapter that names the relation the add is the sheet's last row (lab `tasks-detail`: "+ Add a blocker").
  return <View testID={props.testID === undefined ? undefined : `${props.testID}.sheet`}>{group}</View>;
}
