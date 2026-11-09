import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  PublicProfileSnapshotV1Schema,
} from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import {
  DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
  PublicProfileLayoutV1Schema,
} from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfilePreparedAtmosphereV1Schema } from '@happier-dev/protocol/account/publicProfileAtmosphere';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
  PublicProfileEditor,
  type PublicProfileEditorProps,
} from './PublicProfileEditor';
import { PublicProfileReview } from './PublicProfileReview';
import { prepareAppliedProfileAppearance, preparedPictureCopy } from './publicPictureCopy';

const coverage = {
  status: 'complete_for_supplied_facts',
  method: 'runtime',
} as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({
  v: 1,
  computedAtMs: 10,
  coverage,
  fieldCoverage: {},
  period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 },
  facts: { tokens: 87654321, activeDays: 3 },
});
const context = {
  handle: 'leeroy',
  identity: { name: 'Leeroy Brun' },
  service: {
    displayName: 'Happier Cloud',
    publicBaseUrl: 'https://happier.dev',
  },
  urls: {
    page: 'https://happier.dev/@leeroy',
    json: 'https://happier.dev/v1/public/profiles/leeroy',
    badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg',
    og: 'https://happier.dev/@leeroy/og.png',
    report: 'mailto:ops@happier.dev',
  },
};
const metric = (id: string, field: string) =>
  ({
    kind: 'widget',
    id,
    size: 'medium',
    frameStyle: 'card',
    title: id,
    presentation: {
      kind: 'declarative',
      document: {
        version: 1,
        root: {
          kind: 'metric',
          label: id,
          data: { kind: 'value', value: { kind: 'public_profile' } },
          value: { path: ['snapshot', 'facts', field], type: 'number' },
        },
      },
    },
  }) as const;
const layout = PublicProfileLayoutV1Schema.parse({
  v: 1,
  items: [metric('tokens', 'tokens'), metric('days', 'activeDays')],
});
const view = (tokens: boolean) =>
  projectPublicProfile({
    context,
    metadata: {},
    snapshot,
    layout,
    appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    policy: {
      ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens },
    },
  })!;
const shellView = {
  v: 1 as const,
  handle: 'leeroy',
  indexable: false,
  state: 'published' as const,
  identity: context.identity,
  metadata: {},
  snapshot: null,
  layout: { v: 1 as const, items: [] },
  urls: context.urls,
};
const pageLabels = {
  identityLine: '@leeroy',
  periodTitle: 'Last 90 days',
  periodDetail: 'Jul – Oct',
  emptyLayout: 'Empty',
  footerNote: 'Note',
  report: 'Report',
  madeWith: 'Made with Happier',
  inert: { success: 's', warning: 'w', error: 'e', incomplete: 'i' },
};

const isDisabled = (
  node: {
    props: { disabled?: unknown; accessibilityState?: { disabled?: unknown } };
  } | null,
) => Boolean(node?.props.disabled ?? node?.props.accessibilityState?.disabled);

function editor(overrides: Partial<PublicProfileEditorProps> = {}) {
  return (
    <PublicProfileEditor
      status="draft"
      mode="edit"
      onModeChange={() => {}}
      changes={0}
      ownerView={view(true)}
      visitorView={view(false)}
      hiddenBlockIds={new Set(['tokens'])}
      pageLabels={pageLabels}
      notice={null}
      submitting={false}
      onSubmit={() => {}}
      renderTools={() => null}
      {...overrides}
    />
  );
}

