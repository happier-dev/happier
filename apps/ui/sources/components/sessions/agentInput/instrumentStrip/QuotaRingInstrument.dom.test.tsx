/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { writeProviderAccountUsageRecordIdToMetadata } from '@happier-dev/protocol/sessions/metadata/providerAccountUsageRefsV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal),
);

const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { QuotaRingInstrument } = await import('./QuotaRingInstrument');
const { t } = await import('@/text');
const { motionTokens } = await import('@/components/ui/motion');
type ViewModel = NonNullable<React.ComponentProps<typeof QuotaRingInstrument>['viewModel']>;

const VIEW_MODEL = {
    serviceId: null,
    providerDisplayName: 'Claude',
    activeAccountDisplayLabel: null,
    remainingPct: 60,
    usedPct: 40,
    primaryValueSemantics: 'remaining',
    valueLabel: '60% left',
    ringValueLabel: '60',
    badgeLabel: '60% left',
    scopePrefix: null,
    detailRightLabel: 'Resets in 2h',
    usedLimitLabel: null,
    resetLabel: null,
    tone: 'neutral',
    isStale: false,
    effectiveMeter: {} as ViewModel['effectiveMeter'],
    allMeterRows: [],
    usageRings: [],
    recoveryCreditSummary: null,
} satisfies ViewModel;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderRing(props: Partial<React.ComponentProps<typeof QuotaRingInstrument>> = {}) {
    await act(async () => {
        root.render(<InjectedAuthProvider credentials={null}>
            <QuotaRingInstrument viewModel={VIEW_MODEL} showProviderGlyph={false} {...props} />
        </InjectedAuthProvider>);
    });
    return container.querySelector<HTMLElement>('[data-testid="session-instrument-quota-ring"]')!;
}

// React derives pointerenter/leave from pointerover/out; jsdom may lack PointerEvent itself.
const pointerEnter = (el: Element) => el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }));
const pointerLeave = (el: Element) => el.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
const popover = () => document.body.querySelector<HTMLElement>('[data-testid="session-instrument-quota-popover"]');
const rest = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

