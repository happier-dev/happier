import type { DirectBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { t } from '@/text';

export function resolveClaudeBrowseSourceOptions(): readonly DirectBrowseSourceOption[] {
    return [{
        key: 'claude:default',
        label: t('directSessions.browseSourceClaudeDefault'),
        source: { kind: 'claudeConfig' },
    }];
}
