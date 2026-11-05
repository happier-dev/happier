import { readInputPath, writeInputPath, type InputFieldHint } from '@happier-dev/plugin-sdk/actions';

type InputRecord = Readonly<Record<string, unknown>>;

/**
 * Presentation-only projection of the canonical Action field descriptor.
 *
 * The adapter in `components/Form.tsx` accepts the SDK's full descriptor and
 * passes it through structurally. Keeping this narrow contract here preserves
 * the dependency direction: presentation never imports host/SDK transport.
 */
export type HappierActionInputField = Pick<InputFieldHint, 'widget'>
  & Partial<Pick<InputFieldHint, 'unit' | 'listSeparator' | 'inputType' | 'options' | 'optionsSourceId' | 'connectedAccountOptions'>>;

export function readHappierActionInputPath(input: InputRecord, path: string): unknown {
  return readInputPath(input, path);
}

export function writeHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown> {
  return writeInputPath(input, path, value);
}

/** Patch shape consumed by the existing core Action editor. */
export function patchHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown> {
  const top = path.split('.').map((segment) => segment.trim()).filter(Boolean)[0];
  if (!top) return {};
  return { [top]: writeHappierActionInputPath(input, path, value)[top] };
}

export type HappierActionFieldPresentation<OptionValue = unknown> =
  | Readonly<{ kind: 'toggle'; value: boolean }>
  | Readonly<{
      kind: 'select';
      value: OptionValue | readonly OptionValue[] | undefined;
      multiple: boolean;
    }>
  | Readonly<{
      kind: 'text';
      value: string;
      secure: boolean;
      multiline: boolean;
      keyboardType: 'default' | 'url' | 'numeric';
      parseText(text: string): unknown;
    }>;

/** The most choices a fixed single choice shows as one segmented control. */
export const HAPPIER_SEGMENTED_CHOICES_MAX = 4;
/**
 * The most steps a short ordinal scale (Low · Medium · High · XHigh · Max · Ultra, Codex's six) shows as one
 * segmented row: more than the general cap, because ordered steps read as one scale (owner rulings 2026-11-04
 * and 2026-11-05). A row too narrow for them still falls back to the field select, by measure.
 */
const HAPPIER_SEGMENTED_ORDINAL_CHOICES_MAX = 6;
/**
 * The longest label a segment carries ("API equivalent"): longer ones would squeeze four segments past
 * a row's control column, so the choice stays a list ("long labels: bordered field select").
 */
export const HAPPIER_SEGMENTED_LABEL_MAX_CHARS = 14;

/**
 * How a fixed choice is drawn, decided once for every typed form (Action fields, Workflow inputs,
 * widget setup, plugin Forms): two to four short choices that need no explanation are one segmented
 * control; more, long or explained ones and several values are the one compact choice field
 * (`'list'`: a field box naming the reading that opens its rows; DESIGN.md control table, lab
 * `dashboards` IN "Plain inputs"). `ordinal` marks the choices as steps of one ordered scale (thinking
 * effort), which stays segmented up to five short steps.
 */
export function resolveHappierChoiceControl(
  presentation: HappierActionFieldPresentation,
  options: readonly Readonly<{ label: string; description?: string }>[],
  scale?: Readonly<{ ordinal?: boolean }>,
): 'segmented' | 'list' | null {
  if (presentation.kind !== 'select') return null;
  return !presentation.multiple
    && options.length >= 2
    && options.length <= (scale?.ordinal === true ? HAPPIER_SEGMENTED_ORDINAL_CHOICES_MAX : HAPPIER_SEGMENTED_CHOICES_MAX)
    && options.every((option) => option.description === undefined && option.label.length <= HAPPIER_SEGMENTED_LABEL_MAX_CHARS)
    ? 'segmented'
    : 'list';
}

function readTextList(field: HappierActionInputField, value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function parseNumericDraft(widget: 'number' | 'integer', text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const complete = widget === 'integer'
    ? /^[+-]?\d+$/.test(trimmed)
    : /^[+-]?(?:\d+|\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed);
  if (!complete) return text;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : text;
}

/** A byte-size integer (`unit: 'bytes'`) is entered in GiB; this is the one place the value converts. */
export const HAPPIER_BYTES_PER_GIB = 1024 ** 3;

function displayBytesAsGib(value: unknown): string {
  // Non-numbers are an in-progress or inadmissible entry, shown exactly as typed.
  return typeof value === 'number' && Number.isFinite(value) ? String(value / HAPPIER_BYTES_PER_GIB) : String(value);
}

function parseGibDraft(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  // Fractional GiB land on whole bytes, so any value this field displays can be typed back.
  const bytes = /^\d+(\.\d+)?$/.test(trimmed) ? Math.round(Number(trimmed) * HAPPIER_BYTES_PER_GIB) : NaN;
  return Number.isSafeInteger(bytes) ? bytes : text;
}

/**
 * One widget/display/text-parser decision shared by public Form and core Actions.
 *
 * Selection values are already normalized by the calling Action-form adapter.
 * Presentation deliberately does not parse SDK/host option contracts.
 */
export function resolveHappierActionFieldPresentation<OptionValue = unknown>(
  field: HappierActionInputField,
  value: unknown,
  selection?: OptionValue | readonly OptionValue[],
): HappierActionFieldPresentation<OptionValue> {
  if (field.widget === 'boolean') return { kind: 'toggle', value: value === true };
  if (field.widget === 'select') {
    return {
      kind: 'select',
      value: selection,
      multiple: false,
    };
  }
  if (field.widget === 'multiselect') {
    return {
      kind: 'select',
      value: Array.isArray(selection) ? selection : [],
      multiple: true,
    };
  }

  const isJson = field.widget === 'json';
  const isList = field.widget === 'text_list';
  const newlineList = isList && field.listSeparator === 'newline';
  const gib = field.widget === 'integer' && field.unit === 'bytes';
  const display = isJson
    ? value === undefined
      ? ''
      : (() => { try { return JSON.stringify(value, null, 2); } catch { return ''; } })()
    : isList
      ? readTextList(field, value).join(newlineList ? '\n' : ', ')
      : value === undefined || value === null ? '' : gib ? displayBytesAsGib(value) : String(value);

  return {
    kind: 'text',
    value: display,
    secure: field.widget === 'secret',
    multiline: field.widget === 'textarea' || isJson || newlineList,
    keyboardType: field.widget === 'url'
      ? 'url'
      : field.widget === 'number' || field.widget === 'integer'
        ? 'numeric'
        : 'default',
    parseText(text: string): unknown {
      if (gib) return parseGibDraft(text);
      if (field.widget === 'number' || field.widget === 'integer') {
        return parseNumericDraft(field.widget, text);
      }
      if (isList) {
        return text.split(newlineList ? '\n' : ',').map((item) => item.trim()).filter(Boolean);
      }
      if (isJson) {
        try { return JSON.parse(text); } catch { return text; }
      }
      return text;
    },
  };
}
