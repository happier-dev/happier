import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/experimental/sessions';

export type ClaudeBrowseSourceTranslationKey = 'externalSessions.browseSourceClaudeDefault';

export type ClaudeExternalSessionBrowseSourceOption = Readonly<{
    key: string;
    label: string;
    source: ExternalSessionsSource;
}>;

export function resolveClaudeBrowseSourceOptions(params: Readonly<{
    translate: (key: ClaudeBrowseSourceTranslationKey) => string;
}>): readonly ClaudeExternalSessionBrowseSourceOption[] {
    return [{
        key: 'claude:default',
        label: params.translate('externalSessions.browseSourceClaudeDefault'),
        source: { kind: 'claudeConfig' },
    }];
}
