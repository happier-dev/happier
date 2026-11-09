import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CapabilityAddExample, CapabilityKitExample } from '../../fixtures/external-authoring/src/capabilityKitSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { CapabilityListingSections, type CapabilityListingFacts } from './CapabilityListingSections.js';

const byId = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('external author capability kit', () => {
  it('falls back to an openable website, retains a licence alone, and omits missing listing sections', async () => {
    const context = createSurfaceContext();
    const openExternalLink = vi.fn(async () => undefined);
    const hostApi = createHostApiStub(context, { openExternalLink });
    const tree = (facts: CapabilityListingFacts) => (
      <PluginUiProvider hostApi={hostApi} context={context}>
        <CapabilityListingSections testID="listing" facts={facts} />
      </PluginUiProvider>
    );
    const mounted = mountThroughReactNativeWeb(tree({
      license: 'MIT', links: { repository: 'javascript:alert(1)', website: 'https://www.example.com/docs' },
    }));
    try {
      const link = byId(mounted.container, 'listing.source.link')!;
      expect(link.textContent).toContain('example.com/docs');
      expect(link.textContent).toContain('MIT');
      await act(async () => link.click());
      expect(openExternalLink).toHaveBeenCalledWith('https://www.example.com/docs');
      await mounted.render(tree({ license: 'MIT' }));
      expect(byId(mounted.container, 'listing.source')?.textContent).toContain('MIT');
      expect(byId(mounted.container, 'listing.source.link')).toBeNull();
      await mounted.render(tree({}));
      expect(byId(mounted.container, 'listing.source')).toBeNull();
      expect(byId(mounted.container, 'listing.versions')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('speaks the most blocking status with its fix, keeps healthy rows quiet, and clears once fixed', () => {
    const onSignIn = vi.fn();
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <CapabilityKitExample onSignIn={onSignIn} />
    </PluginUiProvider>);
    try {
      const header = byId(mounted.container, 'author-capability.header')!;
      expect(header.textContent).toContain('Linear');
      expect(header.textContent).toContain('Runs scripts');
      expect(header.textContent).toContain('12 tools');
      expect(header.textContent).toContain('2.4k tokens a turn');
      expect(header.textContent).toContain('ext/linear');
      // Sign-in blocks more than the update: the header and the notice speak it.
      expect(byId(mounted.container, 'author-capability.header.status')!.textContent).toContain('Needs sign-in');
      expect(byId(mounted.container, 'author-capability.banner')!.textContent).toContain('Linear is signed out');
      // A stop keeps the pill short and says its reason on its own line.
      const chip = byId(mounted.container, 'author-capability.chip')!;
      expect(chip.textContent).toContain('Stopped on build-box');
      expect(chip.textContent).toContain('node is missing');
      expect(byId(mounted.container, 'author-capability.facts')!.textContent?.replace(/\s+/gu, ' ').trim()).toBe('You · Text only · 1.2k tokens');
      // The list: a speaking status takes the facts line; a healthy row keeps its facts.
      expect(byId(mounted.container, 'author-capability.row.linear:status')!.textContent).toContain('Needs sign-in');
      expect(byId(mounted.container, 'author-capability.row.figma:status')).toBeNull();
      expect(byId(mounted.container, 'author-capability.row.figma')!.textContent).toContain('2 projects');

      const fix = [...byId(mounted.container, 'author-capability.banner')!.querySelectorAll<HTMLElement>('[role="button"]')]
        .find((node) => node.textContent === 'Sign in')!;
      act(() => fix.click());
      expect(onSignIn).toHaveBeenCalledWith('linear');
      expect(byId(mounted.container, 'author-capability.banner')).toBeNull();
      expect(byId(mounted.container, 'author-capability.header.status')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('says where an author item is on from its own state and hands the person\'s choice back as an intent', async () => {
    const onWhere = vi.fn();
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <CapabilityKitExample onWhere={onWhere} />
    </PluginUiProvider>);
    try {
      const sentence = () => byId(mounted.container, 'author-capability.where:sentenceText')!.textContent?.replace(/\s+/gu, ' ');
      expect(sentence()).toContain('On everywhere');
      expect(sentence()).toContain('except Gemini');
      expect(byId(mounted.container, 'author-capability.where:consequence')!.textContent).toContain('Available to Claude on build-box');

      await act(async () => byId(mounted.container, 'author-capability.where:sentence')!.click());
      const off = [...byId(mounted.container, 'author-capability.where:everywhere')!.querySelectorAll<HTMLElement>('[role="radio"]')]
        .find((node) => node.textContent === 'Off')!;
      await act(async () => off.click());
      expect(onWhere).toHaveBeenCalledWith({ kind: 'everywhere', state: 'off' });
      expect(sentence()).not.toContain('On everywhere');

      await act(async () => byId(mounted.container, 'author-capability.where:rule:all|gemini:remove')!.click());
      expect(onWhere).toHaveBeenLastCalledWith({ kind: 'remove', place: { t: 'allMachines' }, agentId: 'gemini' });
      expect(sentence()).not.toContain('Gemini');
    } finally { mounted.unmount(); }
  });

  it('lets an author add its own things through the shared Add body: the list, one item\'s details and its install', async () => {
    const onInstall = vi.fn();
    const onClose = vi.fn();
    const openExternalLink = vi.fn(async () => undefined);
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context, { openExternalLink })} context={context}>
      <CapabilityAddExample onInstall={onInstall} onClose={onClose} />
    </PluginUiProvider>);
    try {
      expect(byId(mounted.container, 'author-add.row.linear')!.textContent).toContain('Linear');
      expect(byId(mounted.container, 'author-add.row.figma')).not.toBeNull();
      await act(async () => byId(mounted.container, 'author-add.row.linear')!.click());
      expect(byId(mounted.container, 'author-add:detail:linear')).not.toBeNull();
      expect(byId(mounted.container, 'author-add:detail-action')!.contains(byId(mounted.container, 'author-add:primary'))).toBe(true);
      const versions = byId(mounted.container, 'author-add.listing.linear.versions');
      expect(versions).not.toBeNull();
      expect(versions?.textContent).toContain('1.4.0');
      const source = byId(mounted.container, 'author-add.listing.linear.source')!;
      expect(source.textContent).toContain('Extension registry');
      expect(source.textContent).toContain('MIT');
      await act(async () => byId(mounted.container, 'author-add.listing.linear.source.link')!.click());
      expect(openExternalLink).toHaveBeenCalledWith('https://github.com/acme/linear-extension.git');
      expect(onInstall).not.toHaveBeenCalled();
      await act(async () => byId(mounted.container, 'author-add:primary')!.click());
      expect(onInstall).toHaveBeenCalledWith('linear');
      // Installed and staying: the action turns to Done.
      expect(byId(mounted.container, 'author-add:done')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => byId(mounted.container, 'author-add:done')!.click());
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally { mounted.unmount(); }
  });
});
