import type { ComponentType, ReactElement } from 'react';
import { View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import type { HappierStyleProp } from '../portableTypes.js';

/** The glyph a line leads with; the caller draws each in its own icon family. */
export type HappierDocEditProposalMark =
  | 'proposal'
  | 'reason'
  | 'current'
  | 'accepted'
  | 'declined'
  | 'undone'
  | 'warning'
  | 'failed'
  | 'locked';

export type HappierDocEditProposalTone =
  | 'neutral'
  | 'muted'
  | 'warning'
  | 'danger';

export type HappierDocEditProposalAction = Readonly<{
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}>;

/** One status or receipt line: a mark, what happened, and at most one way forward. */
export type HappierDocEditProposalLine = Readonly<{
  testID?: string;
  mark: HappierDocEditProposalMark;
  tone?: HappierDocEditProposalTone;
  text: string;
  action?: HappierDocEditProposalAction;
}>;

/** What the suggestion's foot offers while it is still open. */
export type HappierDocEditProposalFooter =
  /** The suggestion can apply: its currency (or progress) beside Decline and Accept. */
  | Readonly<{
      kind: 'decide';
      status?: Readonly<{
        text: string;
        testID?: string;
        indicator?: 'busy' | 'current';
      }>;
      decline?: HappierDocEditProposalAction;
      accept?: HappierDocEditProposalAction;
    }>
  /** The Doc moved on since the suggestion was made: say so, then compare, decline or ask again. */
  | Readonly<{
      kind: 'stale';
      line: HappierDocEditProposalLine;
      compare?: HappierDocEditProposalAction;
      decline?: HappierDocEditProposalAction;
      askRedo?: HappierDocEditProposalAction;
    }>
  /** Only a note (the reader cannot edit this Doc). */
  | Readonly<{ kind: 'note'; line: HappierDocEditProposalLine }>;

export type HappierDocEditProposalState =
  | Readonly<{
      state: 'open';
      title: string;
      /**
       * Caller-worded base version ("Based on v14"), beside the title. Omit it when the footer already
       * states the version, so one card says it once.
       */
      basedOn?: string;
      /** A short caller-owned explanation of the scope shown in the diff. */
      note?: string;
      reason?: string;
      footer: HappierDocEditProposalFooter;
    }>
  /** A decided suggestion folds into its receipt, with any follow-up lines (Undo's outcome). */
  | Readonly<{
      state: 'settled';
      receipt: HappierDocEditProposalLine;
      lines?: readonly HappierDocEditProposalLine[];
    }>;

export type HappierDocEditProposalTextProps = Readonly<{
  role: 'title' | 'meta' | 'reason' | 'line' | 'receipt';
  tone?: HappierDocEditProposalTone;
  numberOfLines?: number;
  testID?: string;
  children: string;
}>;

export type HappierDocEditProposalButtonProps = HappierDocEditProposalAction &
  Readonly<{
    /** `plain`: a line's own way forward (Undo, Open history), quieter than the decision buttons. */
    emphasis: 'primary' | 'secondary' | 'plain';
  }>;

export type HappierDocEditProposalMarkProps = Readonly<{
  mark: HappierDocEditProposalMark;
  tone: HappierDocEditProposalTone;
}>;

export type HappierDocEditProposalDiffProps = Readonly<{
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  testID?: string;
}>;

export type HappierDocEditProposalProps = Readonly<{
  testID: string;
  /** The reviewed passage; drawn only while the suggestion is open. */
  before: string;
  after: string;
  labels: Readonly<{ before: string; after: string }>;
  decision: HappierDocEditProposalState;
  Text: ComponentType<HappierDocEditProposalTextProps>;
  Mark: ComponentType<HappierDocEditProposalMarkProps>;
  Button: ComponentType<HappierDocEditProposalButtonProps>;
  /** The before/after through the caller's prose diff owner. */
  Diff: ComponentType<HappierDocEditProposalDiffProps>;
  Spinner: ComponentType<Record<string, never>>;
  /** The card's ground (fill, radius, edge) in the caller's material. */
  style?: HappierStyleProp;
  space?: Readonly<Record<'s6' | 's8' | 's10' | 's12', number>>;
}>;

/** The room a status sentence keeps before its action wraps beneath it. */
const STATUS_TEXT_BASIS = 160;

/**
 * A suggested edit to a Doc passage: the before/after, why it was suggested, the version it is based
 * on, and the decision buttons for the person reading it. Shared by core and plugins. Everything here
 * is caller-owned data and callbacks; whether a decision is allowed, and applying it, stay with the
 * caller's Actions (accepting and declining remain the person's decision).
 */
export function HappierDocEditProposal(
  props: HappierDocEditProposalProps,
): ReactElement {
  const { Text, Mark, Button, Diff, Spinner, decision } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const id = (part: string) => `${props.testID}.${part}`;
  const row = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
  } as const;
  // In a narrow margin the base version drops under the title rather than breaking the title's words.
  const head = {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    columnGap: space.s8,
  } as const;
  const foot = {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.s8,
  } as const;
  // Decline and Accept stay at the end of the foot, also when a narrow margin wraps them under the status.
  const buttons = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    marginLeft: 'auto',
  } as const;
  const line = (value: HappierDocEditProposalLine, strong = false) => {
    // A receipt keeps its action at the end of its line (the text wraps inside itself); a status line's
    // action drops beneath its sentence when the margin is too narrow for both.
    const wraps = !strong && value.action !== undefined;
    return (
    <View
      key={value.testID ?? value.text}
      testID={value.testID}
      style={wraps ? { ...row, flexWrap: 'wrap' } : row}
      accessibilityLiveRegion="polite"
    >
      <Mark mark={value.mark} tone={value.tone ?? 'neutral'} />
      <View style={wraps ? { flexGrow: 1, flexShrink: 1, flexBasis: STATUS_TEXT_BASIS, minWidth: 0 } : { flex: 1, minWidth: 0 }}>
        <Text role={strong ? 'receipt' : 'line'} tone={value.tone ?? 'neutral'}>
          {value.text}
        </Text>
      </View>
      {value.action ? <Button {...value.action} emphasis="plain" /> : null}
    </View>
    );
  };
  const card = [{ gap: space.s10 }, props.style];

  if (decision.state === 'settled') {
    return (
      <View testID={props.testID} style={card}>
        {line(decision.receipt, true)}
        {decision.lines?.map((value) => line(value))}
      </View>
    );
  }

  const { footer } = decision;
  const reason = decision.reason?.trim();
  return (
    <View testID={props.testID} style={card}>
      <View style={head}>
        <View style={{ ...row, flexShrink: 1, minWidth: 0 }}>
          <Mark mark="proposal" tone="neutral" />
          <View style={{ flexShrink: 1, minWidth: 0 }}>
            <Text role="title">{decision.title}</Text>
          </View>
        </View>
        {decision.basedOn ? <Text role="meta">{decision.basedOn}</Text> : null}
      </View>
      <Diff
        testID={id('diff')}
        before={props.before}
        after={props.after}
        beforeLabel={props.labels.before}
        afterLabel={props.labels.after}
      />
      {decision.note ? <Text role="meta" testID={id('note')}>{decision.note}</Text> : null}
      {reason ? (
        <View style={{ ...row, alignItems: 'flex-start' }}>
          <Mark mark="reason" tone="muted" />
          <View style={{ flex: 1 }}>
            <Text role="reason">{reason}</Text>
          </View>
        </View>
      ) : null}
      {footer.kind === 'note' ? line(footer.line) : null}
      {footer.kind === 'stale' ? (
        <>
          {line(footer.line)}
          <View style={foot}>
            {footer.compare ? (
              <Button {...footer.compare} emphasis="secondary" />
            ) : null}
            <View style={{ flex: 1 }} />
            <View style={buttons}>
              {footer.decline ? (
                <Button {...footer.decline} emphasis="secondary" />
              ) : null}
              {footer.askRedo ? (
                <Button {...footer.askRedo} emphasis="primary" />
              ) : null}
            </View>
          </View>
        </>
      ) : null}
      {footer.kind === 'decide' ? (
        <View style={foot}>
          <View
            style={{ ...row, flex: 1, minWidth: 160 }}
            accessibilityLiveRegion="polite"
          >
            {footer.status?.indicator === 'busy' ? (
              <Spinner />
            ) : footer.status?.indicator === 'current' ? (
              <Mark mark="current" tone="muted" />
            ) : null}
            <Text role="meta" testID={footer.status?.testID} numberOfLines={2}>
              {footer.status?.text ?? ''}
            </Text>
          </View>
          {footer.decline || footer.accept ? (
            <View style={buttons}>
              {footer.decline ? (
                <Button {...footer.decline} emphasis="secondary" />
              ) : null}
              {footer.accept ? (
                <Button {...footer.accept} emphasis="primary" />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
