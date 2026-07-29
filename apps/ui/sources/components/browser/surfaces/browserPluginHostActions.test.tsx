import { describe, expect, it, vi } from 'vitest';

import {
    resolveExpectedHostActionPolicyOwner,
    resolveRuntimeActionHostEffectClass,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import { createBrowserPanelPluginSurfaceHostApi, toLocalServicePreviewPlatform } from './browserPluginHostActions';

const ACTION_ID = 'browser.reload';
const POLICY_OWNER = resolveExpectedHostActionPolicyOwner(ACTION_ID);
const EFFECT = resolveRuntimeActionHostEffectClass(ACTION_ID);

const focusedTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
} as const;

function createPlacement(overrides?: Readonly<Record<string, unknown>>) {
    return {
        id: 'surfacePlacement:acme.browser:panel',
        pluginId: 'acme.browser',
        contributionKind: 'surfacePlacement',
        descriptorId: 'panel',
        placement: 'browser.panel',
        target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
        renderer: { kind: 'hostedWeb', contributionId: 'panel' },
        display: { label: 'Browser panel' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        hostActions: [
            {
                actionId: ACTION_ID,
                placement: 'browser.panel',
                scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
                policyOwner: POLICY_OWNER,
                effect: EFFECT,
                requiredFeatureIds: ['browser.control'],
                requiredPermissionIds: [],
            },
        ],
        ...overrides,
    } as never;
}

function dispatchRequest(
    payload: PluginUiJsonValueV1 = { actionId: ACTION_ID, input: { reason: 'manual' } },
): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1 as const,
        requestId: 'req_1',
        surface: {
            pluginId: 'acme.browser',
            contributionId: 'panel',
            surfaceId: 'surfacePlacement:acme.browser:panel',
            placement: 'browserSurface' as const,
            platform: 'web' as const,
            channel: 'internal' as const,
            resourceScope: [],
            diagnostics: [],
        },
        method: 'dispatchAction' as const,
        payload,
    };
}

describe('createBrowserPanelPluginSurfaceHostApi dispatch', () => {
    it('routes a revalidated declared action through the runtimeActionExecute bridge', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true, result: { reloaded: true } }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement(),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest());

        expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
        expect(runtimeActionExecute).toHaveBeenCalledWith(expect.objectContaining({
            actionId: ACTION_ID,
            input: { reason: 'manual' },
        }));
        expect(result).toMatchObject({ ok: true });
    });

    it('denies at dispatch when a required feature is no longer enabled even though the descriptor declares it', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement(),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => false,
        });

        const result = await api.handleRequest(dispatchRequest());

        expect(runtimeActionExecute).not.toHaveBeenCalled();
        expect(result).toMatchObject({ state: 'unavailable' });
        expect(String((result as { reason?: string }).reason)).toContain('denied');
    });

    it('fails closed for a legacy action with required permission ids', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement({
                hostActions: [{
                    actionId: ACTION_ID,
                    placement: 'browser.panel',
                    scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
                    policyOwner: POLICY_OWNER,
                    effect: EFFECT,
                    requiredFeatureIds: [],
                    requiredPermissionIds: ['browser.control.execute'],
                }],
            }),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest());

        expect(runtimeActionExecute).not.toHaveBeenCalled();
        expect(String((result as { reason?: string }).reason)).toContain('denied');
    });

    it('denies at dispatch when no browser view is focused (scope mismatch)', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget: null,
            placement: createPlacement(),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest());

        expect(runtimeActionExecute).not.toHaveBeenCalled();
        expect(String((result as { reason?: string }).reason)).toContain('denied');
    });

    it('routes a browserView-scoped action whose input viewId matches the focused target', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true, result: { reloaded: true } }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement(),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest({
            actionId: ACTION_ID,
            input: { browserSessionId: 'bs_1', viewId: 'browser_view:preview_1' },
        }));

        expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: true });
    });

    it('denies a browserView-scoped action whose input viewId targets a non-focused view', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement(),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest({
            actionId: ACTION_ID,
            input: { browserSessionId: 'bs_1', viewId: 'browser_view:preview_2' },
        }));

        expect(runtimeActionExecute).not.toHaveBeenCalled();
        expect(result).toMatchObject({ state: 'unavailable' });
        expect(String((result as { reason?: string }).reason)).toContain('denied_scope_mismatch');
    });

    it('denies at dispatch when the descriptor policy owner does not match the canonical resolver', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement({
                hostActions: [
                    {
                        actionId: ACTION_ID,
                        placement: 'browser.panel',
                        scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
                        policyOwner: 'LSV',
                        effect: EFFECT,
                        requiredFeatureIds: [],
                        requiredPermissionIds: [],
                    },
                ],
            }),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest());

        expect(runtimeActionExecute).not.toHaveBeenCalled();
        expect(String((result as { reason?: string }).reason)).toContain('denied');
    });

    it('stays fail-closed with no bridge supplied (default posture preserved)', async () => {
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement(),
            platform: 'desktop',
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest());

        expect(result).toMatchObject({
            reason: 'browser_panel_host_action_handler_unavailable',
        });
    });

    it('returns not-declared for an action id the placement does not declare', async () => {
        const runtimeActionExecute = vi.fn(async () => ({ ok: true }));
        const api = createBrowserPanelPluginSurfaceHostApi({
            focusedTarget,
            placement: createPlacement(),
            platform: 'desktop',
            runtimeActionExecute,
            isFeatureEnabled: () => true,
        });

        const result = await api.handleRequest(dispatchRequest({ actionId: 'browser.navigate' }));

        expect(runtimeActionExecute).not.toHaveBeenCalled();
        expect(result).toMatchObject({ reason: 'browser_panel_host_action_not_declared' });
    });
});

describe('toLocalServicePreviewPlatform', () => {
    it('passes every platform through unchanged, including desktop (finding #13 / Phase 5.5)', () => {
        // The historical `desktop -> 'web'` downgrade is removed now that LocalServicePreviewPlatform
        // can represent `desktop`; a desktop plugin surface keeps its desktop identity.
        expect(toLocalServicePreviewPlatform('desktop')).toBe('desktop');
        expect(toLocalServicePreviewPlatform('web')).toBe('web');
        expect(toLocalServicePreviewPlatform('ios')).toBe('ios');
        expect(toLocalServicePreviewPlatform('android')).toBe('android');
    });
});
