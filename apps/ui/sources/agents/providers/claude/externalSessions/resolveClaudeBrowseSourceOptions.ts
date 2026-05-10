import type { ExternalSessionBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { t } from '@/text';

export function resolveClaudeBrowseSourceOptions(): readonly ExternalSessionBrowseSourceOption[] {
    return [{
        key: 'claude:default',
        label: t('externalSessions.browseSourceClaudeDefault'),
        source: { kind: 'claudeConfig' },
    }];
}