describe('PublicProfileEditor', () => {
  it('says a successful outcome as success, with or without Undo, and a failure as a warning', async () => {
    const noticeKind = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
      screen.findAll((node) => node.props?.testID === 'public-profile-editor-notice' && typeof node.props.kind === 'string')[0]?.props.kind;
    const published = await renderScreen(editor({ notice: 'Your page is public.', noticeTone: 'success' }));
    expect(noticeKind(published)).toBe('success');
    const failed = await renderScreen(editor({ notice: 'Couldn’t prepare.', noticeTone: 'warning' }));
    expect(noticeKind(failed)).toBe('warning');
  });

  it('arranges the owner’s widget area in place on Edit, also before a preview exists, and shows visitors’ blocks on Preview', async () => {
    const area = () => <Text testID="owner-area">area</Text>;
    const edit = await renderScreen(editor({ renderEditBlocks: area }));
    expect(edit.findByTestId('owner-area')).not.toBeNull();
    expect(edit.findByTestId('public-profile-block-days')).toBeNull();
    const unprepared = await renderScreen(editor({ renderEditBlocks: area, ownerView: null, visitorView: null, shellView }));
    expect(unprepared.findByTestId('owner-area')).not.toBeNull();
    expect(unprepared.findByTestId('public-profile-editor-preparing')).toBeNull();
    const preview = await renderScreen(editor({ renderEditBlocks: area, mode: 'preview' }));
    expect(preview.findByTestId('owner-area')).toBeNull();
    expect(preview.findByTestId('public-profile-block-days')).not.toBeNull();
  });

  it('is the profile page itself before any preview exists: header and customizing bar in the page on Edit, none of the owner chrome on Preview', async () => {
    const area = () => <Text testID="owner-area">area</Text>;
    const onRetry = vi.fn();
    const edit = await renderScreen(editor({ renderEditBlocks: area, ownerView: null, visitorView: null, shellView,
      unavailable: { reason: 'Your usage can’t be read', onRetry } }));
    expect(edit.findByTestId('public-profile-name')).not.toBeNull();
    expect(edit.findByTestId('public-profile-editor-banner')).not.toBeNull();
    expect(edit.getTextContent().split('Your usage can’t be read').length - 1).toBe(1);
    await edit.pressByTestIdAsync('public-profile-editor-retry');
    expect(onRetry).toHaveBeenCalledTimes(1);
    const preview = await renderScreen(editor({ renderEditBlocks: area, mode: 'preview', ownerView: null, visitorView: null, shellView }));
    expect(preview.findByTestId('public-profile-name')).not.toBeNull();
    expect(preview.findByTestId('public-profile-editor-banner')).toBeNull();
    expect(preview.findByTestId('owner-area')).toBeNull();
  });

  it('shows the owner every placed block, marking private ones, and visitors only what is shared', async () => {
    const edit = await renderScreen(editor());
    expect(edit.findByTestId('public-profile-block-tokens')).not.toBeNull();
    expect(edit.getTextContent()).toContain(t('publicIdentity.editor.onlyYou'));
    const preview = await renderScreen(editor({ mode: 'preview' }));
    expect(preview.findByTestId('public-profile-block-tokens')).toBeNull();
    expect(preview.findByTestId('public-profile-block-days')).not.toBeNull();
    expect(preview.getTextContent()).not.toContain(
      t('publicIdentity.editor.onlyYou'),
    );
  });

  it('offers Publish before the first publication and Apply only once something changed', async () => {
    const onSubmit = vi.fn();
    const first = await renderScreen(editor({ onSubmit }));
    expect(first.getTextContent()).toContain(
      t('publicIdentity.editor.publish'),
    );
    expect(first.getTextContent()).not.toContain(
      t('publicIdentity.editor.apply'),
    );
    await first.pressByTestIdAsync('public-profile-editor-submit');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const unchanged = await renderScreen(
      editor({ status: 'published', changes: 0 }),
    );
    expect(
      isDisabled(unchanged.findByTestId('public-profile-editor-submit')),
    ).toBe(true);
    const changed = await renderScreen(
      editor({ status: 'published', changes: 2 }),
    );
    expect(changed.getTextContent()).toContain(
      t('publicIdentity.editor.apply'),
    );
    expect(
      isDisabled(changed.findByTestId('public-profile-editor-submit')),
    ).toBe(false);
    expect(changed.getTextContent()).toContain(
      t('publicIdentity.editor.hintChanges', { count: 2 }),
    );
  });

  it('disables Publish and Apply until the selected private area has a current compiled candidate', async () => {
    for (const status of ['draft', 'published'] as const) {
      const screen = await renderScreen(editor({ status, changes: 1, canSubmit: false }));
      expect(isDisabled(screen.findByTestId('public-profile-editor-submit'))).toBe(true);
    }
  });

  // The publish result line enters once, after the band's rise: never painted before the rise starts.
  const lineOpacity = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
    let node = screen.findByTestId('public-profile-editor-notice');
    while (node) {
      const style = [node.props?.style].flat(Infinity).find(s => s && typeof s === 'object' && 'opacity' in s);
      if (style) return (style as { opacity: number }).opacity;
      node = node.parent;
    }
    return undefined;
  };

  it('holds the publish result line hidden in its first frame while the rise plays, and shows other outcomes at once', async () => {
    const published = await renderScreen(editor({ status: 'published', notice: 'Published', noticeTone: 'success', noticeMoment: 1 }));
    expect(lineOpacity(published)).toBe(0);
    const applied = await renderScreen(editor({ status: 'published', notice: 'Applied', noticeTone: 'success', noticeMoment: null }));
    expect(lineOpacity(applied)).toBe(1);
  });

  it('restarts a line that is already shown hidden when a new publish moment arrives', async () => {
    function Harness() {
      const [moment, setMoment] = React.useState<number | null>(null);
      return (
        <>
          <Text testID="publish-again" onPress={() => setMoment(1)}>again</Text>
          {editor({ notice: moment ? 'Published' : 'Unpublished elsewhere', noticeTone: 'success', noticeMoment: moment })}
        </>
      );
    }
    const screen = await renderScreen(<Harness />);
    expect(lineOpacity(screen)).toBe(1);
    await screen.pressByTestIdAsync('publish-again');
    expect(lineOpacity(screen)).toBe(0);
  });
});

