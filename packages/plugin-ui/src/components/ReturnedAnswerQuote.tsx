import type { ReactElement, ReactNode } from 'react';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import {
  HappierReturnedAnswerQuote,
  type HappierReturnedAnswerOutcome,
  type HappierReturnedAnswerQuestion,
  type HappierReturnedAnswerQuoteActionProps,
  type HappierReturnedAnswerQuoteTextProps,
} from '../presentation/content/ReturnedAnswerQuote.js';
import { HappierTextLinkButton } from '../presentation/interaction/TextLinkButton.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { Icon } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type ReturnedAnswerOutcome = HappierReturnedAnswerOutcome;
export type ReturnedAnswerQuestion = HappierReturnedAnswerQuestion;

export type ReturnedAnswerQuoteProps = Readonly<{
  testID?: string;
  /** The answering session's name. */
  answerer: string;
  outcome: ReturnedAnswerOutcome;
  /** The answer's content. */
  children?: ReactNode;
  onOpenAnswerer?: () => void;
  /** Offer "Your question" when the author can read the exact question; the author owns the read. */
  question?: Readonly<{ open: boolean; onToggle: () => void; state: ReturnedAnswerQuestion }>;
}>;

const KEY = 'happier.plugin-ui.returnedAnswer';

/** An answer another session returned to an Ask, the same quote core draws; reads and routing stay with the author. */
export function ReturnedAnswerQuote(props: ReturnedAnswerQuoteProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  return <HappierReturnedAnswerQuote {...props} Text={QuoteText} Action={QuoteAction}
    collapse={{
      lineHeight: theme.typography.reading.lineHeight,
      showMore: translate(`${KEY}.showMore`, 'Show more'),
      showLess: translate(`${KEY}.showLess`, 'Show less'),
    }}
    informationMark={<Icon name="info" size="small" tone="secondary" />}
    colors={{ text: theme.colors.text, secondaryText: theme.colors.secondaryText, danger: theme.statusText?.danger ?? theme.colors.danger, border: theme.colors.divider, surface: theme.colors.surface }}
    labels={{
      outcome: {
        answer: translate(`${KEY}.outcome.answer`, 'answered'),
        pass: translate(`${KEY}.outcome.pass`, 'passed'),
        failed: translate(`${KEY}.outcome.failed`, 'couldn’t answer'),
        cancelled: translate(`${KEY}.outcome.cancelled`, 'cancelled'),
        terminal_no_result: translate(`${KEY}.outcome.terminal_no_result`, 'ended without an answer'),
      },
      open: translate(`${KEY}.open`, 'Open'),
      information: translate(`${KEY}.information`, 'Returned as information. It isn’t asked to reply again.'),
      yourQuestion: translate(`${KEY}.yourQuestion`, 'Your question'),
      loading: translate('happier.plugin-ui.state.loading', 'Loading…'),
      askedFromHere: translate(`${KEY}.askedFromHere`, 'Asked from here'),
      openQuestion: translate(`${KEY}.openQuestion`, 'Open question'),
      questionUnavailable: translate(`${KEY}.questionUnavailable`, 'Couldn’t load the question'),
      retry: translate('happier.plugin-ui.state.retry', 'Retry'),
    }} />;
}

function QuoteText(props: HappierReturnedAnswerQuoteTextProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  return <HappierText testID={props.testID} numberOfLines={props.numberOfLines} style={[
    resolveHappierTypeRoleStyle('meta', theme, typography, props.role === 'answerer' ? 'semiBold' : undefined),
    { color: props.color },
  ]}>{props.children}</HappierText>;
}

function QuoteAction(props: HappierReturnedAnswerQuoteActionProps): ReactNode {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const meta = resolveHappierTypeRoleStyle('meta', theme, typography, 'semiBold');
  return <HappierTextLinkButton {...props} Text={HappierText}
    labelStyle={{ ...meta, lineHeight: meta.lineHeight ?? 16, color: theme.colors.secondaryText }}
    hoverColor={theme.colors.text} focusColor={theme.colors.focus} />;
}