describe('QuotaRingInstrument', () => {
    beforeEach(() => {
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
        window.dispatchEvent(new Event('resize'));
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 400, y: 700, width: 16, height: 16, top: 700, left: 400, right: 416, bottom: 716, toJSON: () => ({}),
        });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('says what is left beside the ring at every width, so a compact strip never shows a bare number', async () => {
        const text = (testID: string) => container.querySelector(`[data-testid="${testID}"]`)?.textContent ?? null;

        await renderRing({ showProviderGlyph: true });
        // A bare number in a ring beside the context gauge's "0%" reads as another percentage used.
        expect(text('session-instrument-quota-ring-value')).toBe('60% left');

        // Live 2026-10-16 (PLUGVIS r2l): under 360 px a bare "9" in a red ring explained nothing.
        await renderRing({ showProviderGlyph: false });
        expect(text('session-instrument-quota-ring-value')).toBe('60% left');
    });

    it('shows one remaining-first ring and names each pinned extra ring', async () => {
        const pinnedViewModel: ViewModel = {
            ...VIEW_MODEL,
            usageRings: [
                { meterId: 'five_hour', label: '5-hour', usedPct: 40, ringValueLabel: '60', valueLabel: '60% left', tone: 'neutral' },
                { meterId: 'seven_day', label: 'Weekly', usedPct: 90, ringValueLabel: '10', valueLabel: '10% left', tone: 'critical' },
            ],
        };
        const text = (testID: string) => container.querySelector(`[data-testid="${testID}"]`)?.textContent ?? null;

        await renderRing({ showProviderGlyph: true });
        expect(text('session-instrument-quota-ring-value')).toBe('60% left');
        expect(container.querySelector('[data-testid^="session-instrument-quota-ring-value:"]')).toBeNull();
        expect(container.textContent).toContain('Claude');

        await renderRing({ viewModel: pinnedViewModel, showProviderGlyph: true });
        expect(text('session-instrument-quota-ring-value')).toBe('60% left');
        expect(text('session-instrument-quota-ring-value:seven_day')).toBe('10% left');
        expect(container.querySelector('[data-testid="session-instrument-quota-ring"]')!.getAttribute('aria-label'))
            .toContain('Weekly 10% left');
        expect(text('session-instrument-quota-meter-label')).toBe('5-hour');
        expect(text('session-instrument-quota-meter-label:seven_day')).toBe('Weekly');
        expect(container.textContent).toContain('Claude');

        await renderRing({ viewModel: pinnedViewModel, showLabels: true });
        expect(text('session-instrument-quota-meter-label')).toBe('5-hour');
        expect(text('session-instrument-quota-meter-label:seven_day')).toBe('Weekly');
    });

    it.each([false, true])('opens the same quota popover after a failed first read (Retry available: %s)', async (canRetry) => {
        const onRetry = vi.fn();
        const ring = await renderRing({ viewModel: null, onRetry: canRetry ? onRetry : null });
        expect(ring.getAttribute('role')).toBe('button');
        expect(ring.tabIndex).toBe(0);
        expect(ring.getAttribute('aria-label')).toContain(t('usage.board.page.readFailedTitle'));
        ring.focus();
        expect(document.activeElement).toBe(ring);
        // A native button supplies Enter and Space activation. jsdom does not synthesize its click.
        expect(ring.tagName).toBe('BUTTON');
        await act(async () => { ring.click(); });
        expect(popover()?.textContent ?? '').toContain(t('usage.board.page.readFailedTitle'));
        expect(onRetry).not.toHaveBeenCalled();
        const retry = popover()?.querySelector<HTMLElement>('[data-testid="session-instrument-quota-retry"]');
        expect(Boolean(retry)).toBe(canRetry);
        if (retry) {
            await act(async () => { retry.click(); });
            expect(onRetry).toHaveBeenCalledTimes(1);
        }
    });

    const rightAccount = 'fixture-muse-work';
    const otherAccount = 'fixture-muse-other';
    const pool = { source: 'connected', selection: 'group', groupId: 'fixture-pool' } as const;
    const native = { source: 'native' } as const;
    type BindingCase = {
        label: string;
        binding?: ConnectedServiceBindingsV2['bindingsByServiceId'][string];
        secondBinding?: boolean;
        presentation?: 'unavailable' | 'recipient';
        expected: 'connected' | 'native' | 'none';
        otherNative?: boolean;
    };

    it.each<BindingCase>([
        { label: 'opens the exact scalar Muse percent-only row despite a newer neighbor',
            binding: { source: 'connected', selection: 'profile', profileId: rightAccount }, expected: 'connected' },
        { label: 'opens the applied-only Pool member despite a newer neighbor',
            binding: { ...pool, appliedProfileId: rightAccount }, expected: 'connected' },
        { label: 'opens the applied Pool member instead of the authored member',
            binding: { ...pool, appliedProfileId: rightAccount, profileId: otherAccount }, expected: 'connected' },
        { label: 'opens the authored-only Pool member',
            binding: { ...pool, profileId: rightAccount }, expected: 'connected' },
        { label: 'opens the Pool member when authored and applied agree',
            binding: { ...pool, appliedProfileId: rightAccount, profileId: rightAccount }, expected: 'connected' },
        { label: 'shows no instrument when the Pool has no named member', binding: pool, expected: 'none' },
        { label: 'shows no instrument without a readable binding', expected: 'none' },
        { label: 'shows no instrument with multiple connected bindings',
            binding: { source: 'connected', selection: 'profile', profileId: rightAccount }, secondBinding: true, expected: 'none' },
        { label: 'shows no personal instrument for a brokered Team model',
            binding: { source: 'team_resource', resourceId: 'fixture-team-resource', deliveryMode: 'brokered' }, expected: 'none' },
        { label: 'shows no personal instrument for a direct Team resource',
            binding: { source: 'team_resource', resourceId: 'fixture-team-resource', deliveryMode: 'direct',
                disclosedMember: { service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: rightAccount } },
            expected: 'none' },
        { label: 'opens the Session native reading without borrowing the newer connected reading', binding: native, expected: 'native' },
        { label: 'shows no instrument if two native readings could belong to the Session', binding: native, otherNative: true, expected: 'none' },
        { label: 'shows no instrument with explicit unavailable owner metadata',
            binding: { source: 'connected', selection: 'profile', profileId: rightAccount }, presentation: 'unavailable', expected: 'none' },
        { label: 'shows no instrument for a recipient without the owner projection',
            binding: { source: 'connected', selection: 'profile', profileId: rightAccount }, presentation: 'recipient', expected: 'none' },
    ])('$label', async ({ binding, secondBinding, presentation, expected, otherNative }) => {
        const { createSessionFixture, flushHookEffects } = await import('@/dev/testkit');
        const { createQualifiedQuotaTestHarness, quotaTestProviderUsageResponse, quotaTestResponse } =
            await import('@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaTestHarness');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { useSessionProviderUsage } = await import('@/components/sessions/usage/useSessionProviderUsage');
        const { SessionInstrumentStrip } = await import('./SessionInstrumentStrip');
        const agentId = 'happier.agent.muse/muse';
        const ref = { service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: rightAccount };
        const source = { bindingKind: 'account' as const, ref };
        const serviceKey = buildQualifiedPluginContributionKey(ref.service);
        const now = Date.now();
        const recordKey = { providerId: 'meta', accountSubjectId: 'fixture-muse-subject', subjectKind: 'account', quotaScope: 'account' } as const;
        const record = ProviderAccountUsageSnapshotV1Schema.parse({
            v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: recordKey.providerId, accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
            observedAtMs: now, fetchedAtMs: now, staleAfterMs: 120_000, source: 'runtimeSignal', confidence: 'confirmed',
            state: 'loaded_data', meters: [{
                meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown',
                utilizationPct: 8, remainingPct: 92, resetsAt: now + 3_600_000, status: 'ok', confidence: 'exact',
            }],
        });
        const otherRef = { ...ref, accountId: otherAccount };
        const otherKey = { ...recordKey, accountSubjectId: 'fixture-muse-other-subject' };
        const other = ProviderAccountUsageSnapshotV1Schema.parse({
            ...record, recordKey: otherKey, recordId: buildProviderAccountUsageRecordId(otherKey),
            accountSubject: { kind: 'providerSubject', id: otherKey.accountSubjectId },
            observedAtMs: now + 1, fetchedAtMs: now + 1,
            meters: record.meters.map(meter => ({ ...meter, utilizationPct: 30, remainingPct: 70 })),
        });
        const metadata = writeProviderAccountUsageRecordIdToMetadata({
            ...createSessionFixture().metadata,
            flavor: agentId,
            ...(binding ? {
                connectedServices: {
                    v: 2,
                    bindingsByServiceId: {
                        [serviceKey]: binding,
                        ...(secondBinding ? { 'happier.agent.claude/claude-subscription': {
                            source: 'connected', selection: 'profile', profileId: 'fixture-claude',
                        } } : {}),
                    },
                },
            } : {}),
        }, { recordId: record.recordId, updatedAtMs: now });
        const parsedMetadata = MetadataSchema.parse(writeProviderAccountUsageRecordIdToMetadata(
            metadata, { recordId: other.recordId, updatedAtMs: now + 1 },
        ));
        const session = createSessionFixture({
            metadata: parsedMetadata,
            ...(presentation === 'unavailable' ? { ownerMetadataView: null } : {}),
            ...(presentation === 'recipient' ? {
                accessLevel: 'view', metadataLayoutVersion: 1, ownerMetadataView: null,
            } : {}),
        });
        const boundary = await createQualifiedQuotaTestHarness({
            request: async (input) => new URL(String(input)).pathname === '/v4/connect/qualified/provider-account-usage/sources/resolve'
                ? Response.json({ source, recordId: record.recordId, providerAccountId: recordKey.accountSubjectId,
                    fetchedAt: record.fetchedAtMs, staleAfterMs: record.staleAfterMs })
                : null,
        });
        try {
            const serverId = getActiveServerSnapshot().serverId;
            await getServerFeaturesSnapshot({ serverId, force: true });
            boundary.read.mockImplementation(async account => {
                const reading = account.accountId === ref.accountId ? record : other;
                const response = quotaTestResponse({
                    v: 1, ref: account, activeAccountId: reading.recordKey.accountSubjectId, fetchedAt: reading.fetchedAtMs,
                    staleAfterMs: reading.staleAfterMs, planLabel: null, accountLabel: null, meters: reading.meters,
                });
                return Response.json({ ...response, sourceResolution: { ...response.sourceResolution, recordId: reading.recordId } });
            });
            boundary.usageRead.mockImplementation(async (recordId) => {
                if (recordId === record.recordId) {
                    return Response.json({ ...quotaTestProviderUsageResponse(record), sources: binding?.source === 'native' ? [] : [source] });
                }
                expect(recordId).toBe(other.recordId);
                return Response.json({ ...quotaTestProviderUsageResponse(other), sources: otherNative ? [] : [{ ...source, ref: otherRef }] });
            });
            storage.getState().applySettingsLocal({ featureToggles: { connectedServices: true, 'connectedServices.quotas': true } });
            storage.getState().applyProfile({
                ...storage.getState().profile,
                connectedAccountsV4: [ref, otherRef].map(account => ({
                    ref: account, status: 'connected', authenticationModeId: 'device', revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true, configurationRevision: null, scopes: [],
                })),
            });
            const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
            function ComposerQuota() {
                const { gauge } = useSessionProviderUsage({ session, serverId, agentId, activeModelId: null });
                return <SessionInstrumentStrip agentId={agentId} metadata={readSessionOwnerMetadataView(session)}
                    quota={gauge ? { viewModel: gauge } : null} />;
            }
            await act(async () => root.render(
                <InjectedAuthProvider credentials={boundary.account.credentials}><ComposerQuota /></InjectedAuthProvider>,
            ));
            await act(async () => { await flushHookEffects({ cycles: 16, turns: 16 }); });
            expect(boundary.requests.filter(request => request.path.endsWith('/sources/resolve'))).toHaveLength(0);
            const instrument = container.querySelector<HTMLElement>('[data-testid="session-instrument-quota-ring"]');
            if (expected === 'none') {
                expect(instrument?.textContent ?? null).toBeNull();
                if (binding?.source !== 'native') expect(boundary.usageRead).not.toHaveBeenCalled();
                return;
            }
            expect(boundary.usageRead.mock.calls).toEqual(expect.arrayContaining([[record.recordId], [other.recordId]]));
            expect(instrument?.textContent).toContain('92% left');
            await act(async () => { instrument!.click(); });
            await act(async () => { await flushHookEffects({ cycles: 16, turns: 16 }); });
            const panel = popover();
            expect(panel).not.toBeNull();
            const accountRow = (profileId: string) => panel?.querySelector(
                `[data-testid="sidebar-usage-account-${connectedServiceProfileKey({ serviceId: serviceKey, profileId })}"]`,
            );
            expect(accountRow(otherRef.accountId)).toBeNull();
            if (expected === 'connected') {
                expect(accountRow(ref.accountId)?.textContent).toContain('92%');
            } else {
                expect(accountRow(ref.accountId)).toBeNull();
                expect(panel?.textContent).toContain('92%');
            }
        } finally {
            await act(async () => root.render(null));
            await boundary.dispose();
        }
    }, 60_000);

    it('previews after the pointer rests on the ring, not while it passes over it', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const ring = await renderRing();

        await act(async () => { pointerEnter(ring); });
        await rest(motionTokens.overlay.popover.hoverOpenDelayMs - 50);
        expect(popover()).toBeNull();
        await act(async () => { pointerLeave(ring); });
        await rest(1000);
        expect(popover()).toBeNull();

        await act(async () => { pointerEnter(ring); });
        await rest(motionTokens.overlay.popover.hoverOpenDelayMs + 10);
        expect(popover()).not.toBeNull();
        expect(popover()!.contains(document.activeElement)).toBe(false);
    });

    it('stays open while the pointer crosses from the ring into the popover, and closes after it leaves', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const ring = await renderRing();
        await act(async () => { pointerEnter(ring); });
        await rest(motionTokens.overlay.popover.hoverOpenDelayMs + 10);

        await act(async () => { pointerLeave(ring); });
        await rest(motionTokens.durationMs.fast / 2);
        await act(async () => { pointerEnter(popover()!); });
        await rest(1000);
        expect(popover()).not.toBeNull();

        await act(async () => { pointerLeave(popover()!); });
        await rest(1000);
        expect(popover()).toBeNull();
    });

    it('pins on press: leaving no longer closes it, and a second press closes it', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const ring = await renderRing();
        await act(async () => { pointerEnter(ring); });
        await rest(motionTokens.overlay.popover.hoverOpenDelayMs + 10);

        await act(async () => { ring.click(); });
        await act(async () => { pointerLeave(ring); });
        await rest(1000);
        expect(popover()).not.toBeNull();

        await act(async () => { ring.click(); });
        expect(popover()).toBeNull();
    });
});