describe('PublicProfileReview', () => {
  const review = (
    overrides: Partial<React.ComponentProps<typeof PublicProfileReview>> = {},
  ) => (
    <PublicProfileReview
      kind="publish"
      pageUrl="https://happier.dev/@leeroy"
      period="Jul – Oct"
      sharedFields={['tokens', 'calendar']}
      disclosure={view(true)}
      endToEndEncrypted
      indexable={false}
      confirming={false}
      onConfirm={() => {}}
      onCancel={() => {}}
      {...overrides}
    />
  );

  it('names every item that becomes public, the plaintext and picture consequences, and confirms once', async () => {
    const onConfirm = vi.fn();
    const screen = await renderScreen(
      review({ onConfirm, renderPicture: () => null }),
    );
    const text = screen.getTextContent();
    expect(text).toContain(t('publicIdentity.publicData.fields.tokens'));
    expect(text).toContain(t('publicIdentity.publicData.fields.calendar'));
    expect(text).toContain(t('publicIdentity.review.plaintext'));
    expect(text).toContain(t('publicIdentity.review.picture'));
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const plain = await renderScreen(
      review({ kind: 'apply', sharedFields: [], endToEndEncrypted: false }),
    );
    expect(plain.getTextContent()).not.toContain(
      t('publicIdentity.review.plaintext'),
    );
    expect(plain.getTextContent()).not.toContain(
      t('publicIdentity.review.picture'),
    );
    expect(plain.getTextContent()).toContain(t('publicIdentity.review.none'));
  });

  it('shows the retained picture copy that Confirm sends, not only a warning', async () => {
    const screen = await renderScreen(
      review({ renderPicture: () => <Text testID="retained-copy">copy</Text> }),
    );
    expect(screen.findByTestId('retained-copy')).not.toBeNull();
  });

  it('warns that weekly agent mix with public Tokens lets visitors estimate weekly per-agent amounts', async () => {
    const joint = await renderScreen(
      review({ sharedFields: ['tokens', 'weeklyAgentMix'] }),
    );
    expect(joint.getTextContent()).toContain(
      t('publicIdentity.publicData.details.weeklyAgentMix'),
    );
    const tokensHidden = await renderScreen(
      review({ sharedFields: ['weeklyAgentMix'] }),
    );
    expect(tokensHidden.getTextContent()).not.toContain(
      t('publicIdentity.publicData.details.weeklyAgentMix'),
    );
    expect(tokensHidden.getTextContent()).toContain(
      t('publicIdentity.publicData.fields.tokens'),
    );
  });

  it('discloses the exact public data on demand', async () => {
    const screen = await renderScreen(review({ sharedFields: ['tokens'] }));
    expect(screen.getTextContent()).not.toContain('87654321');
    await screen.pressByTestIdAsync('public-profile-review-data');
    expect(screen.getTextContent()).toContain('87654321');
  });

  it('discloses the complete public appearance for picture, planet and none without copying prepared pixels into JSON', async () => {
    const picture = PublicProfilePreparedAtmosphereV1Schema.parse({ source: 'picture', picture: {
      layout: 'horizon', content: { mimeType: 'image/png', base64: 'cHJlcGFyZWQtcGl4ZWxz' },
      descriptor: { kind: 'photo', title: 'Evening light', adaptiveHaze: false,
        horizon: {}, focus: {}, hour: 18, grades: { light: 0, dusk: 0, night: 0 }, dark: 'dusk',
        look: { effect: 'original', params: {}, strength: 1, dissolve: { style: 'gradient', from: 0, to: 1 } },
        credit: { author: 'Picture author', source: 'Own photo', licence: 'CC0', url: 'https://example.com/photo' } },
    } });
    for (const atmosphere of [picture, PublicProfilePreparedAtmosphereV1Schema.parse(DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.atmosphere),
      PublicProfilePreparedAtmosphereV1Schema.parse({ source: 'none' })]) {
      const projected = projectPublicProfilePreview({ context, metadata: {}, snapshot, layout,
        appearance: { theme: 'dark', atmosphere }, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 });
      expect(projected).not.toBeNull();
      const screen = await renderScreen(review({ disclosure: projected }));
      await screen.pressByTestIdAsync('public-profile-review-data');
      // React's test renderer unwraps memo components; read the real code surface's public props.
      const code: unknown = screen.tree.root.findAllByProps({ language: 'json', showCopyButton: true })[0]?.props.code;
      if (typeof code !== 'string') throw new Error('Review disclosure code was not rendered');
      const disclosed: unknown = JSON.parse(code);
      if (atmosphere.source === 'picture') {
        const { content: _content, ...publicPicture } = atmosphere.picture;
        expect(disclosed).toEqual({ ...projected, appearance: { theme: 'dark',
          atmosphere: { source: 'picture', picture: publicPicture } } });
      } else {
        expect(disclosed).toEqual(projected);
      }
      await screen.unmount();
    }
    if (picture.source !== 'picture') throw new Error('Expected prepared picture');
    const { content: _content, ...publicPicture } = picture.picture;
    const published = projectPublicProfile({ context, metadata: {}, snapshot, layout,
      appearance: { theme: 'dark', atmosphere: { source: 'picture', picture: {
        ...publicPicture, ref: { kind: 'publication', id: 'retained-public-picture' },
      } } }, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1 });
    expect(published).not.toBeNull();
    expect(prepareAppliedProfileAppearance(published!.appearance, preparedPictureCopy(picture.picture).data))
      .toEqual({ theme: 'dark', atmosphere: picture });
    expect(prepareAppliedProfileAppearance(published!.appearance, null)).toBeNull();
    const screen = await renderScreen(review({ disclosure: published }));
    await screen.pressByTestIdAsync('public-profile-review-data');
    const code: unknown = screen.tree.root.findAllByProps({ language: 'json', showCopyButton: true })[0]?.props.code;
    if (typeof code !== 'string') throw new Error('Published disclosure code was not rendered');
    expect(JSON.parse(code)).toEqual(published);
    await screen.unmount();
  });

  it('pins Cancel and Publish in the card footer while the long review scrolls between header and footer', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const published: Array<{ scrollHost?: string; bodyScroll?: string; footer?: React.ReactNode }> = [];
    const body = await renderScreen(
      review({
        onConfirm,
        onCancel,
        setChrome: (chrome) => {
          if (chrome?.kind === 'card') published.push(chrome);
        },
      }),
    );
    // The body holds the disclosures only; the actions never scroll away with it.
    expect(body.findByTestId('public-profile-review-confirm')).toBeNull();
    const chrome = published.at(-1);
    expect(chrome).toMatchObject({ scrollHost: 'bounded', bodyScroll: 'auto' });
    const footer = await renderScreen(<>{chrome?.footer}</>);
    await footer.pressByTestIdAsync('public-profile-review-confirm');
    await footer.pressByTestIdAsync('public-profile-review-cancel');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('explains the typed preparation cause in review when there is no disclosure to inspect', async () => {
    const screen = await renderScreen(review({ disclosure: null, preparationReason: 'no_eligible_personal_usage' }));
    expect(screen.getTextContent()).toContain(t('publicIdentity.profile.reasons.no_eligible_personal_usage'));
    expect(screen.getTextContent()).not.toContain(t('publicIdentity.profile.reasons.usage_unavailable'));
  });
});
