import type { KeyboardPlatform, NormalizedKeyboardEvent } from '@/keyboard/types';
import { matchKeybindingRule, parseKeybindingRule } from '@/keyboard/bindings';

const SEND = parseKeybindingRule({ binding: 'Mod+Enter', allowInEditable: true });
const INSERT = parseKeybindingRule({ binding: 'Enter', allowInEditable: true });
const FAVORITE = parseKeybindingRule({ binding: 'Mod+D', allowInEditable: true });

export type PromptPickerKeyAction = 'insert' | 'send' | 'favorite';

/**
 * The picker field's own keys: ↵ inserts, Mod+↵ sends, Mod+D favourites the highlighted prompt.
 * Some field bridges report the key without its physical code, so a bare letter is matched by key.
 */
export function resolvePromptPickerKeyAction(event: NormalizedKeyboardEvent, platform: KeyboardPlatform): PromptPickerKeyAction | null {
    const options = { platform, context: { isEditableTarget: true, isComposing: event.isComposing } };
    const normalized = event.code || event.key.length !== 1 ? event : { ...event, code: `Key${event.key.toUpperCase()}` };
    if (matchKeybindingRule(SEND, normalized, options)) return 'send';
    if (matchKeybindingRule(INSERT, normalized, options)) return 'insert';
    if (matchKeybindingRule(FAVORITE, normalized, options)) return 'favorite';
    return null;
}
