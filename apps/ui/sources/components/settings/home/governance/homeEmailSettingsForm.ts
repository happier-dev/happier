import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { validateServerConfigText } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import type { ServerConfigEntryInput } from '@happier-dev/protocol/serverConfig/serverConfigEntry';
import type {
    HomeSettingEntryV1,
    HomeSettingSecretWriteV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';

import type { TranslationKeyNoParams } from '@/text';

import { KEEP_HOME_SECRET, type HomeSecretDraft } from './HomeSecretSettingRow';
import { isHomeSettingWritable } from './homeSettingDeclaration';

/**
 * The Email page's form over the registry's `email` section (plan §3.3).
 *
 * The page edits registry keys and nothing else: each field is one key, its value is parsed by the
 * registry's own codec, and the Home validates again on write. The draft keeps only what the owner
 * touched, so a projection re-read after a conflict re-bases the untouched fields on the Home's new
 * values while the owner's edits survive.
 */
export const HOME_EMAIL_SETTING_KEYS = {
    host: 'HAPPIER_AUTH_EMAIL_SMTP_HOST',
    port: 'HAPPIER_AUTH_EMAIL_SMTP_PORT',
    secure: 'HAPPIER_AUTH_EMAIL_SMTP_SECURE',
    username: 'HAPPIER_AUTH_EMAIL_SMTP_USERNAME',
    password: 'HAPPIER_AUTH_EMAIL_SMTP_PASSWORD',
    fromAddress: 'HAPPIER_AUTH_EMAIL_FROM_ADDRESS',
    fromName: 'HAPPIER_AUTH_EMAIL_FROM_NAME',
} as const satisfies Record<string, keyof typeof SERVER_CONFIG>;

export type HomeEmailField = keyof typeof HOME_EMAIL_SETTING_KEYS;
export type HomeEmailTextField = Exclude<HomeEmailField, 'secure' | 'password'>;

export const HOME_EMAIL_TEXT_FIELDS: readonly HomeEmailTextField[] = ['host', 'port', 'username', 'fromAddress', 'fromName'];


export type HomeEmailDraft = Readonly<{
    text: Readonly<Partial<Record<HomeEmailTextField, string>>>;
    secure?: boolean;
    password: HomeSecretDraft;
}>;

export const EMPTY_HOME_EMAIL_DRAFT: HomeEmailDraft = Object.freeze({
    text: Object.freeze({}),
    password: KEEP_HOME_SECRET,
});

export type HomeEmailEntries = Readonly<Partial<Record<HomeEmailField, HomeSettingEntryV1>>>;

/** The page's entries by field. A key an older Home does not project is simply absent. */
export function selectHomeEmailEntries(settings: HomeSettingsProjectionV1): HomeEmailEntries {
    const byKey = new Map(settings.entries.map((entry) => [entry.key, entry]));
    const entries: Partial<Record<HomeEmailField, HomeSettingEntryV1>> = {};
    for (const [field, key] of Object.entries(HOME_EMAIL_SETTING_KEYS) as [HomeEmailField, string][]) {
        const entry = byKey.get(key);
        if (entry) entries[field] = entry;
    }
    return entries;
}

/** A stored or default value as field text; a secret never has one. */
export function homeSettingText(entry: HomeSettingEntryV1 | undefined): string {
    const value = entry?.value;
    if (value === null || value === undefined) return '';
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export type HomeEmailFieldError = TranslationKeyNoParams;

export type HomeEmailWrite =
    | Readonly<{
        ok: true;
        values: Readonly<Record<string, unknown>>;
        secrets: Readonly<Record<string, HomeSettingSecretWriteV1>>;
        changed: boolean;
    }>
    | Readonly<{ ok: false; errors: Readonly<Partial<Record<HomeEmailField, HomeEmailFieldError>>> }>;

function registryEntry(field: HomeEmailField): ServerConfigEntryInput {
    return SERVER_CONFIG[HOME_EMAIL_SETTING_KEYS[field]];
}

/** The message for a value the registry (here or on the Home) refused for this field. */
export function homeEmailFieldError(field: HomeEmailField): HomeEmailFieldError {
    if (field === 'port') return 'homeGovernance.email.invalidPort';
    if (field === 'fromAddress') return 'homeGovernance.email.invalidEmail';
    return 'homeGovernance.email.invalidValue';
}

/** The field a refused registry key belongs to, when it is one of this page's. */
export function homeEmailFieldForKey(key: string): HomeEmailField | null {
    const found = (Object.entries(HOME_EMAIL_SETTING_KEYS) as [HomeEmailField, string][]).find(([, candidate]) => candidate === key);
    return found ? found[0] : null;
}

/**
 * The partial write the draft asks for, against the projection it was drawn from. An emptied
 * field clears the Home's stored value (the key falls back to its default); an unchanged field and
 * a fixed or read-only key are never sent.
 */
export function buildHomeEmailWrite(entries: HomeEmailEntries, draft: HomeEmailDraft): HomeEmailWrite {
    const values: Record<string, unknown> = {};
    const secrets: Record<string, HomeSettingSecretWriteV1> = {};
    const errors: Partial<Record<HomeEmailField, HomeEmailFieldError>> = {};

    for (const field of HOME_EMAIL_TEXT_FIELDS) {
        const text = draft.text[field];
        const entry = entries[field];
        if (text === undefined || !isHomeSettingWritable(entry)) continue;
        const trimmed = text.trim();
        let next: unknown = null;
        if (trimmed) {
            const parsed = validateServerConfigText(registryEntry(field), trimmed);
            if (!parsed.ok) {
                errors[field] = homeEmailFieldError(field);
                continue;
            }
            next = parsed.value;
        }
        if (next === null) {
            // Only a value this Home stored can be cleared; a default is already "unset".
            if (entry.source === 'home') values[entry.key] = null;
            continue;
        }
        if (next !== entry.value) values[entry.key] = next;
    }

    const secure = entries.secure;
    if (draft.secure !== undefined && isHomeSettingWritable(secure) && draft.secure !== (secure.value === true)) {
        values[secure.key] = draft.secure;
    }

    const password = entries.password;
    if (isHomeSettingWritable(password)) {
        if (draft.password.mode === 'replace' && draft.password.text.length > 0) {
            secrets[password.key] = { replace: draft.password.text };
        } else if (draft.password.mode === 'clear' && password.secretSet === true) {
            secrets[password.key] = { clear: true };
        }
    }

    if (Object.keys(errors).length > 0) return Object.freeze({ ok: false, errors });
    return Object.freeze({
        ok: true,
        values,
        secrets,
        changed: Object.keys(values).length > 0 || Object.keys(secrets).length > 0,
    });
}
