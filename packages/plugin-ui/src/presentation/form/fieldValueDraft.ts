import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

/** What a typed-in-place setting holds: free text, a whole number or a decimal. */
export type HappierFieldValueKind = 'text' | 'integer' | 'decimal';
export type HappierFieldStepperBounds = Readonly<{ min?: number; max?: number; step: number }>;

/**
 * The draft a number field keeps: digits only (one decimal point for a
 * decimal), with one leading minus when the number may be negative.
 */
export function filterHappierFieldDraft(kind: HappierFieldValueKind, text: string, signed = false): string {
  if (kind === 'text') return text;
  const minus = signed && text.trimStart().startsWith('-') ? '-' : '';
  if (kind === 'integer') return minus + text.replace(/[^0-9]/g, '');
  const cleaned = text.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  return minus + (dot < 0 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, ''));
}

export type HappierFieldKeyboardType = 'number-pad' | 'decimal-pad' | 'numbers-and-punctuation' | 'numeric';

/** The keyboard a number field opens (the iOS number pads have no minus key). */
export function resolveHappierFieldKeyboardType(
  kind: HappierFieldValueKind,
  signed = false,
): HappierFieldKeyboardType | undefined {
  if (kind === 'text') return undefined;
  const ios = Platform.OS === 'ios';
  if (signed) return ios ? 'numbers-and-punctuation' : 'numeric';
  if (kind === 'integer') return ios ? 'number-pad' : 'numeric';
  return ios ? 'decimal-pad' : 'numeric';
}

export type HappierFieldValueDraftInput = Readonly<{
  /** The saved value, as text. The draft follows it whenever it changes. */
  value: string;
  /**
   * Saves the typed value, only when it differs from `value`. Returns the text
   * the field shows afterwards (a number moved to its bound, the saved value
   * when refused), or nothing to keep the draft.
   */
  onCommit: (draft: string) => string | void;
  /** Each draft as the field keeps it. */
  onDraftChange?: (draft: string) => void;
  kind?: HappierFieldValueKind;
  signed?: boolean;
  /** A number that may be left empty ("not set"): an empty draft commits instead of returning. */
  allowEmpty?: boolean;
  stepper?: HappierFieldStepperBounds;
}>;

/**
 * The one owner of a typed-in-place setting's draft: local while typing,
 * filtered to its kind, committed when focus leaves or on submit — once, and
 * only when it changed. A number emptied without `allowEmpty` returns to the
 * saved value. Happier core's `FieldValueItem` and the public
 * `TextField presentation="field"` with `onCommit` both use it.
 */
export function useHappierFieldValueDraft(input: HappierFieldValueDraftInput): Readonly<{
  draft: string;
  change: (text: string) => void;
  commit: () => void;
  stepBy: (direction: -1 | 1) => void;
  canDecrement: boolean;
  canIncrement: boolean;
}> {
  const { value, onCommit, onDraftChange, kind = 'text', signed = false, allowEmpty, stepper } = input;
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const change = useCallback((text: string) => {
    const next = filterHappierFieldDraft(kind, text, signed);
    setDraft(next);
    onDraftChange?.(next);
  }, [kind, onDraftChange, signed]);
  const commit = useCallback(() => {
    const next = kind === 'text' ? draft.trim() : draft;
    if (kind !== 'text' && next.length === 0 && !allowEmpty) {
      setDraft(value);
      return;
    }
    if (next === value) {
      setDraft(value);
      return;
    }
    const shown = onCommit(next);
    setDraft(typeof shown === 'string' ? shown : next);
  }, [allowEmpty, draft, kind, onCommit, value]);
  const current = draft.trim() !== '' && Number.isFinite(Number(draft)) ? Number(draft) : Number(value);
  const stepBy = useCallback((direction: -1 | 1) => {
    if (!stepper || !Number.isFinite(current)) return;
    const next = Math.max(stepper.min ?? -Infinity, Math.min(stepper.max ?? Infinity, current + direction * stepper.step));
    const text = String(next);
    if (text === value) { setDraft(value); return; }
    const shown = onCommit(text);
    setDraft(typeof shown === 'string' ? shown : text);
  }, [current, onCommit, stepper, value]);
  return {
    draft, change, commit, stepBy,
    canDecrement: Number.isFinite(current) && current > (stepper?.min ?? -Infinity),
    canIncrement: Number.isFinite(current) && current < (stepper?.max ?? Infinity),
  };
}
