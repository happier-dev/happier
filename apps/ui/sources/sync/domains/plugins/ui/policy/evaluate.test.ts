import { describe, expect, it } from 'vitest';

import {
    evaluatePluginUiPolicy,
    evaluatePluginUiPredicate,
    isPluginUiPolicyVisible,
    type PluginUiPolicyEvaluationContext,
} from './evaluate';

const allowAll: PluginUiPolicyEvaluationContext = {
    platform: 'web',
    channel: 'internal',
    isFeatureEnabled: () => true,
    isPermissionGranted: () => true,
    isCapabilityEnabled: () => true,
};

describe('evaluatePluginUiPredicate', () => {
    it('treats a missing predicate as satisfied', () => {
        expect(evaluatePluginUiPredicate(undefined, allowAll)).toBe(true);
        expect(evaluatePluginUiPredicate(null, allowAll)).toBe(true);
    });

    it('evaluates feature.enabled against the context resolver', () => {
        const predicate = { operand: 'feature.enabled', value: 'plugins.ui' } as const;
        expect(evaluatePluginUiPredicate(predicate, { isFeatureEnabled: (id) => id === 'plugins.ui' })).toBe(true);
        expect(evaluatePluginUiPredicate(predicate, { isFeatureEnabled: () => false })).toBe(false);
        // fail-closed when no resolver is supplied
        expect(evaluatePluginUiPredicate(predicate, {})).toBe(false);
    });

    it('evaluates platform.is against the render platform', () => {
        const predicate = { operand: 'platform.is', values: ['web', 'desktop'] } as const;
        expect(evaluatePluginUiPredicate(predicate, { platform: 'web' })).toBe(true);
        expect(evaluatePluginUiPredicate(predicate, { platform: 'ios' })).toBe(false);
        expect(evaluatePluginUiPredicate(predicate, {})).toBe(false);
    });

    it('composes all / any / not', () => {
        const all = {
            all: [
                { operand: 'feature.enabled', value: 'plugins.ui' },
                { operand: 'platform.is', value: 'web' },
            ],
        };
        expect(evaluatePluginUiPredicate(all, allowAll)).toBe(true);
        expect(evaluatePluginUiPredicate(all, { ...allowAll, platform: 'ios' })).toBe(false);

        const any = {
            any: [
                { operand: 'feature.enabled', value: 'never' },
                { operand: 'platform.is', value: 'web' },
            ],
        };
        expect(evaluatePluginUiPredicate(any, { ...allowAll, isFeatureEnabled: () => false })).toBe(true);

        const not = { not: { operand: 'platform.is', value: 'ios' } };
        expect(evaluatePluginUiPredicate(not, { platform: 'web' })).toBe(true);
        expect(evaluatePluginUiPredicate(not, { platform: 'ios' })).toBe(false);
    });

    it('resolves data-shaped operands against the data context', () => {
        const predicate = { operand: 'session.hasBackend' } as const;
        expect(
            evaluatePluginUiPredicate(predicate, { data: { session: { hasBackend: true } } }),
        ).toBe(true);
        expect(
            evaluatePluginUiPredicate(predicate, { data: { session: { hasBackend: false } } }),
        ).toBe(false);
    });
});

