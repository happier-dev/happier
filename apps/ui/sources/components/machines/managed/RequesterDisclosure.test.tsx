import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
// Opening a browser or the OS URL handler is the platform boundary.
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
afterEach(() => { openExternalUrlMock.mockClear(); standardCleanup(); });

const { RequesterDisclosureContent } = await import('./RequesterDisclosure');

describe('RequesterDisclosureContent', () => {
  it.each([undefined, 'run'] as const)('links every requester disclosure to the shared-machines help page (retention %s)', async (retention) => {
    const screen = await renderScreen(<RequesterDisclosureContent model={{ owner: 'Alice', machine: 'devbox', signIn: 'full',
      ...(retention ? { retention } : {}) }} />);
    expect(screen.getTextContent()).toContain('How shared machines work');
    const link = screen.tree.root.findAll((node) => node.props.accessibilityRole === 'link'
      && typeof node.props.onPress === 'function')[0];
    expect(link).toBeDefined();
    await act(async () => { link!.props.onPress(); });
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://docs.happier.dev/accounts/session-sharing');
  });
});
