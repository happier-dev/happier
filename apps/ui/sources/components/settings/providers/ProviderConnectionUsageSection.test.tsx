import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderUsageSourceV1Schema } from '@happier-dev/protocol/providers/contributions';
import { createProviderErrorV1, type ProviderErrorCodeV1 } from '@happier-dev/protocol/providers/errors';
import { DaemonProviderUsageRefreshResponseV1Schema } from '@happier-dev/protocol/rpc';
import { formatUsageCost } from '@happier-dev/protocol/usage/usageFormatting';

import { ItemList } from '@/components/ui/lists/ItemList';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { presentProviderConnectionUsage } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';

import { ProviderConnectionUsageSectionView } from './ProviderConnectionUsageSection';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const keySource = ProviderUsageSourceV1Schema.parse({
    id: 'key-usage', endpointTemplateId: 'chat', path: '/api/v1/key', parser: 'key',
});
const creditSource = ProviderUsageSourceV1Schema.parse({
    id: 'account-credits', endpointTemplateId: 'chat', path: '/api/v1/credits', parser: 'credits',
    billingCredential: { slotId: 'managementKey', title: 'Management key', keyUrl: 'https://example.com/keys',
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } },
});

/** A refresh that answered, with one failed source per entry, exactly as the daemon reports it. */
function failedRefresh(failures: Readonly<Record<string, ProviderErrorCodeV1>>) {
    return presentProviderConnectionUsage({
        sources: [keySource, creditSource],
        isBillingSlotBound: () => true,
        view: {
            result: DaemonProviderUsageRefreshResponseV1Schema.parse({
                status: 'success',
                sources: Object.entries(failures).map(([sourceId, code]) => ({ sourceId, status: 'error', error: createProviderErrorV1(code, {}) })),
            }),
            snapshotsBySourceId: {},
            stateBySourceId: {},
        },
    });
}

async function renderSection(
    presentation: ReturnType<typeof presentProviderConnectionUsage>,
    handlers: Readonly<{ onChooseApiKey?: (() => void) | null; onChooseBillingKey?: ((slotId: string) => void) | null }> = {},
) {
    const refresh = vi.fn();
    const onChooseApiKey = handlers.onChooseApiKey === undefined ? vi.fn() : handlers.onChooseApiKey;
    const onChooseBillingKey = handlers.onChooseBillingKey === undefined ? vi.fn() : handlers.onChooseBillingKey;
    const screen = await renderScreen(
        <ItemList>
            <ProviderConnectionUsageSectionView
                providerName="OpenRouter" presentation={presentation} refreshing={false} failed={false}
                refresh={refresh} onOpenApproval={null} isBillingKeySaved={() => true}
                onChooseBillingKey={onChooseBillingKey} onChooseApiKey={onChooseApiKey}
            />
        </ItemList>,
    );
    return { screen, refresh, onChooseApiKey, onChooseBillingKey };
}

const KEY_ACTION = 'provider-connection-usage:error:key-usage:action';
const CREDITS_ACTION = 'provider-connection-usage:error:account-credits:action';
const actionTitle = (screen: Awaited<ReturnType<typeof renderSection>>['screen'], testID: string) =>
    screen.findByTestId(testID)?.props.accessibilityLabel;

describe('ProviderConnectionUsageSectionView failure recovery', () => {
    it('formats explicit CNY and legacy USD without conversion, preserving a negative balance', async () => {
        const base = failedRefresh({});
        const presentation = { ...base, groups: [{ scope: 'account' as const, meters: [
            { meterId: 'cny', label: 'Balance (CNY)', unit: 'usd' as const, currency: 'CNY',
                amount: { kind: 'remaining' as const, remaining: -0.0123 }, remainingPct: null, tone: 'danger' as const, estimated: false },
            { meterId: 'usd', label: 'Legacy USD', unit: 'usd' as const,
                amount: { kind: 'used' as const, used: 1.25 }, remainingPct: null, tone: 'neutral' as const, estimated: false },
        ] }] };
        const { screen } = await renderSection(presentation);
        const rendered = screen.getTextContent();
        expect(rendered).toContain(`−${formatUsageCost(0.0123, 'CNY')}`);
        expect(rendered).toContain(formatUsageCost(1.25, 'USD'));
    });
    it('takes a missing API key to the API key picker instead of offering a Retry that cannot help', async () => {
        const { screen, refresh, onChooseApiKey } = await renderSection(failedRefresh({ 'key-usage': 'provider_secret_missing' }));
        expect(actionTitle(screen, KEY_ACTION)).toBe('Add key');
        await screen.pressByTestIdAsync(KEY_ACTION);
        expect(onChooseApiKey).toHaveBeenCalledOnce();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('takes a rejected billing key to its own slot, and a transient failure beside it keeps the one Retry', async () => {
        const { screen, refresh, onChooseApiKey, onChooseBillingKey } = await renderSection(
            failedRefresh({ 'key-usage': 'provider_endpoint_rate_limited', 'account-credits': 'provider_endpoint_unauthorized' }),
        );
        expect(actionTitle(screen, KEY_ACTION)).toBe('Retry');
        expect(actionTitle(screen, CREDITS_ACTION)).toBe('Replace');
        await screen.pressByTestIdAsync(CREDITS_ACTION);
        expect(onChooseBillingKey).toHaveBeenCalledWith('managementKey', undefined);
        await screen.pressByTestIdAsync(KEY_ACTION);
        expect(refresh).toHaveBeenCalledOnce();
        expect(onChooseApiKey).not.toHaveBeenCalled();
    });

    it('keeps Retry on the first failure that no key picker answers when an earlier one needs a key', async () => {
        const { screen, refresh } = await renderSection(
            failedRefresh({ 'key-usage': 'provider_secret_missing', 'account-credits': 'provider_endpoint_unreachable' }),
        );
        expect(actionTitle(screen, KEY_ACTION)).toBe('Add key');
        expect(actionTitle(screen, CREDITS_ACTION)).toBe('Retry');
        await screen.pressByTestIdAsync(CREDITS_ACTION);
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('still offers Retry for a non-key failure, and when the connection has no key picker to open', async () => {
        const transient = await renderSection(failedRefresh({ 'key-usage': 'provider_endpoint_unreachable' }));
        expect(actionTitle(transient.screen, KEY_ACTION)).toBe('Retry');
        await transient.screen.pressByTestIdAsync(KEY_ACTION);
        expect(transient.refresh).toHaveBeenCalledOnce();
        expect(transient.onChooseApiKey).not.toHaveBeenCalled();

        const noPicker = await renderSection(failedRefresh({ 'key-usage': 'provider_secret_missing' }), { onChooseApiKey: null });
        expect(actionTitle(noPicker.screen, KEY_ACTION)).toBe('Retry');
    });

    it('takes a connection-level missing key to the API key picker too', async () => {
        const presentation = presentProviderConnectionUsage({
            sources: [keySource], isBillingSlotBound: () => true,
            view: {
                result: DaemonProviderUsageRefreshResponseV1Schema.parse({ status: 'error', error: createProviderErrorV1('provider_secret_missing', {}) }),
                snapshotsBySourceId: {}, stateBySourceId: {},
            },
        });
        const { screen, refresh, onChooseApiKey } = await renderSection(presentation);
        await screen.pressByTestIdAsync('provider-connection-usage:error:action');
        expect(onChooseApiKey).toHaveBeenCalledOnce();
        expect(refresh).not.toHaveBeenCalled();
    });
});
