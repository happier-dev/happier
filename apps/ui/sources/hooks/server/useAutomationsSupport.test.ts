import { afterEach, describe, expect, it, vi } from 'vitest';

const useFeatureDecisionMock = vi.fn();

vi.mock('./useFeatureDecision', () => ({
    useFeatureDecision: (...args: any[]) => useFeatureDecisionMock(...args),
}));

afterEach(() => {
    useFeatureDecisionMock.mockReset();
    vi.resetModules();
});

describe('useAutomationsSupport', () => {
    it('reports loading while the feature decision is unresolved', async () => {
        useFeatureDecisionMock.mockReturnValue(null);

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        expect(useAutomationsSupport()).toMatchObject({
            enabled: false,
            loading: true,
            discoverable: true,
            blockedBy: null,
            blockerCode: null,
        });
    });

    it('keeps automations discoverable when only local policy blocks them', async () => {
        useFeatureDecisionMock.mockReturnValue({
            state: 'disabled',
            blockedBy: 'local_policy',
            blockerCode: 'toggle_off',
        });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        expect(useAutomationsSupport()).toMatchObject({
            enabled: false,
            loading: false,
            discoverable: true,
            blockedBy: 'local_policy',
            blockerCode: 'toggle_off',
        });
    });

    it('returns enabled when the feature decision is enabled', async () => {
        useFeatureDecisionMock.mockReturnValue({
            state: 'enabled',
            blockedBy: null,
            blockerCode: null,
        });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        expect(useAutomationsSupport()).toMatchObject({
            enabled: true,
            loading: false,
            discoverable: true,
            blockedBy: null,
            blockerCode: null,
        });
    });

    it('hides automations when the server blocks the feature', async () => {
        useFeatureDecisionMock.mockReturnValue({
            state: 'unsupported',
            blockedBy: 'server',
            blockerCode: 'disabled_on_server',
        });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        expect(useAutomationsSupport()).toMatchObject({
            enabled: false,
            loading: false,
            discoverable: false,
            blockedBy: 'server',
            blockerCode: 'disabled_on_server',
        });
    });

    it('fails closed when probing the feature fails', async () => {
        useFeatureDecisionMock.mockReturnValue({
            state: 'unknown',
            blockedBy: null,
            blockerCode: 'probe_failed',
        });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');

        expect(useAutomationsSupport()).toMatchObject({
            enabled: false,
            loading: false,
            discoverable: false,
            blockedBy: null,
            blockerCode: 'probe_failed',
        });
    });

    it('passes scope through to useFeatureDecision', async () => {
        useFeatureDecisionMock.mockReturnValue({
            state: 'enabled',
            blockedBy: null,
            blockerCode: null,
        });

        const { useAutomationsSupport } = await import('./useAutomationsSupport');
        const scope = { scopeKind: 'spawn', serverId: 'srv_123' } as const;

        useAutomationsSupport(scope as any);

        expect(useFeatureDecisionMock).toHaveBeenCalledWith('automations', scope);
    });
});
