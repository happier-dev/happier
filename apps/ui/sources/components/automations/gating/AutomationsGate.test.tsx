import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubServerFeaturesFetch } from '@/hooks/server/serverFeaturesTestUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('AutomationsGate', () => {
    it('renders children when automations are enabled and experiments are on', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: true, automationsExistingSessionTarget: true });

        const [{ AutomationsGate }, { getStorage }] = await Promise.all([
            import('./AutomationsGate'),
            import('@/sync/domains/state/storage'),
        ]);

        await act(async () => {
            getStorage().getState().applySettingsLocal({
                experiments: true,
                featureToggles: { automations: true },
            });
        });

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <AutomationsGate>
                    <TextStub>Allowed</TextStub>
                </AutomationsGate>,
            );
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(JSON.stringify(tree!.toJSON())).toContain('Allowed');
    });

    it('renders a disabled state when experiments are off', async () => {
        vi.resetModules();
        stubServerFeaturesFetch({ automationsEnabled: true, automationsExistingSessionTarget: true });

        const { AutomationsGate } = await import('./AutomationsGate');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <AutomationsGate>
                    <TextStub>Allowed</TextStub>
                </AutomationsGate>,
            );
            await new Promise((r) => setTimeout(r, 0));
        });

        const json = JSON.stringify(tree!.toJSON());
        expect(json).not.toContain('Allowed');
        expect(json).toContain('Automations are disabled');
    });
});

function TextStub(props: { children: string }) {
    return React.createElement('Text', props);
}
