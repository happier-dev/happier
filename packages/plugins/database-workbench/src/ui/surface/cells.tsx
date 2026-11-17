import * as React from 'react';
import type { DatabaseCellV1 } from '@happier-dev/database-protocol';
import { Text, type PluginTranslate } from '@happier-dev/plugin-ui';

type CellPresentation = Readonly<{
  text: string;
  tone: 'neutral' | 'muted';
  code: boolean;
  incomplete: boolean;
}>;

const integerFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

function byteCount(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * One reading of a cell: NULL, an empty string, binary and a cut value never look alike.
 * The text is a display projection only; the cell itself stays the staged/compared value.
 */
export function presentCell(
  cell: DatabaseCellV1 | undefined,
  translate: PluginTranslate,
  /** A key or a reference names a row: its digits are an identity, never a grouped quantity (48212, not 48,212). */
  options?: Readonly<{ identifier?: boolean }>,
): CellPresentation {
  if (!cell) return { text: '', tone: 'muted', code: false, incomplete: false };
  switch (cell.type) {
    case 'null':
      return { text: 'NULL', tone: 'muted', code: true, incomplete: false };
    case 'text':
      return cell.value.length === 0
        ? {
            text: translate('plugins.database.cell.empty', 'empty'),
            tone: 'muted',
            code: false,
            incomplete: false,
          }
        : { text: cell.value, tone: 'neutral', code: false, incomplete: false };
    case 'boolean':
      return {
        text: cell.value ? 'true' : 'false',
        tone: 'neutral',
        code: false,
        incomplete: false,
      };
    case 'integer': {
      // Grouping only where the value is a safe integer; larger values keep the engine's digits.
      const safe = Number(cell.value);
      const text = Number.isSafeInteger(safe) && options?.identifier !== true
        ? integerFormat.format(safe)
        : cell.value;
      return { text, tone: 'neutral', code: false, incomplete: false };
    }
    case 'decimal':
      return {
        text: cell.value,
        tone: 'neutral',
        code: false,
        incomplete: false,
      };
    case 'float':
      return {
        text: String(cell.value),
        tone: 'neutral',
        code: false,
        incomplete: false,
      };
    case 'json':
      return {
        text: cell.value,
        tone: 'neutral',
        code: true,
        incomplete: false,
      };
    case 'temporal':
      return {
        text: cell.value,
        tone: 'neutral',
        code: false,
        incomplete: false,
      };
    case 'binary':
      return {
        text: translate('plugins.database.cell.bytes', '{count} bytes', {
          count: integerFormat.format(byteCount(cell.value)),
        }),
        tone: 'muted',
        code: false,
        incomplete: false,
      };
    case 'partial': {
      const total = cell.range.total;
      if (cell.valueType === 'binary')
        return {
          text: translate('plugins.database.cell.bytes', '{count} bytes', {
            count: integerFormat.format(total ?? byteCount(cell.value)),
          }),
          tone: 'muted',
          code: false,
          incomplete: true,
        };
      return {
        text: cell.value,
        tone: 'neutral',
        code: cell.valueType === 'json',
        incomplete: true,
      };
    }
  }
}

export function CellText(
  props: Readonly<{
    cell: DatabaseCellV1 | undefined;
    translate: PluginTranslate;
    numberOfLines?: number;
    identifier?: boolean;
  }>,
) {
  const shown = presentCell(props.cell, props.translate, { identifier: props.identifier === true });
  const value = shown.incomplete ? `${shown.text}…` : shown.text;
  return (
    <Text
      value={value}
      tone={shown.tone}
      variant={shown.code ? 'code' : 'body'}
      numberOfLines={props.numberOfLines ?? 1}
    />
  );
}
