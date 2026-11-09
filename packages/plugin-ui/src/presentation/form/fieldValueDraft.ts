import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** The saved value, as text. External changes update pristine fields, preserving dirty drafts. */
  value: string;
  /** A controlled editor echoes its draft in value; setting both to the acknowledged value resets the draft. */
  committedValue?: string;
  /**
   * Saves the typed value, only when it differs from `committedValue` (or `value` when omitted). Returns the text
   * the field shows afterwards (a number moved to its bound, the saved value
   * when refused), or nothing to keep the draft. An asynchronous Action can return its acceptance;
   * false/rejection retains the draft for an explicit retry. The caller presents any failure.
   */
  onCommit: (draft: string) => string | void | Promise<boolean>;
  /** Each draft as the field keeps it. */
  onDraftChange?: (draft: string) => void;
  kind?: HappierFieldValueKind;
  /** Text fields trim at commit by default; prose/templates can preserve their authored whitespace. */
  trim?: boolean;
  /** Canonical saved text for this field; replaces trimming when supplied and runs only on commit. */
  normalize?: (draft: string) => string;
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
  cancel: () => void;
  stepBy: (direction: -1 | 1) => void;
  canDecrement: boolean;
  canIncrement: boolean;
}> {
  const { value, committedValue: acknowledgedValue, onCommit, onDraftChange, kind = 'text', trim = true, normalize, signed = false, allowEmpty, stepper } = input;
  const committedValue = acknowledgedValue ?? value;
  const [draft, setDraft] = useState(value);
  const currentDraft = useRef(value);
  const dirty = useRef(false);
  const submitted = useRef<Readonly<{ text: string }> | null>(null);
  const show = useCallback((text: string) => { currentDraft.current = text; setDraft(text); }, []);
  useEffect(() => {
    if (currentDraft.current === committedValue || (acknowledgedValue !== undefined && value === committedValue)) {
      dirty.current = false;
      submitted.current = null;
    }
    if (!dirty.current) show(value);
  }, [acknowledgedValue, committedValue, show, value]);
  const change = useCallback((text: string) => {
    const next = filterHappierFieldDraft(kind, text, signed);
    dirty.current = next !== committedValue;
    submitted.current = null;
    show(next);
    onDraftChange?.(next);
  }, [committedValue, kind, onDraftChange, show, signed]);
  const cancel = useCallback(() => {
    dirty.current = false;
    submitted.current = null;
    show(committedValue);
    onDraftChange?.(committedValue);
  }, [committedValue, onDraftChange, show]);
  const submit = useCallback((next: string) => {
    const shown = onCommit(next);
    const submission = { text: next };
    submitted.current = submission;
    dirty.current = true;
    show(typeof shown === 'string' ? shown : next);
    if (typeof shown === 'string') dirty.current = shown !== committedValue;
    if (shown instanceof Promise) {
      // A refused/failed Action keeps the draft and allows an explicit retry. A late result from
      // an earlier edit cannot change the newer edit's submission state.
      const retry = () => { if (submitted.current === submission) submitted.current = null; };
      void shown.then(accepted => {
        if (submitted.current !== submission) return;
        submitted.current = null;
        if (accepted) dirty.current = false;
      }, retry);
    }
  }, [committedValue, onCommit, show]);
  const commit = useCallback(() => {
    if (!dirty.current) return;
    const next = normalize ? normalize(currentDraft.current)
      : kind === 'text' && trim ? currentDraft.current.trim() : currentDraft.current;
    if ((kind !== 'text' && next.length === 0 && !allowEmpty) || next === committedValue) {
      cancel();
      return;
    }
    // Submit and blur can arrive before the Action's acknowledgement. They complete one edit.
    if (submitted.current?.text !== next) submit(next);
  }, [allowEmpty, cancel, committedValue, kind, normalize, submit, trim]);
  const current = draft.trim() !== '' && Number.isFinite(Number(draft)) ? Number(draft) : Number(value);
  const stepBy = useCallback((direction: -1 | 1) => {
    if (!stepper || !Number.isFinite(current)) return;
    const next = Math.max(stepper.min ?? -Infinity, Math.min(stepper.max ?? Infinity, current + direction * stepper.step));
    const text = String(next);
    if (text === value) { cancel(); return; }
    submit(text);
  }, [cancel, current, stepper, submit, value]);
  return {
    draft, change, commit, cancel, stepBy,
    canDecrement: Number.isFinite(current) && current > (stepper?.min ?? -Infinity),
    canIncrement: Number.isFinite(current) && current < (stepper?.max ?? Infinity),
  };
}
