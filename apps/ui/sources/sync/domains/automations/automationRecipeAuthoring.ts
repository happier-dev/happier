import type { z } from 'zod';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

import { AutomationTemplateEncryptionMaterialUnavailableError } from './automationTemplateAvailability';

/** Schema-specific recipe callers share the Account envelope and currentness owner. */
export async function openAutomationRecipePayloadForAuthoring<T>(params: Readonly<{
    envelope: Readonly<{ t: 'plain'; v: unknown }> | Readonly<{ t: 'encrypted'; c: string }>;
    schema: z.ZodType<T>;
    decryptRaw?: (ciphertext: string) => Promise<unknown | null>;
    isCurrent?: () => boolean;
}>): Promise<T> {
    const opened = params.envelope.t === 'plain'
        ? params.envelope.v
        : params.decryptRaw ? await params.decryptRaw(params.envelope.c) : null;
    if (params.isCurrent && !params.isCurrent()) throw new Error('Automation authoring authority changed');
    const parsed = params.schema.safeParse(opened);
    if (!parsed.success) throw new AutomationTemplateEncryptionMaterialUnavailableError();
    return parsed.data;
}

export async function sealAutomationRecipePayloadForAuthoring(params: Readonly<{
    credentials: AuthCredentials;
    payload: unknown;
    encryptRaw?: (value: unknown) => Promise<string>;
    isCurrent?: () => boolean;
}>): Promise<unknown> {
    const mode = await fetchAccountEncryptionMode(params.credentials);
    if (params.isCurrent && !params.isCurrent()) throw new Error('Automation authoring authority changed');
    if (mode.mode === 'plain') return { t: 'plain', v: params.payload };
    if (!params.encryptRaw) throw new AutomationTemplateEncryptionMaterialUnavailableError();
    const ciphertext = await params.encryptRaw(params.payload);
    if (params.isCurrent && !params.isCurrent()) throw new Error('Automation authoring authority changed');
    return { t: 'encrypted', c: ciphertext };
}
