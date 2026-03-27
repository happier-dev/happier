import type { DirectBrowseSourceOption } from '@/agents/registry/registryUiBehavior';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

const CODEX_CONNECTED_SERVICE_ID = 'openai-codex';

function isCodexUserHomeOption(option: DirectBrowseSourceOption): boolean {
    return option.source.kind === 'codexHome' && option.source.home === 'user';
}

function matchesCodexConnectedServiceProfile(option: DirectBrowseSourceOption, profileId: string): boolean {
    return option.source.kind === 'codexHome'
        && option.source.home === 'connectedService'
        && option.source.connectedServiceId === CODEX_CONNECTED_SERVICE_ID
        && (option.source.connectedServiceProfileId ?? '') === profileId;
}

export function resolveCodexLockedBrowseSourceOption(params: Readonly<{
    sourceOptions: readonly DirectBrowseSourceOption[];
    agentOptionState: Record<string, unknown> | null | undefined;
}>): DirectBrowseSourceOption | null {
    const options = params.sourceOptions;
    if (options.length === 0) return null;

    const bindingsByServiceId = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
        agentOptionState: params.agentOptionState,
    });
    const binding = bindingsByServiceId[CODEX_CONNECTED_SERVICE_ID];
    const connectedProfileId = binding?.source === 'connected' ? String(binding.profileId ?? '').trim() : '';

    if (connectedProfileId) {
        const match = options.find((option) => matchesCodexConnectedServiceProfile(option, connectedProfileId));
        if (match) return match;
    }

    return options.find((option) => isCodexUserHomeOption(option)) ?? options[0] ?? null;
}
