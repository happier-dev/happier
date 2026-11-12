import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { JsonValue } from '@happier-dev/plugin-sdk';

type NativeRecord = Readonly<Record<string, JsonValue>>;

function isMuseRecord(value: JsonValue | undefined): value is NativeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** MSP objects are decoded once at this plugin's native boundary. */
export function readMuseRecord(value: JsonValue | undefined): NativeRecord {
  return isMuseRecord(value) ? value : {};
}

export function readMuseNativeJson(value: JsonValue | undefined): JsonValue {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

export function protocolError(message: string): PluginError {
    return new PluginError({ code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', message });
}
export function requiredString(record: NativeRecord, key: string): string {
    const value = record[key];
    if (typeof value !== 'string' || !value) throw protocolError(`Muse omitted ${key} from an interaction`);
    return value;
}
/** One Muse-to-host question shape for pending requests and transcript tools. */
export function questionInput(params: NativeRecord): Record<string, JsonValue> {
    if (!Array.isArray(params.questions)) throw protocolError('Muse omitted structured questions');
    return { questions: params.questions.map(readMuseRecord).map(question => {
        const selection = readMuseRecord(question.selection);
        // Muse 1.4.15 omits selection for its default single-choice tool arguments.
        const mode = question.selection === undefined ? 'single' : selection.mode;
        if (mode !== 'single' && mode !== 'multiple') throw new PluginError({ code: 'unsupported', message: 'Muse offered an unsupported question selection.' });
        if (!Array.isArray(question.options)) throw protocolError('Muse omitted question options');
        const options = question.options.map(readMuseRecord).map(option => ({ id: requiredString(option, 'label'),
            label: requiredString(option, 'label'), ...(typeof option.description === 'string' ? { description: option.description } : {}) }));
        const min = typeof selection.minSelections === 'number' ? selection.minSelections : 1;
        const max = typeof selection.maxSelections === 'number' ? selection.maxSelections : options.length;
        return { id: requiredString(question, 'id'), question: requiredString(question, 'question'),
            ...(typeof question.header === 'string' ? { header: question.header } : {}),
            selection: mode, required: mode === 'single' || min > 0, allowCustom: true, allowNote: true, options,
            ...(mode === 'multiple' ? { minSelections: min, maxSelections: max } : {}) };
    }) };
}
