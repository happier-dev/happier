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
let formatDetectedWarning: typeof import('./mcpServerUi').formatDetectedWarning;

describe('resolveDetectedProviderName', () => {
    beforeAll(async () => {
        ({ resolveDetectedProviderName } = await import('./mcpServerUi'));
    });

    it('resolves detected provider labels through the agent registry, including flavor aliases', () => {
        expect(resolveDetectedProviderName('claude')).toBe(`tx:${getAgentCore('claude')?.displayNameKey}`);
        expect(resolveDetectedProviderName('open-code')).toBe(`tx:${getAgentCore('opencode')?.displayNameKey}`);
    });

    it('falls back to the raw provider when no registered agent matches', () => {
        expect(resolveDetectedProviderName('unknown-provider')).toBe('unknown-provider');
    });
});

describe('formatDetectedWarning', () => {
    beforeAll(async () => {
        ({ formatDetectedWarning } = await import('./mcpServerUi'));
    });

    it('says what went wrong in words, naming the Agent only when one owns the warning, never its raw code', () => {
        expect(formatDetectedWarning({ code: 'unsupported', path: 'plugin:config' }))
            .toBe('tx:capabilities.mcpFound.warningUnsupportedNoAgent \u00b7 plugin:config');
        expect(formatDetectedWarning({ provider: 'gemini', code: 'parse_failed' }))
            .toBe('tx:capabilities.mcpFound.warningParseFailed');
        expect(formatDetectedWarning({ provider: 'codex', code: 'read_failed', detail: 'Plugin MCP discovery timed out' }))
            .toBe('tx:capabilities.mcpFound.warningReadFailed \u00b7 Plugin MCP discovery timed out');
    });
});

describe('describeMachine', () => {
    it('names an unnamed machine as unnamed, never by its id', async () => {
        const { describeMachine } = await import('./mcpServerUi');
        const machines = [{ id: 'f98b860d-63e0', metadata: {} }] as unknown as Parameters<typeof describeMachine>[1];
        expect(describeMachine('f98b860d-63e0', machines)).toBe('tx:machine.unnamedMachine');
    });
});
