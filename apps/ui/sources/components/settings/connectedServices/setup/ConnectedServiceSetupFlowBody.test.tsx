import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ storage: 'real' });

const { ConnectedServiceSetupFlowBody } = await import('./ConnectedServiceSetupFlowBody');
const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');

afterEach(async () => {
  await standardCleanup();
});

describe('Connected service setup flow body', () => {
  it('offers two methods as one equal choice, without a Recommended badge', async () => {
    const screen = await renderScreen(<ConnectedServiceSetupFlowBody state="ready" activeMethodId="oauth" onSelectMethod={() => {}} flow={<></>}
      methods={[{ id: 'oauth', title: 'Sign in with Cloudflare', recommended: true }, { id: 'token', title: 'API token', recommended: false }]} />);
    const bar = screen.tree.findByType(SegmentedTabBar);
    expect(bar.props.segmentSizing).toBe('equal');
    expect(bar.props.overflow).toBeUndefined();
    expect(bar.props.tabs.map((tab: { label: string; badge?: string }) => [tab.label, tab.badge])).toEqual([['Sign in with Cloudflare', undefined], ['API token', undefined]]);
  });

  it('draws no picker for one method, and keeps the badge and overflow for three', async () => {
    const one = await renderScreen(<ConnectedServiceSetupFlowBody state="ready" activeMethodId="token" onSelectMethod={() => {}} flow={<></>}
      methods={[{ id: 'token', title: 'API token', recommended: false }]} />);
    expect(one.tree.findAllByType(SegmentedTabBar)).toHaveLength(0);
    const three = await renderScreen(<ConnectedServiceSetupFlowBody state="ready" activeMethodId="code" onSelectMethod={() => {}} flow={<></>}
      methods={[{ id: 'code', title: 'With a code', recommended: true }, { id: 'browser', title: 'With a browser', recommended: false }, { id: 'key', title: 'Paste', recommended: false }]} />);
    const bar = three.tree.findByType(SegmentedTabBar);
    expect(bar.props.overflow).toBeDefined();
    expect(bar.props.tabs[0].badge).toBeTruthy();
  });

  it('draws no generic Continue: a selected method without its own step yet waits quietly', async () => {
    const onSelectMethod = vi.fn();
    const screen = await renderScreen(
      <ConnectedServiceSetupFlowBody
        state="ready"
        methods={[{ id: 'oauth', title: 'Sign in with Acme', recommended: true }]}
        activeMethodId="oauth"
        onSelectMethod={onSelectMethod}
      />,
    );
    expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
    expect(screen.findHostByTestId('connected-service-setup:preparing')).not.toBeNull();
    expect(onSelectMethod).not.toHaveBeenCalled();
  });

  it('keeps a running flow in place of the press once a method started', async () => {
    const screen = await renderScreen(
      <ConnectedServiceSetupFlowBody
        state="ready"
        methods={[{ id: 'manual', title: 'With a code', recommended: true }]}
        activeMethodId="manual"
        onSelectMethod={vi.fn()}
        flow={<React.Fragment />}
      />,
    );
    expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
  });
});
