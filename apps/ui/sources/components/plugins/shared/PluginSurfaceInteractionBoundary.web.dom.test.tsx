/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { PluginSurfaceInteractionBoundary } from './PluginSurfaceInteractionBoundary.web';

describe('PluginSurfaceInteractionBoundary.web DOM focus ownership', () => {
    it('blurs a focused descendant when an available retained snapshot becomes presentation-ineligible', async () => {
        const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
        const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        const render = (focusEligible: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-web-dom-presentation-ineligible"
                snapshotTitle="Build summary"
                enabled
                focusEligible={focusEligible}
            >
                <button data-testid="plugin-web-dom-presentation-ineligible-action">Run build</button>
            </PluginSurfaceInteractionBoundary>
        );

        try {
            await act(async () => {
                root.render(render(true));
            });
            const action = container.querySelector<HTMLButtonElement>(
                '[data-testid="plugin-web-dom-presentation-ineligible-action"]',
            );
            if (!action) throw new Error('Expected the mounted action.');
            const blur = vi.spyOn(action, 'blur');

            await act(async () => {
                action.focus();
            });
            expect(document.activeElement).toBe(action);

            await act(async () => {
                root.render(render(false));
            });

            expect(blur).toHaveBeenCalledOnce();
            expect(document.activeElement).not.toBe(action);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        }
    });
});
