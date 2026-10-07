// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSurface as renderShellSurface } from '../surface.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { TRIAGE_SHELL_LIST_REGION_TEST_ID_V1 } from './root.js';

/**
 * The first paint, while nothing has answered yet. The page used to stand a separate loading tree in for the
 * list and swap the list in when the first read answered — a remount of the whole region and a jump from one
 * geometry to another. The list's own region holds its geometry instead, in its loading state.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the first paint of PRs & Issues', () => {
    it('is the list region itself, loading, rather than a stand-in that is swapped out', async () => {
        const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'fixture-instance-first-paint', mountNonce: 'fixture-mount-first-paint' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' },
                surface: renderShellSurface,
                surfaceContext: createSurfaceContextFixture({
                    mount: {
                        kind: 'destination',
                        destination: { pluginId: 'happier.triage', localId: 'triage' },
                        container: 'appPage',
                    },
                }),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
                handlers: {
                    publishCurrentUiContext: () => undefined,
                    // Nothing answers: the page stays in its first paint for the whole test.
                    executeAction: () => new Promise<never>(() => undefined),
                    replacePageLocation: ({ subPath }) => subPath,
                },
            });
        });
        mounted.push(fixture);

        expect(document.querySelector(`[data-testid="${TRIAGE_SHELL_LIST_REGION_TEST_ID_V1}"]`)).not.toBeNull();
        // The toolbar is reachable while the first read is outstanding.
        await expect(fixture.getByRole('button', { name: 'Refresh' })).resolves.toBeDefined();
    });
});
