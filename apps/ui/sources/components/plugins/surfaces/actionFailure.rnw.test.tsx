// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import { renderSurface } from '../../../../../../packages/plugins/triage/src/ui/surface';
import { refreshTriageListWindow } from '../../../../../../packages/plugins/triage/src/ui/window/mountedWindow';
import { createTriageEphemeralSharedScopeFixture } from '../../../../../../packages/plugins/triage/src/ui/window/ephemeralSharedScope.test-support';
import { actionOutcomeUnknownFailure, createPluginSurfaceActionFailureError } from './actionFailure';

// Render the platform boundary through RNW rather than the unit lane's native host-tag stub.
vi.mock('react-native', () => vi.importActual<typeof import('react-native-web')>('react-native-web'));

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('unknown Action settlement at the existing manual Retry surface', () => {
    it.each([true, false])('shows Retry only for a declared read (readOnly=%s)', async readOnly => {
        const outcome = actionOutcomeUnknownFailure(PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE, { readOnly }, {});
        expect(outcome).toMatchObject({ code: 'timeout', retryable: readOnly });
        if (!outcome) throw new Error('Expected an unknown-settlement failure');
        const failure = createPluginSurfaceActionFailureError(outcome);
        expect(failure).toMatchObject({ retryable: readOnly });
        const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
        let attempts = 0;
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'read-timeout-retry', mountNonce: 'read-timeout-retry-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' },
                surface: renderSurface,
                surfaceContext: createSurfaceContextFixture({ mount: {
                    kind: 'destination', destination: { pluginId: 'happier.triage', localId: 'triage' }, container: 'appPage',
                } }),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
                handlers: {
                    publishCurrentUiContext: () => undefined,
                    executeAction: async () => { attempts++; throw failure; },
                    replacePageLocation: ({ subPath }) => subPath,
                },
            });
        });
        mounted.push(fixture);
        await act(async () => { await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope); });
        if (readOnly) {
            const retry = await fixture.getByRole('button', { name: 'Try again' });
            const before = attempts;
            await act(async () => { await fixture.press(retry); });
            expect(attempts).toBeGreaterThan(before);
        } else {
            await expect(fixture.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
        }
    });
});
