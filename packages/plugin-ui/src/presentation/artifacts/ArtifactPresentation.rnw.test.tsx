import type { ComponentProps, ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierArtifactRevisionList, type HappierArtifactRevisionListProps } from './ArtifactRevisionList.js';
import { HappierPublicLinkCard, type HappierPublicLinkCardProps } from './PublicLinkCard.js';
import { HappierArtifactPreviewCard, type HappierArtifactPreview } from './ArtifactPreviewCard.js';

function publicLink(overrides: Partial<HappierPublicLinkCardProps> = {}) {
  return <HappierPublicLinkCard testID="link" published loaded configuring={false} shareUrl={null}
    title="Public link" status="On" hiddenLabel="Created elsewhere" detail="Read only" description="Share this"
    expiresLabel="Expiry" usesLabel="Uses" consentTitle="Consent" consentDescription="Ask first" replacementNote="Replaces the link"
    colors={{ border: 'gray', inset: 'white', surface: 'white', text: 'black', secondary: 'gray', success: 'green' }}
    typography={{ title: {}, subtitle: {}, emphasizedSubtitle: {}, mono: {}, consentTitle: {} }} Text={Text}
    linkMark={<Text>Link</Text>} statusMark={<Text>Active</Text>}
    newControl={<Text>New</Text>} turnOffControl={<Text>Turn off</Text>} createControl={<Text>Create</Text>}
    expiryControl={<Text>Seven days</Text>} usesControl={<Text>Unlimited</Text>} consentControl={<Text>Enabled</Text>}
    cancelControl={<Text>Cancel</Text>} submitControl={<Text>Submit</Text>} {...overrides} />;
}

const byId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function RevisionItem(props: ComponentProps<HappierArtifactRevisionListProps['host']['Item']>) {
  return <Pressable testID={props.testID} accessibilityRole="radio" aria-checked={props.selected} onPress={props.onPress}>
    <Text>{props.title}</Text><Text>{props.subtitle}</Text>{props.titleAccessory}
    {props.showChevron ? <Text>Open</Text> : null}
  </Pressable>;
}

function RevisionGroup(props: Readonly<{ title: string; children?: ReactNode }>) {
  return <View><Text>{props.title}</Text>{props.children}</View>;
}

describe('shared artifact presentation', () => {
  it('keeps decorative grid previews outside the web accessibility tree', async () => {
    const previews: readonly HappierArtifactPreview[] = [
      { kind: 'markdown', text: '# Preview heading\nPreview body' },
      { kind: 'code', text: 'const preview = true;', language: 'typescript' },
      { kind: 'workflow', steps: [{ title: 'Build' }] },
      { kind: 'board', layout: { mode: 'canvas', source: { sections: [], hasFilter: false, pickedCount: 0 }, widgets: [] } },
      { kind: 'file', name: 'report.pdf', mime: 'application/pdf', sizeBytes: 32 },
    ];
    const render = (preview: HappierArtifactPreview) => <HappierArtifactPreviewCard preview={preview} testID="preview"
      htmlLabel="HTML" colors={{ primary: 'black', secondary: 'gray', tertiary: 'gray', paper: 'white', paperBorder: 'gray' }}
      host={{ renderText: ({ text }) => <Text>{text}</Text>, renderIcon: () => <Text>File</Text> }} />;
    const view = mountThroughReactNativeWeb(render(previews[0]!));
    try {
      for (const preview of previews) {
        await view.render(render(preview));
        expect(byId(view.container, 'preview')?.getAttribute('aria-hidden')).toBe('true');
      }
      expect(view.container.textContent).toContain('report.pdf');
    } finally {
      view.unmount();
    }
  });

  it('keeps an issued publication visible without inventing a bearer URL, and withdraws unknown off state', async () => {
    const view = mountThroughReactNativeWeb(publicLink());
    expect(byId(view.container, 'session-public-link-hidden')?.textContent).toBe('Created elsewhere');
    expect(byId(view.container, 'session-public-link-url')).toBeNull();
    expect(byId(view.container, 'session-public-link-detail')?.textContent).toBe('Read only');
    await view.render(publicLink({ published: false, loaded: false, notices: <Text>Loading</Text> }));
    expect(byId(view.container, 'session-public-link-status')).toBeNull();
    expect(view.container.textContent).toContain('Loading');
    expect(view.container.textContent).not.toContain('Create');
    await view.render(publicLink({ published: false, loaded: true }));
    expect(view.container.textContent).toContain('Create');
    view.unmount();
  });

  it('replaces issued-link controls with host option controls while configuring', async () => {
    const view = mountThroughReactNativeWeb(publicLink({ shareUrl: 'https://viewer.example.test/link#secret', copyControl: <Text>Copy</Text> }));
    expect(byId(view.container, 'session-public-link-url')?.textContent).toContain('#secret');
    await view.render(publicLink({ configuring: true }));
    expect(byId(view.container, 'session-public-link-url')).toBeNull();
    expect(view.container.textContent).toContain('Seven days');
    expect(view.container.textContent).toContain('Replaces the link');
    expect(view.container.textContent).not.toContain('Turn off');
    view.unmount();
  });

  it('keeps revision selection controlled and preserves the supplied saved provenance', async () => {
    let selected: number | null = null;
    const render = (sideBySide: boolean) => <HappierArtifactRevisionList sideBySide={sideBySide} title="Versions"
      currentTitle="Current" currentLabel="Now" retentionLabel="Keeps ten" selectedVersion={selected}
      revisions={[
        { bodyVersion: 7, title: 'Version 7', subtitle: 'Today · Saved by Ada', detail: '12 KB' },
        { bodyVersion: 6, title: 'Version 6', subtitle: 'Yesterday · Restored by Ada', detail: '8 KB' },
      ]}
      onSelectVersion={version => { selected = version; }} colors={{ secondary: 'gray', tertiary: 'gray' }}
      host={{ Item: RevisionItem, ItemGroup: RevisionGroup, Text }} />;
    const view = mountThroughReactNativeWeb(render(false));
    const row = byId(view.container, 'artifact-history:version:7')!;
    expect(row.textContent).toContain('Today · Saved by Ada');
    expect(row.textContent).toContain('Open');
    row.click();
    expect(selected).toBe(7);
    await view.render(render(true));
    expect(byId(view.container, 'artifact-history:version:7')?.getAttribute('aria-checked')).toBe('true');
    expect(byId(view.container, 'artifact-history:version:6')?.getAttribute('aria-checked')).toBe('false');
    expect(byId(view.container, 'artifact-history:version:7')?.textContent).not.toContain('Open');
    expect(byId(view.container, 'artifact-history:current')?.textContent).toContain('Now');
    view.unmount();
  });
});
