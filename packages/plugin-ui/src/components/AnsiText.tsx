import { useMemo, type ReactElement, type ReactNode } from 'react';

import { useOptionalHappierUiPalette } from '../environment/context.js';
import {
  tokenizeAnsiText,
  type AnsiTextStyle,
  type AnsiTextToken,
} from '../presentation/content/ansiTokens.js';
import type { FindTextRange } from '../presentation/find/findTypes.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import { HappierText } from '../presentation/text/Text.js';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import { usePluginTheme } from './PluginUiProvider.js';

export type AnsiTextProps = Readonly<{
  /** Raw terminal text. Ignored when `tokens` are given. */
  text?: string;
  /**
   * Already-tokenized text and its plain form (a log index keeps both per line), so a re-render never
   * tokenizes again. `plainText` is what selection, copy and Find ranges address.
   * Supply `plainText` on its own for a literal log message with no ANSI interpretation.
   */
  tokens?: readonly AnsiTextToken[];
  plainText?: string;
  /** Find's matches in `plainText`, half-open UTF-16 offsets; the current one draws on top. */
  ranges?: readonly FindTextRange[];
  /** Body for prose output; code (the default) for a terminal log. */
  variant?: 'code' | 'body';
  tone?: 'neutral' | 'secondary' | 'danger';
  selectable?: boolean;
  numberOfLines?: number;
  testID?: string;
}>;

/** The sixteen standard terminal colours, as the tokenizer names them, onto the theme's own inks. */
type ThemeInk = keyof PluginUiThemeV1['colors'];
const STANDARD_INK: Readonly<Record<string, ThemeInk>> = Object.freeze({
  '#000000': 'text',
  '#800000': 'danger',
  '#008000': 'success',
  '#808000': 'warning',
  '#000080': 'info',
  '#800080': 'accent',
  '#008080': 'info',
  '#c0c0c0': 'secondaryText',
  '#808080': 'mutedText',
  '#ff0000': 'danger',
  '#00ff00': 'success',
  '#ffff00': 'warning',
  '#0000ff': 'info',
  '#ff00ff': 'accent',
  '#00ffff': 'info',
  '#ffffff': 'text',
});

function ink(
  theme: PluginUiThemeV1,
  color: string | undefined,
): string | undefined {
  if (color === undefined) return undefined;
  const role = STANDARD_INK[color];
  // 256-colour and truecolor output keeps the colour the program asked for.
  return role === undefined ? color : theme.colors[role];
}

function styleOf(
  theme: PluginUiThemeV1,
  style: AnsiTextStyle,
): HappierPortableStyle | null {
  const foreground = ink(
    theme,
    style.inverse ? style.background : style.foreground,
  );
  const background = ink(
    theme,
    style.inverse ? (style.foreground ?? 'text') : style.background,
  );
  const decoration = style.underline
    ? style.strikethrough ? 'underline line-through' : 'underline'
    : style.strikethrough ? 'line-through' : undefined;
  const next: HappierPortableStyle = {
    ...(foreground === undefined ? {} : { color: foreground }),
    ...(background === undefined ? {} : { backgroundColor: background }),
    ...(style.bold ? { fontWeight: '600' } : {}),
    ...(style.italic ? { fontStyle: 'italic' } : {}),
    ...(style.dim ? { opacity: 0.7 } : {}),
    ...(decoration === undefined
      ? {}
      : { textDecorationLine: decoration }),
  };
  return Object.keys(next).length === 0 ? null : next;
}

/**
 * Terminal output as safe styled text (plan 02 §7): SGR colours and weights from the shared read-only tokenizer,
 * drawn in the theme's inks so a red error reads in light and dark. It never renders HTML, never follows OSC
 * effects and never emulates a terminal; what a reader selects or copies is the plain text. Find's matches mark
 * the plain-text offsets on top of the colours.
 */
export function AnsiText({
  text,
  tokens,
  plainText,
  ranges,
  variant = 'code',
  tone = 'neutral',
  selectable = true,
  numberOfLines,
  testID,
}: AnsiTextProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const tokenized = useMemo(
    () =>
      tokens !== undefined
        ? {
            tokens,
            plainText: plainText ?? tokens.map((token) => token.text).join(''),
          }
        : text === undefined && plainText !== undefined
          ? { plainText, tokens: [{ text: plainText, start: 0, end: plainText.length, style: {} }] }
          : tokenizeAnsiText(text ?? ''),
    [tokens, plainText, text],
  );
  const base = tokenized.tokens[0]?.start ?? 0;
  const marks = useMemo(
    () => ({
      all: { backgroundColor: palette?.findMatch ?? theme.colors.control },
      current: {
        backgroundColor: palette?.findMatchCurrent ?? theme.colors.accent,
        color: palette?.findMatchCurrentForeground ?? theme.colors.onAccent,
      },
    }),
    [palette, theme],
  );
  const children: ReactNode[] = [];
  for (const token of tokenized.tokens) {
    const style = styleOf(theme, token.style);
    const start = token.start - base;
    const end = token.end - base;
    const hits = (ranges ?? []).filter(
      (range) => range.end > start && range.start < end,
    );
    if (hits.length === 0) {
      children.push(
        style ? (
          <HappierText key={start} style={style}>
            {token.text}
          </HappierText>
        ) : (
          token.text
        ),
      );
      continue;
    }
    // Split the token at each match edge; the current match wins where matches overlap.
    const edges = new Set<number>([start, end]);
    for (const hit of hits) {
      edges.add(Math.max(start, hit.start));
      edges.add(Math.min(end, hit.end));
    }
    const points = [...edges].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      if (to <= from) continue;
      const covering = hits.filter((hit) => hit.start <= from && hit.end >= to);
      const mark =
        covering.length === 0
          ? null
          : covering.some((hit) => hit.current)
            ? marks.current
            : marks.all;
      const piece = token.text.slice(from - start, to - start);
      children.push(
        mark || style ? (
          <HappierText
            key={`${from}`}
            style={[style, mark]}
            {...(mark === marks.current
              ? { testID: 'find-match-current' }
              : {})}
          >
            {piece}
          </HappierText>
        ) : (
          piece
        ),
      );
    }
  }
  return (
    <HappierText
      variant={variant}
      tone={tone}
      selectable={selectable}
      {...(numberOfLines === undefined ? {} : { numberOfLines })}
      {...(testID === undefined ? {} : { testID })}
    >
      {children.length === 0 ? tokenized.plainText : children}
    </HappierText>
  );
}
