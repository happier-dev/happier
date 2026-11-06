import * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

// Native, font/theme and icon adapters are the platform boundaries; the chip's naming is real.
installAgentInputCommonModuleMocks();
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-crypto', async () => ({
    ...await import('@/platform/cryptoRandom.node'),
    ...await import('@/platform/randomUUID.node'),
}));

beforeAll(async () => { await import('./AgentInput'); }, 600_000);

const agentTargetKey = 'agent:happier.agent.codex/codex';
const defaultOnly = [{ value: 'default', label: 'Default', description: '' }];

function providerPresentation(failed: boolean) {
    return {
        agentTargetKey, declarationContext: { kind: 'account' as const }, nativeModels: [], providerGroups: [],
        hiddenNativeModelKeys: new Set<string>(), providerProjectionAuthoritative: false, providerProjectionFailed: failed,
        selected: { agentTargetKey, providerConnectionId: 'pc_work', modelId: 'openrouter/free' },
        fallbackLabel: 'Unavailable', fieldLabel: 'Model',
    };
}

async function chipName(props: Readonly<Record<string, unknown>>) {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput value="" placeholder="Message" onChangeText={() => undefined}
        onSend={() => undefined} autocompleteKinds={[]} autocompleteSuggestions={async () => []} voiceAffordance="none"
        agentType="codex" permissionMode="default" onPermissionModeChange={() => undefined}
        onModelModeChange={() => undefined} agentPickerOptions={[{ key: 'codex', title: 'Codex', onSelect: () => undefined } as never]}
        modelMode="gpt-6-luna" modelOptionsOverride={defaultOnly} {...props} />);
    const chip = screen.findHostByTestId('agent-input-agent-chip');
    return chip?.props.accessibilityLabel ?? chip?.props['aria-label'];
}

describe('AgentInput engine chip model name', () => {
    it('lets the catalog name the model when it holds it', async () => {
        expect(await chipName({
            modelOptionsOverride: [{ value: 'gpt-6-luna', label: 'GPT-6-Luna', description: '' }],
            modelOptionsOverrideProbe: { phase: 'loading', namesPending: true, retainedModelName: () => 'Older name' },
        })).toBe('GPT-6-Luna');
    });

    it('uses a retained row before the current catalog has answered', async () => {
        expect(await chipName({
            modelOptionsOverrideProbe: { phase: 'loading', namesPending: true, retainedModelName: () => 'GPT-6-Luna' },
        })).toBe('GPT-6-Luna');
    });

    it('stays quiet on the Agent while the catalog has not answered and nothing retained names the model', async () => {
        const name = await chipName({
            modelOptionsOverrideProbe: { phase: 'loading', namesPending: true, retainedModelName: () => null },
        });
        expect(name).not.toBe('gpt-6-luna');
        expect(name).toBeTruthy();
    });

    it('shows the id only when the settled catalog really does not know the model', async () => {
        expect(await chipName({
            modelOptionsOverrideProbe: { phase: 'idle', namesPending: false, retainedModelName: () => null },
        })).toBe('gpt-6-luna');
    });

    it('stays quiet on a Provider model while its projection has not answered', async () => {
        expect(await chipName({ modelPickerPresentation: providerPresentation(false), modelMode: 'openrouter/free' })).not.toBe('openrouter/free');
    });

    it('shows a Provider model\'s id when its projection failed', async () => {
        expect(await chipName({ modelPickerPresentation: providerPresentation(true), modelMode: 'openrouter/free' })).toBe('openrouter/free');
    });
});
