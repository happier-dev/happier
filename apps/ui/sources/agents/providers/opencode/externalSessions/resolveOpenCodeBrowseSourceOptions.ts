import type { ExternalSessionBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { t } from '@/text';

export function resolveOpenCodeBrowseSourceOptions(): readonly ExternalSessionBrowseSourceOption[] {
    return [{
        key: 'opencode:default',
        label: t('externalSessions.browseSourceOpenCodeDefault'),
        source: { kind: 'opencodeServer' },
    }];
}
