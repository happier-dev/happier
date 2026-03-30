import { beforeAll, describe, expect, it } from 'vitest';

import { getAgentCore } from '@/agents/registry/registryCore';
import {
    installMcpServersCommonModuleMocks,
} from './mcpServersTestHelpers';

const installMcpServerUiMocks = () => installMcpServersCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => `tx:${key}` });
    },
});

installMcpServerUiMocks();

let resolveDetectedProviderName: typeof import('./mcpServerUi').resolveDetectedProviderName;

describe('resolveDetectedProviderName', () => {
    beforeAll(async () => {
        ({ resolveDetectedProviderName } = await import('./mcpServerUi'));
    });

    it('resolves detected provider labels through the agent registry, including flavor aliases', () => {
        expect(resolveDetectedProviderName('claude')).toBe(`tx:${getAgentCore('claude').displayNameKey}`);
        expect(resolveDetectedProviderName('open-code')).toBe(`tx:${getAgentCore('opencode').displayNameKey}`);
    });

    it('falls back to the raw provider when no registered agent matches', () => {
        expect(resolveDetectedProviderName('unknown-provider')).toBe('unknown-provider');
    });
});
