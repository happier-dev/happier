import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputAssetLoader, installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit');
        return createTextModuleMock({ translate: (key, params) => `${key} ${String(params?.agent ?? '')}` });
    },
    storage: async (importOriginal) => await importOriginal(),
});
beforeEach(installAgentInputAssetLoader);

const codexMetadata = {
    path: '/repo', host: 'test.local',
    flavor: 'claude',
    agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } },
} as const;

async function renderComposer(overrides: Partial<React.ComponentProps<typeof import('./AgentInput').AgentInput>> = {}) {
    const { AgentInput } = await import('./AgentInput');
    return renderScreen(<AgentInput
        value=""
        onSend={() => {}}
        onChangeText={() => {}}
        placeholder="Message"
        autocompleteKinds={[]}
        autocompleteSuggestions={async () => []}
        agentType="codex"
        onAgentClick={() => {}}
        metadata={codexMetadata}
        {...overrides}
    />);
}

function readEngineAgent(screen: Awaited<ReturnType<typeof renderComposer>>) {
    return screen.tree.root.findAllByProps({ testID: 'agent-input-agent-chip-logo' })
        .find((icon) => Object.hasOwn(icon.props, 'agentId'))?.props.agentId;
}

describe('AgentInput agent identity', () => {
    it('does not present a policy fallback as the identity of an unknown existing Session', async () => {
        const screen = await renderComposer({
            sessionId: 'unknown-session', agentType: 'claude',
            metadata: { path: '/repo', host: 'test.local' },
        });
        expect(readEngineAgent(screen)).toBeNull();
    });

    it('can still name an armed continuation when the existing Session identity is unknown', async () => {
        const screen = await renderComposer({
            sessionId: 'unknown-session', agentType: 'claude',
            metadata: { path: '/repo', host: 'test.local' },
            armedContinuationTarget: { agentId: 'codex', label: 'Codex' },
        });
        expect(readEngineAgent(screen)).toBe('codex');
    });

    it('does not replace Codex with stale Claude flavor', async () => {
        expect(readEngineAgent(await renderComposer())).toBe('codex');
    });

    it('retains the selected new-session Agent without metadata', async () => {
        expect(readEngineAgent(await renderComposer({ metadata: null }))).toBe('codex');
    });

    it('shows the armed continuation Agent while retaining the running Session', async () => {
        expect(readEngineAgent(await renderComposer({
            armedContinuationTarget: { agentId: 'claude', label: 'Claude' },
        }))).toBe('claude');
    });
});
