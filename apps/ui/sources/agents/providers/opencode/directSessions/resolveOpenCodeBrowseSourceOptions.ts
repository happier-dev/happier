import type { DirectBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { t } from '@/text';

export function resolveOpenCodeBrowseSourceOptions(): readonly DirectBrowseSourceOption[] {
    return [{
        key: 'opencode:default',
        label: t('directSessions.browseSourceOpenCodeDefault'),
        source: { kind: 'opencodeServer' },
    }];
}
