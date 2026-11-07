import { z } from 'zod/mini';
import { BotTemplateSetupSelectionsV1Schema, BotTemplateUpdateApplyInputV1Schema,
    projectBotTemplateSetupSelectionsForReviewV1, type BotTemplateSetupSelectionsV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { ThreeWayTextChoiceV1Schema } from '@happier-dev/protocol/diff/threeWayText';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';

export const BotTemplateSetupDraftPatchSchema = z.strictObject({
    selections: z.optional(BotTemplateSetupSelectionsV1Schema),
});
export const BotTemplateReviewDraftPatchSchema = z.strictObject({
    instructions: z.optional(z.record(z.string(), ThreeWayTextChoiceV1Schema)),
    skills: BotTemplateUpdateApplyInputV1Schema.shape.skills,
    takeIdentity: BotTemplateUpdateApplyInputV1Schema.shape.takeIdentity,
    editedInstructions: z.optional(z.nullable(z.string())),
    selections: z.optional(BotTemplateSetupSelectionsV1Schema),
});

const patchDescriptions = {
    setup: JSON.stringify(zodSchemaToJsonSchemaObject(BotTemplateSetupDraftPatchSchema)),
    review: JSON.stringify(zodSchemaToJsonSchemaObject(BotTemplateReviewDraftPatchSchema)),
};

/** Borrows the controlled form's state; submission remains an ordinary approved template Action. */
export function useBotTemplateDraftCommands(options: Readonly<{
    kind: 'setup' | 'review';
    isCurrent(): boolean;
    read(): Readonly<Record<string, unknown> & { selections: BotTemplateSetupSelectionsV1 }>;
    patch(input: PluginUiJsonValueV1): boolean;
}>) {
    return useCurrentUiContextLocalCommands([
        { key: `bot-template.${options.kind}.read`, title: t('common.details'),
            description: JSON.stringify({ draft: options.kind, operation: 'read' }),
            invoke: () => {
                if (!options.isCurrent()) return false;
                const draft = options.read();
                return { ok: true, result: projectNativeJsonValueForTransport({
                    ...draft, selections: projectBotTemplateSetupSelectionsForReviewV1(draft.selections),
                }) };
            } },
        { key: `bot-template.${options.kind}.patch`, title: t('common.edit'),
            description: patchDescriptions[options.kind],
            invoke: input => options.isCurrent() && input !== undefined && options.patch(input) },
    ]);
}
