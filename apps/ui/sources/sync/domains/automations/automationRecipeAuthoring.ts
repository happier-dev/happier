import {
    AutomationRunExecutionTargetV1Schema,
    AutomationRunTemplateV1Schema,
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    type AutomationRunExecutionTargetV1,
    type AutomationStoredDefinitionExecutionRecipeV1,
    type AutomationRunTemplateV1,
    type MentionRefV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

import { AutomationTemplateEncryptionMaterialUnavailableError } from './automationTemplateAvailability';

/** Opens the current private program for the mounted editor; it persists nowhere. */
export async function openAutomationRecipeForAuthoring(params: Readonly<{
    recipe: AutomationStoredDefinitionExecutionRecipeV1;
    decryptRaw?: (ciphertext: string) => Promise<unknown | null>;
    isCurrent?: () => boolean;
}>): Promise<AutomationRunTemplateV1> {
    const recipe = AutomationStoredDefinitionExecutionRecipeV1Schema.parse(params.recipe);
    const isCurrent = params.isCurrent ?? (() => true);
    const opened = recipe.template.t === 'plain'
        ? recipe.template.v
        : params.decryptRaw
            ? await params.decryptRaw(recipe.template.c)
            : null;
    if (!isCurrent()) throw new Error('Automation authoring authority changed');
    const parsed = AutomationRunTemplateV1Schema.safeParse(opened);
    if (!parsed.success) throw new AutomationTemplateEncryptionMaterialUnavailableError();
    return parsed.data;
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
    const isCurrent = params.isCurrent ?? (() => true);
    const target = AutomationRunExecutionTargetV1Schema.parse(params.target);
    const mode = await fetchAccountEncryptionMode(params.credentials);
    if (!isCurrent()) throw new Error('Automation authoring authority changed');

    const program = {
        v: 1 as const,
        prompt: params.prompt,
        ...(params.mentions?.length ? { mentions: [...params.mentions] } : {}),
    };

    // The recipe schema below is the canonical JSON-envelope admission owner;
    // keep this pre-parse value opaque so MentionRef passthrough fields cannot
    // be asserted to be JSON-safe merely from their wider runtime type.
    let template: unknown;
    if (mode.mode === 'plain') {
        template = { t: 'plain', v: program };
    } else {
        if (!params.encryptRaw) {
            throw new AutomationTemplateEncryptionMaterialUnavailableError();
        }
        const ciphertext = await params.encryptRaw(program);
        if (!isCurrent()) throw new Error('Automation authoring authority changed');
        template = { t: 'encrypted', c: ciphertext };
    }

    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion: params.templateVersion,
        template,
        triggerEvidence: null,
        target,
    });
}