describe('evaluatePluginUiPolicy', () => {
    it('fails closed for a missing entry', () => {
        const decision = evaluatePluginUiPolicy(null, allowAll);
        expect(decision.visible).toBe(false);
        expect(decision.enabled).toBe(false);
    });

    it('renders an entry with no declared policy', () => {
        const decision = evaluatePluginUiPolicy(
            { id: 'surfacePlacement:acme.preview:tab', contributionKind: 'surfacePlacement' },
            allowAll,
        );
        expect(decision.visible).toBe(true);
        expect(decision.enabled).toBe(true);
        expect(decision.diagnostics).toEqual([]);
    });

    it('hides an entry whose featureGate is disabled and renders it when enabled', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:tab',
            contributionKind: 'surfacePlacement',
            featureGate: 'plugins.ui.hostedWeb',
        };
        expect(
            evaluatePluginUiPolicy(entry, { isFeatureEnabled: () => false }).visible,
        ).toBe(false);
        expect(
            evaluatePluginUiPolicy(entry, { isFeatureEnabled: (id) => id === 'plugins.ui.hostedWeb' }).visible,
        ).toBe(true);
    });

    it('evaluates the visibility predicate to gate render (not hide because it is declared)', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:tab',
            contributionKind: 'surfacePlacement',
            visibility: { operand: 'platform.is', values: ['web'] },
        };
        expect(evaluatePluginUiPolicy(entry, { platform: 'web' }).visible).toBe(true);
        expect(evaluatePluginUiPolicy(entry, { platform: 'ios' }).visible).toBe(false);
    });

    it('evaluates the enabled predicate as a disabled-but-visible state', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:tab',
            contributionKind: 'surfacePlacement',
            enabled: { operand: 'feature.enabled', value: 'acme.cap' },
        };
        const enabledDecision = evaluatePluginUiPolicy(entry, { isFeatureEnabled: () => true });
        expect(enabledDecision.visible).toBe(true);
        expect(enabledDecision.enabled).toBe(true);

        const disabledDecision = evaluatePluginUiPolicy(entry, { isFeatureEnabled: () => false });
        expect(disabledDecision.visible).toBe(true);
        expect(disabledDecision.enabled).toBe(false);
    });

    it('honors compatibility platform/channel gates', () => {
        const entry = {
            id: 'surfacePlacement:acme.preview:tab',
            contributionKind: 'surfacePlacement',
            compatibility: { platforms: ['desktop'], channels: ['internal'] },
        };
        expect(evaluatePluginUiPolicy(entry, { platform: 'desktop', channel: 'internal' }).visible).toBe(true);
        expect(evaluatePluginUiPolicy(entry, { platform: 'web', channel: 'internal' }).visible).toBe(false);
        expect(evaluatePluginUiPolicy(entry, { platform: 'desktop', channel: 'store' }).visible).toBe(false);
    });

    it('honors browser policy required features, permissions, and profile mode', () => {
        const entry = {
            id: 'browserAction:acme.preview:open',
            contributionKind: 'browserAction',
            policy: {
                requiredFeatureIds: ['browser'],
                requiredPermissionIds: ['network'],
                profileMode: 'session',
            },
        };
        expect(
            isPluginUiPolicyVisible(entry, {
                isFeatureEnabled: () => true,
                isPermissionGranted: () => true,
                profileMode: 'session',
            }),
        ).toBe(true);
        expect(
            isPluginUiPolicyVisible(entry, {
                isFeatureEnabled: () => true,
                isPermissionGranted: () => false,
                profileMode: 'session',
            }),
        ).toBe(false);
        expect(
            isPluginUiPolicyVisible(entry, {
                isFeatureEnabled: () => true,
                isPermissionGranted: () => true,
                profileMode: 'ephemeral',
            }),
        ).toBe(false);
    });

    it('evaluates canonical contribution availability and fails closed when a fact is unavailable', () => {
        const entry = {
            id: 'browserAction:acme.preview:open',
            contributionKind: 'browserAction',
            availability: {
                when: {
                    all: [
                        { fact: 'host.platform', operator: 'notEquals', value: 'ios' },
                        { fact: 'browser.exists', operator: 'equals', value: true },
                    ],
                },
                disabledWhen: { fact: 'host.feature', operator: 'enabled', value: 'preview.readOnly' },
                disabledReason: 'Preview is read-only',
            },
        };

        expect(evaluatePluginUiPolicy(entry, {
            platform: 'web',
            data: { browser: { exists: true } },
            isFeatureEnabled: () => false,
        })).toMatchObject({ visible: true, enabled: true });
        expect(evaluatePluginUiPolicy(entry, {
            platform: 'web',
            data: { browser: { exists: true } },
            isFeatureEnabled: (id) => id === 'preview.readOnly',
        })).toMatchObject({ visible: true, enabled: false });
        expect(evaluatePluginUiPolicy(entry, {
            platform: 'ios',
            data: { browser: { exists: true } },
            isFeatureEnabled: () => false,
        })).toMatchObject({ visible: false, enabled: false });
        expect(evaluatePluginUiPolicy(entry, {
            platform: 'web',
            isFeatureEnabled: () => false,
        })).toMatchObject({ visible: false, enabled: false });

        expect(evaluatePluginUiPolicy({
            id: 'browserAction:acme.preview:unknown-gate',
            contributionKind: 'browserAction',
            availability: {
                disabledWhen: { fact: 'host.feature', operator: 'enabled', value: 'preview.readOnly' },
                disabledReason: 'Preview is read-only',
            },
        }, {
            platform: 'web',
        })).toMatchObject({
            visible: true,
            enabled: false,
            diagnostics: ['availability_disabled_fact_unavailable'],
        });
    });

    it('treats a literal boolean enabled flag (browser action schema) as the enabled state', () => {
        const decision = evaluatePluginUiPolicy(
            { id: 'browserAction:acme.preview:open', contributionKind: 'browserAction', enabled: false },
            allowAll,
        );
        expect(decision.visible).toBe(true);
        expect(decision.enabled).toBe(false);
    });
});
