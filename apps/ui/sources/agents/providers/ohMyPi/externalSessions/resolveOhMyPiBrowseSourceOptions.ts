import { t } from '@/text';

export function resolveOhMyPiBrowseSourceOptions() {
    return [{
        key: 'ohMyPi:default-agent-dir',
        label: t('agentInput.agent.ohMyPi'),
        detail: '~/.omp/agent',
        source: { kind: 'ohMyPiAgentDir' as const },
    }] as const;
}
