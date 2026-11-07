// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Button, Text, defineUiSurface, type MarkdownProps } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { expect, it } from 'vitest';
import { GithubOverviewMarkdown } from './markdown.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('offers remote document images to the host without fetching until the reader loads them', async () => {
  let shown: MarkdownProps | undefined;
  const render = defineUiSurface(() => <GithubOverviewMarkdown body={'<img alt="image" src="https://github.com/user-attachments/assets/screenshot">'} />);
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'github-markdown', mountNonce: 'github-markdown' },
    authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
    surface: context => {
      // The presentation host is a real system boundary. Mirror its post-render binding;
      // the projector, component, state and public Markdown bridge remain real.
      const entry = render(context) as React.ReactElement<{ presentationHost?: unknown }>;
      return React.cloneElement(entry, { presentationHost: {
        renderMarkdown(input: MarkdownProps) {
          shown = input;
          return input.images === undefined ? <Text value="Images unavailable" />
            : <Button title="Load pictures" onPress={input.images.onLoadRemote} />;
        },
        renderIcon: () => null,
      } });
    },
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
  });
  try {
    expect(shown?.value).toContain('![image](https://github.com/user-attachments/assets/screenshot)');
    expect(shown?.images?.resolve('https://github.com/user-attachments/assets/screenshot'))
      .toEqual({ kind: 'remote', url: 'https://github.com/user-attachments/assets/screenshot' });
    expect(shown?.images?.resolve('javascript:alert(1)')).toEqual({ kind: 'blocked' });
    expect(shown?.images?.resolve('./private.png')).toEqual({ kind: 'blocked' });
    expect(shown?.images?.remoteLoaded).toBe(false);
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Load pictures' })); });
    expect(shown?.images?.remoteLoaded).toBe(true);
  } finally {
    await fixture.dispose();
  }
});
