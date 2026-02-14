import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCiphertextFormat } from '@happier-dev/protocol';

export type AccountSettingsOpenFormat = AccountScopedCiphertextFormat | 'unknown';

export type OpenAccountSettingsResult = Readonly<{
    format: AccountSettingsOpenFormat;
    value: Record<string, unknown>;
}> | null;

export function sealAccountSettingsCiphertext(params: {
    machineKey: Uint8Array;
    settings: Record<string, unknown>;
    randomBytes: (length: number) => Uint8Array;
}): string {
    return sealAccountScopedBlobCiphertext({
        kind: 'account_settings',
        material: { type: 'dataKey', machineKey: params.machineKey },
        payload: params.settings,
        randomBytes: params.randomBytes,
    });
}

export async function openAccountSettingsCiphertext(params: {
    machineKey: Uint8Array;
    ciphertext: string;
    fallbackDecryptRaw?: (ciphertext: string) => Promise<unknown>;
}): Promise<OpenAccountSettingsResult> {
    const opened = openAccountScopedBlobCiphertext({
        kind: 'account_settings',
        material: { type: 'dataKey', machineKey: params.machineKey },
        ciphertext: params.ciphertext,
    });

    if (opened) {
        const value = opened.value;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return { format: opened.format, value: value as Record<string, unknown> };
        }
        return null;
    }

    if (!params.fallbackDecryptRaw) {
        return null;
    }

    const fallback = await params.fallbackDecryptRaw(params.ciphertext);
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
        return { format: 'unknown', value: fallback as Record<string, unknown> };
    }

    return null;
}

