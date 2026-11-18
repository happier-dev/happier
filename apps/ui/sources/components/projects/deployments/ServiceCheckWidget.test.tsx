import { afterEach, expect, it } from 'vitest';
import * as React from 'react';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  createKeyFlowFixture,
  createServiceCheckRowFixture,
} from '@/dev/testkit/fixtures/serviceCheckRowFixtures';
import {
  WidgetFrameBodyCaptionContext,
  WidgetFrameBodyIdentityContext,
  WidgetFrameBodyMetaContext,
  type WidgetFrameBodyIdentity,
} from '@/components/widgets/frame/widgetFrameBodyCaption';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

// The real sync owner under the canonical Account/RPC boundary; the rows are the managed inventory's own shape.
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { ServiceCheckWidgetBody, ServiceCheckWidgetView } =
  await import('./ServiceCheckWidget');
const { formatServiceCheckLatency } =
  await import('./serviceCheckPresentation');
const { storage } = await import('@/sync/domains/state/storage');
// The app shell's Inbox source boundary, which the managed inventory reads under.
const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
});

const NOW = Date.UTC(2026, 10, 18, 18, 0, 0);
const checkout = createKeyFlowFixture('Checkout', {
  limitMs: 800,
  routes: ['GET /api/cart', 'POST /checkout'],
});
const assist = createKeyFlowFixture('Assist', {
  limitMs: 4000,
  routes: ['POST /api/assist/summarize'],
});

/** What the body lends its frame (title, source line, state), as the shared widget frame receives it. */
function framed(children: React.ReactNode) {
  const lent: {
    identity: WidgetFrameBodyIdentity | null;
    caption: string | null;
    meta: React.ReactNode;
  } = { identity: null, caption: null, meta: null };
  const element = (
    <WidgetFrameBodyIdentityContext.Provider
      value={(identity) => {
        lent.identity = identity;
      }}
    >
      <WidgetFrameBodyCaptionContext.Provider
        value={(caption) => {
          lent.caption = caption;
        }}
      >
        <WidgetFrameBodyMetaContext.Provider
          value={(meta) => {
            lent.meta = meta;
          }}
        >
          {children}
        </WidgetFrameBodyMetaContext.Provider>
      </WidgetFrameBodyCaptionContext.Provider>
    </WidgetFrameBodyIdentityContext.Provider>
  );
  return { element, lent };
}

it('draws a failing Key flow as its measured value against its limit, with its recent bars, and names it in the frame', async () => {
  const row = createServiceCheckRowFixture({
    key: 'checkout',
    keyFlow: checkout,
    state: 'failing',
    failingValue: 1420,
    nowMs: NOW,
  });
  const { element, lent } = framed(
    <ServiceCheckWidgetView
      row={row}
      environmentName="Production"
      testID="w"
    />,
  );
  const screen = await renderScreen(element);
  // A figure keeps its number and unit together (a no-break space), as the shared metric draws it.
  const text = screen.getTextContent().replace(/\u00a0/g, ' ');
  expect(text).toContain(formatServiceCheckLatency(1420));
  expect(text).toContain(formatServiceCheckLatency(800));
  expect(text).toContain('p95');
  expect(screen.findByTestId('w.bars')).not.toBeNull();
  expect(lent.identity?.title).toBe('Checkout');
  expect(lent.caption).toBe('Key flow · Production');
  const meta = await renderScreen(<>{lent.meta}</>);
  expect(meta.getTextContent()).toBe('Failing');
});

it('says a Key flow with no traffic is unknown, with no value, quietly', async () => {
  const row = createServiceCheckRowFixture({
    key: 'assist',
    keyFlow: assist,
    state: 'unknown',
    nowMs: NOW,
  });
  const { element, lent } = framed(
    <ServiceCheckWidgetView
      row={row}
      environmentName="Production"
      testID="w"
    />,
  );
  const screen = await renderScreen(element);
  // A figure keeps its number and unit together (a no-break space), as the shared metric draws it.
  const text = screen.getTextContent().replace(/\u00a0/g, ' ');
  expect(text).toContain('—');
  expect(text).toContain('no requests in');
  expect(text).not.toContain('limit');
  expect(lent.identity?.title).toBe('Assist');
  const meta = await renderScreen(<>{lent.meta}</>);
  expect(meta.getTextContent()).not.toBe('');
});

it('draws any other saved check by its latest response and 30-day uptime, saying nothing while it passes', async () => {
  const row = createServiceCheckRowFixture({
    key: 'site',
    target: 'billing.acme.dev/health',
    state: 'passing',
    nowMs: NOW,
  });
  const { element, lent } = framed(
    <ServiceCheckWidgetView row={row} environmentName={null} testID="w" />,
  );
  const screen = await renderScreen(element);
  // A figure keeps its number and unit together (a no-break space), as the shared metric draws it.
  const text = screen.getTextContent().replace(/\u00a0/g, ' ');
  const latest =
    row.lastResults.kind === 'available'
      ? row.lastResults.checks[0]!.result.latencyMs!
      : 0;
  expect(text).toContain(formatServiceCheckLatency(latest));
  expect(text).toContain('99.98%');
  expect(lent.identity?.title).toBe('billing.acme.dev/health');
  expect(lent.caption).toBe('HTTP');
  expect(lent.meta).toBeNull();
});

it('reads nothing while the widget is not presented, and asks for a check when none is chosen', async () => {
  await account.restore({ serverIdentityId: 'srv_check_widget', machines: [] });
  const scope = storage.getState().settingsScope!;
  const automationReads = () =>
    account.home.requests.filter((request) =>
      request.path.startsWith('/v3/automations'),
    ).length;
  const before = automationReads();
  const hidden = await renderScreen(
    <InboxArtifactSourceBoundary><PluginSurfaceFocusEligibilityProvider active={false}>
      <ServiceCheckWidgetBody
        input={{
          check: {
            serverId: scope.serverId,
            automationId: 'automation-checkout',
            triggerId: 'trigger-1',
          },
        }}
        serverId={scope.serverId}
        testID="w"
      />
    </PluginSurfaceFocusEligibilityProvider></InboxArtifactSourceBoundary>,
  );
  expect(automationReads()).toBe(before);
  hidden.unmount();
  const unbound = await renderScreen(
    <InboxArtifactSourceBoundary><ServiceCheckWidgetBody input={{}} serverId={scope.serverId} testID="w" /></InboxArtifactSourceBoundary>,
  );
  expect(unbound.findByTestId('w.choose')).not.toBeNull();
  expect(automationReads()).toBe(before);
});
