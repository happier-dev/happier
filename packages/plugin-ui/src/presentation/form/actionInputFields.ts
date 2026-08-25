type InputRecord = Readonly<Record<string, unknown>>;

/**
 * Presentation-only projection of the canonical Action field descriptor.
 *
 * The adapter in `components/Form.tsx` accepts the SDK's full descriptor and
 * passes it through structurally. Keeping this narrow contract here preserves
 * the dependency direction: presentation never imports host/SDK transport.
 */
export type HappierActionInputField = Readonly<{
  widget: 'boolean' | 'select' | 'multiselect' | 'json' | 'text_list' | 'secret'
    | 'textarea' | 'url' | 'number' | 'integer' | string;
  listSeparator?: 'comma' | 'newline';
}>;

export function readHappierActionInputPath(input: InputRecord, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((cursor, segment) => (
    cursor && typeof cursor === 'object' && !Array.isArray(cursor)
      ? (cursor as InputRecord)[segment]
      : undefined
  ), input);
}

export function writeHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split('.').filter(Boolean);
  const write = (source: InputRecord, index: number): Record<string, unknown> => {
    const segment = segments[index];
    if (!segment) return { ...source };
    if (index === segments.length - 1) return { ...source, [segment]: value };
    const current = source[segment];
    const child = current && typeof current === 'object' && !Array.isArray(current)
      ? current as InputRecord
      : {};
    return { ...source, [segment]: write(child, index + 1) };
  };
  return write(input, 0);
}

/** Patch shape consumed by the existing core Action editor. */
export function patchHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown> {
  const top = path.split('.').filter(Boolean)[0];
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
      value: Array.isArray(selection) ? undefined : selection,
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
  const display = isJson
    ? value === undefined
      ? ''
      : (() => { try { return JSON.stringify(value, null, 2); } catch { return ''; } })()
    : isList
      ? readTextList(field, value).join(newlineList ? '\n' : ', ')
      : value === undefined || value === null ? '' : String(value);

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
