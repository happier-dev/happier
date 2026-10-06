import {
    AutomationRunExecutionTargetV1Schema,
    AutomationRunTemplateV1Schema,
    AutomationRunTemplateV1ReadSchema,
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationStoredDefinitionExecutionRecipeV1ReadSchema,
    type AutomationRunExecutionTargetV1,
    type AutomationStoredDefinitionExecutionRecipeV1,
    type AutomationRunTemplateV1,
    type MentionRefV1,
} from '@happier-dev/protocol';
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

/** Opens the current private program for the mounted editor; it persists nowhere. */
export async function openAutomationRecipeForAuthoring(params: Readonly<{
    recipe: AutomationStoredDefinitionExecutionRecipeV1;
    decryptRaw?: (ciphertext: string) => Promise<unknown | null>;
    isCurrent?: () => boolean;
}>): Promise<AutomationRunTemplateV1> {
    const recipe = AutomationStoredDefinitionExecutionRecipeV1ReadSchema.parse(params.recipe);
    return openAutomationRecipePayloadForAuthoring({ ...params, envelope: recipe.template, schema: AutomationRunTemplateV1ReadSchema });
}

/**
 * The one Session-authoring projection into the current stored recipe. The
 * caller supplies the already-authoritative target; this owner only seals the
 * private prompt program according to the current Account encryption mode.
 */
export async function buildAutomationRecipeFromSessionAuthoring(params: Readonly<{
    credentials: AuthCredentials;
    templateVersion: number;
    prompt: string;
    mentions?: ReadonlyArray<MentionRefV1>;
    target: AutomationRunExecutionTargetV1;
    encryptRaw?: (value: unknown) => Promise<string>;
    isCurrent?: () => boolean;
}>): Promise<AutomationStoredDefinitionExecutionRecipeV1> {
    const target = AutomationRunExecutionTargetV1Schema.parse(params.target);

    const program = AutomationRunTemplateV1Schema.parse({
        v: 1 as const,
        prompt: params.prompt,
        ...(params.mentions?.length ? { mentions: [...params.mentions] } : {}),
    });

    // Validate the private program before encryption makes it opaque to the
    // outer recipe schema. Plain and E2EE Accounts share the same admission.
    const template = await sealAutomationRecipePayloadForAuthoring({ ...params, payload: program });

    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion: params.templateVersion,
        template,
        triggerEvidence: null,
        target,
    });
}
