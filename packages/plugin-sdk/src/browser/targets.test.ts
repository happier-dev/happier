import { describe, expect, it } from 'vitest';

import { defineBrowserAction, defineBrowserTarget } from './index.js';

const display = {
    title: 'Preview',
    iconToken: 'browser',
    tone: 'info',
} as const;

const target = {
    kind: 'hostedPluginWeb',
    targetId: 'target_1',
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    display,
} as const;

describe('browser SDK helpers', () => {
    it('defines browser targets and actions without exposing browser internals', () => {
        const browserTarget = defineBrowserTarget({
            id: 'preview-target',
            target,
            display,
            featureGate: 'browser.viewTargets',
        });

        const action = defineBrowserAction({
            id: 'open-preview',
            kind: 'openTarget',
            target,
            display,
            policy: {
                requiredFeatureIds: ['browser.viewTargets'],
                profileMode: 'session',
            },
        });

        expect(browserTarget.target.kind).toBe('hostedPluginWeb');
        expect(action.policy.requiredFeatureIds).toEqual(['browser.viewTargets']);
    });

    it('rejects attempts to define browser chrome or adapter internals', () => {
        expect(() => defineBrowserAction({
            id: 'bad-browser-action',
            kind: 'openTarget',
            target,
            display,
            chrome: { hideAddressBar: true },
        } as never)).toThrow();
    });
});
