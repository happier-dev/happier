import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/navigation/OAuthView', () => ({
  OAuthView: (props: unknown) => React.createElement('OAuthView', props as Record<string, unknown>),
}));

describe('ConnectedServiceOauthEmbeddedView', () => {
  it('renders a step screen and only mounts OAuthView after the user starts', async () => {
    const { ConnectedServiceOauthEmbeddedView } = await import('./ConnectedServiceOauthEmbeddedView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceOauthEmbeddedView
          name="Claude subscription"
          command="happier connect claude"
          config={{ authUrl: () => '', tokenExchange: async () => ({}) }}
        />)).tree;

    expect(tree.findAllByType('OAuthView' as any)).toHaveLength(0);

    const startButton = tree.find((n) => n.props?.testID === 'connectedServices.oauthEmbedded.startButton');
    await act(async () => {
      await pressTestInstanceAsync(startButton);
    });

    expect(tree.findAllByType('OAuthView' as any)).toHaveLength(1);
  });
});
