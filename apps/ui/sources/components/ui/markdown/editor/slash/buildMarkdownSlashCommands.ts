import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';
import type { TranslationKeyNoParams } from '@/text';

type MarkdownSlashTranslationKey = Extract<TranslationKeyNoParams, `markdown.slash.${string}`>;
export type MarkdownSlashTranslate = (key: MarkdownSlashTranslationKey) => string;

/**
 * Builds the static markdown slash command registry with i18n-resolved labels,
 * descriptions, and group headers (D13, D44).
 *
 * Command ids are stable UI-level identifiers that `resolveMarkdownSlashCommand`
 * maps to typed `MarkdownEditorCommand` values. No raw ids ever cross the bridge.
 *
 * `link` is intentionally absent — deferred per D50.
 */
export function buildMarkdownSlashCommands(t: MarkdownSlashTranslate): readonly CommandMenuItem[] {
    return [
        {
            id: 'heading1',
            label: t('markdown.slash.heading1.label'),
            description: t('markdown.slash.heading1.description'),
            group: t('markdown.slash.groups.headings'),
            aliases: ['h1', 'title'],
        },
        {
            id: 'heading2',
            label: t('markdown.slash.heading2.label'),
            description: t('markdown.slash.heading2.description'),
            group: t('markdown.slash.groups.headings'),
            aliases: ['h2'],
        },
        {
            id: 'heading3',
            label: t('markdown.slash.heading3.label'),
            description: t('markdown.slash.heading3.description'),
            group: t('markdown.slash.groups.headings'),
            aliases: ['h3'],
        },
        {
            id: 'bulletList',
            label: t('markdown.slash.bulletList.label'),
            description: t('markdown.slash.bulletList.description'),
            group: t('markdown.slash.groups.lists'),
            aliases: ['ul', 'unordered'],
        },
        {
            id: 'orderedList',
            label: t('markdown.slash.orderedList.label'),
            description: t('markdown.slash.orderedList.description'),
            group: t('markdown.slash.groups.lists'),
            aliases: ['ol', 'numbered'],
        },
        {
            id: 'taskList',
            label: t('markdown.slash.taskList.label'),
            description: t('markdown.slash.taskList.description'),
            group: t('markdown.slash.groups.lists'),
            aliases: ['todo', 'checkbox'],
        },
        {
            id: 'blockquote',
            label: t('markdown.slash.blockquote.label'),
            description: t('markdown.slash.blockquote.description'),
            group: t('markdown.slash.groups.blocks'),
            aliases: ['quote'],
        },
        {
            id: 'codeBlock',
            label: t('markdown.slash.codeBlock.label'),
            description: t('markdown.slash.codeBlock.description'),
            group: t('markdown.slash.groups.blocks'),
            aliases: ['code', 'pre'],
        },
        {
            id: 'horizontalRule',
            label: t('markdown.slash.horizontalRule.label'),
            description: t('markdown.slash.horizontalRule.description'),
            group: t('markdown.slash.groups.blocks'),
            aliases: ['hr', 'rule'],
        },
    ];
}
