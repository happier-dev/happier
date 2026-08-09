import type { DirectBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { t } from '@/text';

export function resolvePiBrowseSourceOptions(): readonly DirectBrowseSourceOption[] {
    return [{
        key: 'pi:default',
        label: t('directSessions.browseSourcePiDefault'),
        source: { kind: 'piAgentDir' },
    }];
}
