import type { BotTemplateOpenInputV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { BotTemplateDraftRefV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { t } from '@/text';

export const BOT_TEMPLATE_EDITOR_DESTINATION = 'bot-template.editor';
export type BotTemplateEditorResource = Readonly<{ kind: typeof BOT_TEMPLATE_EDITOR_DESTINATION; artifactId: string; serverId: string }>;

export function readBotTemplateEditorResource(value: unknown): BotTemplateEditorResource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resource = value as Record<string, unknown>;
    if (resource.kind !== BOT_TEMPLATE_EDITOR_DESTINATION) return null;
    const ref = BotTemplateDraftRefV1Schema.safeParse({ artifactId: resource.artifactId, serverId: resource.serverId });
    return ref.success ? { kind: BOT_TEMPLATE_EDITOR_DESTINATION, ...ref.data } : null;
}

export function createBotTemplateEditorDetailsTab(ref: Readonly<{ artifactId: string; serverId: string }>): DetailsTab {
    return { key: `${BOT_TEMPLATE_EDITOR_DESTINATION}:${ref.serverId}:${ref.artifactId}`, kind: BOT_TEMPLATE_EDITOR_DESTINATION,
        title: t('botTemplates.title'), resource: { kind: BOT_TEMPLATE_EDITOR_DESTINATION, ...ref } };
}

export function buildBotTemplateEditorRoute(input: BotTemplateOpenInputV1) {
    return { pathname: '/session/[id]/template' as const, params: { id: input.sourceSessionRef.sessionId,
        serverId: input.sourceSessionRef.serverId, artifactId: input.draftArtifactId } };
}
