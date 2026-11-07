import * as React from 'react';
import { Item, Row, Stack, Text, type TextTone } from '@happier-dev/plugin-ui';

type TriageStatusRowContent = Readonly<{
  name: string;
  /** Already localized by the source that owns the state vocabulary. */
  status?: string | undefined;
  tone?: TextTone;
}>;

/** The same source status fact, in a cockpit, story summary, or full checks list. */
export type TriageStatusRowProps = TriageStatusRowContent & (
  | Readonly<{ presentation: 'compact'; leading?: React.ReactNode; grow?: boolean }>
  | Readonly<{ presentation: 'summary'; nameVariant?: 'label' | 'micro'; nameTone?: TextTone }>
  | (Readonly<{
    presentation: 'list';
    detail?: string;
    /**
     * The row opens in place (the shared row disclosure): what the source knows about this status — its summary,
     * its log excerpt, where to read the rest. The row's press toggles it.
     */
    expandedContent?: React.ReactNode;
    expanded?: boolean;
    /**
     * Without `expandedContent`, the press opens the status's own detail (a CI check's run), so the row reads as
     * a navigation row instead of a disclosure.
     */
    onPress?: () => void;
  }> & (
    /** Row-level actions live in the row's quiet overflow, never as buttons beside every row. */
    | Readonly<{
      secondaryActions: readonly Readonly<{ id: string; label: string }>[];
      onSecondaryAction: (id: string) => void;
    }>
    | Readonly<{ secondaryActions?: undefined; onSecondaryAction?: undefined }>
  ))
);

/** Presentation only: no check filtering, review decision, merge policy, or read lifecycle. */
export function TriageStatusRow(props: TriageStatusRowProps): React.ReactElement {
  if (props.presentation === 'list') {
    // As in the compact and summary forms, the state word carries the tone and the name stays ink: the
    // status is the row's trailing fact (one scannable column, rose only where a check failed) and the
    // time it was read sits under the name.
    return <Item title={props.name}
      {...(props.status === undefined ? {} : { detail: props.status })}
      {...(props.status === undefined || props.tone === undefined || props.tone === 'neutral' ? {} : { detailTone: props.tone })}
      {...(props.detail === undefined ? {} : props.status === undefined ? { detail: props.detail } : { subtitle: props.detail })}
      {...(props.secondaryActions === undefined
        ? { secondaryActions: undefined, onSecondaryAction: undefined }
        : { secondaryActions: props.secondaryActions, onSecondaryAction: props.onSecondaryAction })}
      {...(props.expandedContent === undefined
        ? props.onPress === undefined ? {} : { onPress: props.onPress }
        : {
          expandedContent: props.expandedContent,
          expanded: props.expanded === true,
          ...(props.onPress === undefined ? {} : { onPress: props.onPress }),
        })} />;
  }
  if (props.presentation === 'summary') {
    const name = <Text variant={props.nameVariant ?? 'label'} tone={props.nameTone ?? 'neutral'} value={props.name} />;
    if (props.status === undefined) return name;
    return <Stack gap="none">
      {name}
      <Text variant="micro" tone={props.tone ?? 'secondary'} value={props.status} />
    </Stack>;
  }
  const name = <Text variant="micro" value={props.name} />;
  return <Row gap="xsmall" align="center">
    {props.leading}
    {props.grow ? <Stack grow>{name}</Stack> : name}
    {props.status === undefined ? null : <Text variant="micro" tone={props.tone ?? 'neutral'} value={props.status} />}
  </Row>;
}
