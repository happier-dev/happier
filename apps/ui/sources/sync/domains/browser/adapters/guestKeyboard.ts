import type { NativeHardwareKeyboardEventLike } from '@/keyboard/runtime';

/** Keyboard metadata crosses the guest/native boundary; page content never belongs here. */
export function parseBrowserGuestKeyboardEvent(value: unknown): NativeHardwareKeyboardEventLike | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const key = value as Record<string, unknown>;
    const modifiers = key.modifiers;
    if (typeof key.key !== 'string' || typeof key.code !== 'string' || typeof key.repeat !== 'boolean'
        || (key.isEditableTarget !== undefined && typeof key.isEditableTarget !== 'boolean')
        || !modifiers || typeof modifiers !== 'object' || Array.isArray(modifiers)) return null;
    const mods = modifiers as Record<string, unknown>;
    if (typeof mods.shift !== 'boolean' || typeof mods.ctrl !== 'boolean' || typeof mods.meta !== 'boolean' || typeof mods.alt !== 'boolean') return null;
    return { key: key.key, code: key.code, repeat: key.repeat,
        ...(typeof key.isEditableTarget === 'boolean' ? { isEditableTarget: key.isEditableTarget } : {}),
        modifiers: { shift: mods.shift, ctrl: mods.ctrl, meta: mods.meta, alt: mods.alt } };
}
