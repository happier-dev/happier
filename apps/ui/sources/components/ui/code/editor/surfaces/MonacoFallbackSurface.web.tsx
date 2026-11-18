import React from 'react';
import { View } from 'react-native';

import { Text, TextInput } from '@/components/ui/text/Text';
import {
  CODE_GUTTER_METRICS,
  resolveCodeEditorGutterMetrics,
  type CodeEditorFontMetrics,
} from '../codeEditorFontMetrics';
import { resolveCodeMonoFontFamily } from '../../codeTypography';
import type { CodeEditorTheme } from '../editorTheme';

const FILL = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  overflow: 'hidden',
} as const;

const digitWidths = new Map<string, number>();

/** One digit's width in the number font, measured once per font (a digit of the font, never a ratio). */
function measureDigitWidth(fontFamily: string, fontSize: number): number {
  if (typeof document === 'undefined' || !document.body) return 0;
  const key = `${fontSize}px ${fontFamily}`;
  const known = digitWidths.get(key);
  if (known !== undefined) return known;
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:"${fontFamily}",monospace;font-size:${fontSize}px`;
  probe.textContent = '0000000000';
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  digitWidths.set(key, width);
  return width;
}

/**
 * The editor until Monaco mounts, and for good if it cannot boot. A cold page fetches and evaluates Monaco's bundle
 * after the editor first renders (2-4 s in a fresh headless page), so this draws the same text on Monaco's own
 * gutter, numbers and inset (`alignGutter`): when Monaco arrives nothing moves. The numbers follow the text's scroll.
 */
export function MonacoFallbackSurface(
  props: Readonly<{
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
    theme: CodeEditorTheme;
    fontMetrics: CodeEditorFontMetrics;
    insetLeft: number;
    paddingVertical: number;
    showLineNumbers: boolean;
    lineNumberDigits: number;
    reviewLaneWidth: number;
    /** A canvas document with no numbers: its source starts on the page's text edge. */
    bare: boolean;
  }>,
) {
  const fontFamily = resolveCodeMonoFontFamily();
  const { fontSize, lineHeight, lineNumberFontSize } = props.fontMetrics;
  const lineCount = props.value.split(/\r\n|\r|\n/).length;
  const digits = Math.max(props.lineNumberDigits, String(lineCount).length);
  const digitWidth = React.useMemo(
    () => measureDigitWidth(fontFamily, lineNumberFontSize),
    [fontFamily, lineNumberFontSize],
  );
  const showNumbers = props.showLineNumbers && !props.bare;
  const gutter = props.bare
    ? { textOffset: 0 }
    : resolveCodeEditorGutterMetrics({
        lineNumberDigits: digits,
        digitWidth,
        showLineNumbers: props.showLineNumbers,
        reviewLaneWidth: props.reviewLaneWidth,
      });
  const textOffset = props.insetLeft + gutter.textOffset;
  const numbers = React.useMemo(
    () =>
      showNumbers
        ? Array.from({ length: lineCount }, (_, index) => index + 1).join('\n')
        : '',
    [lineCount, showNumbers],
  );
  const numbersRef = React.useRef<View | null>(null);
  const followScroll = React.useCallback(
    (event: { currentTarget?: unknown }) => {
      const scrollTop =
        (event.currentTarget as { scrollTop?: number } | undefined)
          ?.scrollTop ?? 0;
      const node = numbersRef.current as unknown as HTMLElement | null;
      if (node?.style) node.style.transform = `translateY(${-scrollTop}px)`;
    },
    [],
  );

  return (
    <View style={[FILL, { backgroundColor: props.theme.backgroundColor }]}>
      {showNumbers ? (
        <View
          ref={numbersRef}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            top: props.paddingVertical,
            width: textOffset - CODE_GUTTER_METRICS.numberPaddingRight,
          }}
        >
          <Text
            disableUiFontScaling
            accessible={false}
            style={{
              fontFamily,
              fontSize: lineNumberFontSize,
              lineHeight,
              textAlign: 'right',
              fontVariant: ['tabular-nums'],
              color: props.theme.lineNumberColor,
            }}
          >
            {numbers}
          </Text>
        </View>
      ) : null}
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        editable={props.editable}
        multiline
        disableUiFontScaling
        onScroll={followScroll as never}
        style={{
          flex: 1,
          paddingLeft: textOffset,
          paddingRight: 0,
          paddingTop: props.paddingVertical,
          paddingBottom: props.paddingVertical,
          color: props.theme.syntax.defaultColor,
          backgroundColor: 'transparent',
          fontFamily,
          fontSize,
          lineHeight,
        }}
      />
    </View>
  );
}
