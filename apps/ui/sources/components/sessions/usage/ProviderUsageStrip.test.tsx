import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installAgentAssetLoader } from '@/dev/testkit/mocks/agentAssets';
import { renderScreen } from '@/dev/testkit';
import { computeConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { connectedServiceQuotaGaugeFormatter } from './connectedServiceQuotaGaugeFormatter';
import { ProviderUsageStripContent } from './ProviderUsageStrip';

// These presentation tests have no signed-in account or refresh in progress.
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ credentials: null }) }));

// SVG is a native rendering boundary; the actual rings, popup and quota projection stay real.
vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('Svg', props, props.children),
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props),
}));

const now = Date.parse('2026-11-01T12:00:00Z');
function gauge(serviceId: 'anthropic' | 'openai-codex', meterId: string, used: number) {
    const result = computeConnectedServiceQuotaGaugeViewModel({
        snapshot: {
            v: 1, serviceId, profileId: 'work', fetchedAt: now, staleAfterMs: 60_000,
            planLabel: null, accountLabel: 'Work', meters: [{
                meterId, label: meterId, used, limit: 100, unit: 'count', utilizationPct: null,
                resetsAt: now + 3_600_000, status: 'ok', details: {},
            }],
        },
        windowMode: 'most_constrained', nowMs: now, formatter: connectedServiceQuotaGaugeFormatter,
        providerDisplayName: serviceId === 'openai-codex' ? 'Codex' : 'Claude',
    });
    if (!result) throw new Error('Expected a measured usage gauge');
    return result;
}

beforeEach(async () => { await installAgentAssetLoader(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe('ProviderUsageStrip', () => {
    it('toggles every provider together from the whole HUD, including its unused space', async () => {
        const refresh = vi.fn();
        const screen = await renderScreen(<ProviderUsageStripContent
            agentIds={['codex', 'claude']}
            gauges={new Map([['codex', gauge('openai-codex', 'weekly', 100)], ['claude', gauge('anthropic', 'five_hour', 30)]])}
            onRefresh={refresh}
        />);
        expect(screen.findByTestId('agent-input-provider-usage-meter:weekly')).toBeNull();
        const hud = () => screen.findHostByTestId('sessions-provider-usage-strip')!;
        expect(hud().props.accessibilityRole).toBe('button');
        act(() => hud().props.onPress());
        expect(screen.findByTestId('agent-input-provider-usage-meter:weekly')).toBeTruthy();
        expect(screen.findByTestId('agent-input-provider-usage-meter:five_hour')).toBeTruthy();
        expect(screen.findByTestId('agent-input-provider-usage-meter-bar:weekly')).toBeTruthy();
        expect(screen.getTextContent()).toContain('0% left');
        expect(screen.getTextContent()).toContain('70% left');
        expect(screen.getTextContent()).toContain('resets in');
        expect(screen.getTextContent()).toContain('Codex usage');
        expect(screen.getTextContent()).toContain('Claude usage');
        expect(refresh).toHaveBeenCalledWith('codex');
        // A second tap anywhere in the same HUD closes the shared panel.
        act(() => hud().props.onPress());
        expect(screen.findByTestId('agent-input-provider-usage-meter:weekly')).toBeNull();
        act(() => hud().props.onPress());
        expect(screen.findByTestId('agent-input-provider-usage-meter:weekly')).toBeTruthy();
        expect(screen.findByTestId('agent-input-provider-usage-meter:five_hour')).toBeTruthy();
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    it('opens the shared details from a configured provider with no figures', async () => {
        const screen = await renderScreen(<ProviderUsageStripContent
            agentIds={['codex', 'claude']}
            gauges={new Map([['codex', gauge('openai-codex', 'weekly', 10)]])}
            onRefresh={vi.fn()}
        />);
        act(() => screen.findHostByTestId('sessions-provider-usage-strip')!.props.onPress());
        expect(screen.findByTestId('agent-input-provider-usage-meter:weekly')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Claude');
        expect(screen.getTextContent()).toContain('Unavailable');
    });
});
