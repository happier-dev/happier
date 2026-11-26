import { useCallback, useContext, useRef, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTheme } from '../../environment/context.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { happierPageTextMetrics } from '../layout/pageText.js';
import { HappierText } from '../text/Text.js';
import { HappierApprovalFactsRevealContext, type HappierFactsRevealTarget } from '../interaction/approvalFactsReveal.js';

/** One exact reference behind the readable page: what it is, then its value verbatim. */
export type HappierTechnicalDetailsLine = Readonly<{
  key: string;
  label: string;
  value: string;
}>;

export type HappierTechnicalDetailsContentProps = Readonly<{
  /** The fold's row title ("Technical details"), localized by the caller. */
  title: string;
  lines: readonly HappierTechnicalDetailsLine[];
  testID?: string;
}>;

/** How one line's label or value is drawn; absent, the environment theme draws them. */
export type HappierTechnicalDetailsTextRender = (
  input: Readonly<{
    role: 'label' | 'value';
    text: string;
  }>,
) => ReactNode;

/** The spacing step between lines; a same-realm host passes its density-scaled `s4`. */
export type HappierTechnicalDetailsSpace = Readonly<{ s4: number }>;

export const HAPPIER_TECHNICAL_DETAILS_METRICS = Object.freeze({
  /** A line's label sits right on its value. */
  labelGapPx: 1,
  space: Object.freeze({ s4: 4 }) satisfies HappierTechnicalDetailsSpace,
});

export type HappierTechnicalDetailsDisclosureProps =
  HappierTechnicalDetailsContentProps &
    Readonly<{
      /** The host's counted-disclosure row: it owns the fold, the header row and the reveal motion. */
      Disclosure: ComponentType<
        Readonly<{ title: string; testID?: string; children: ReactNode }>
      >;
      /** The inset the lines sit in (Happier core: its section content row); absent, the page row's. */
      Body?: ComponentType<Readonly<{ children: ReactNode }>>;
      renderText?: HappierTechnicalDetailsTextRender;
      space?: HappierTechnicalDetailsSpace;
    }>;

function PageRowBody(props: Readonly<{ children: ReactNode }>): ReactElement {
  return (
    <View
      style={{
        paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
        paddingTop: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx + 2,
        paddingBottom: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
      }}
    >
      {props.children}
    </View>
  );
}

function useDefaultTechnicalDetailsText(): HappierTechnicalDetailsTextRender {
  const theme = useOptionalHappierUiTheme();
  return (input) => (
    <HappierText
      selectable={input.role === 'value' ? true : undefined}
      style={[
        happierPageTextMetrics('rowDescription'),
        input.role === 'value' ? { minWidth: 0 } : null,
        theme === null
          ? null
          : input.role === 'value'
            ? {
                color: theme.colors.secondaryText,
                ...(theme.typography.code.fontFamily
                  ? { fontFamily: theme.typography.code.fontFamily }
                  : {}),
              }
            : { color: theme.colors.mutedText },
      ]}
    >
      {input.text}
    </HappierText>
  );
}

/**
 * The opened lines. They mount when the fold opens, so their first layout is the opening: inside a bounded approval
 * prompt they ask its scrolling facts to bring them into view (`HappierApprovalFactsRevealContext`).
 */
function TechnicalDetailsLines(props: Readonly<{
  lines: readonly HappierTechnicalDetailsLine[];
  renderText: HappierTechnicalDetailsTextRender;
  space: HappierTechnicalDetailsSpace;
  testID?: string;
}>): ReactElement {
  const reveal = useContext(HappierApprovalFactsRevealContext);
  const ref = useRef<View>(null);
  const revealed = useRef(false);
  const handleLayout = useCallback(() => {
    if (revealed.current || !reveal) return;
    revealed.current = true;
    reveal(ref.current as HappierFactsRevealTarget | null);
  }, [reveal]);
  return (
    <View ref={ref} testID={props.testID} style={{ gap: props.space.s4 }} onLayout={reveal ? handleLayout : undefined}>
      {props.lines.map((line) => (
        <View
          key={line.key}
          style={{ gap: HAPPIER_TECHNICAL_DETAILS_METRICS.labelGapPx }}
        >
          {props.renderText({ role: 'label', text: line.label })}
          {props.renderText({ role: 'value', text: line.value })}
        </View>
      ))}
    </View>
  );
}

/**
 * The one "Technical details" disclosure: exact identifiers and codes, one tap away from the readable
 * page. The readable outcome leads the page; its code and raw cause wait here as quiet reference lines
 * (a label, then its exact selectable value in mono). With no lines there is nothing to fold, so it
 * draws nothing. Happier core (approvals, Run steps) and plugin surfaces bind the same composition.
 */
export function HappierTechnicalDetailsDisclosure(
  props: HappierTechnicalDetailsDisclosureProps,
): ReactElement | null {
  const defaultRenderText = useDefaultTechnicalDetailsText();
  if (props.lines.length === 0) return null;
  const renderText = props.renderText ?? defaultRenderText;
  const space = props.space ?? HAPPIER_TECHNICAL_DETAILS_METRICS.space;
  const Disclosure = props.Disclosure;
  const Body = props.Body ?? PageRowBody;
  return (
    <Disclosure title={props.title} testID={props.testID}>
      <Body>
        <TechnicalDetailsLines lines={props.lines} renderText={renderText} space={space}
          testID={props.testID ? `${props.testID}.body` : undefined} />
      </Body>
    </Disclosure>
  );
}
