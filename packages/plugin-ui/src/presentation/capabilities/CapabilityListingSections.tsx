import type { ComponentType, ReactElement, ReactNode } from 'react';

/** Facts already held by an installable thing's listing; no acquisition is owned here. */
export type HappierCapabilityListingFacts = Readonly<{
  version?: string | null;
  /** What the version belongs to when it is not the listing's own release. */
  versionNote?: string | null;
  sourceTitle?: string | null;
  license?: string | null;
  links?: Readonly<{ repository?: string; website?: string }> | null;
}>;

export type HappierCapabilityListingSectionsLabels = Readonly<{
  versionsTitle: string;
  sourceTitle: string;
  /** The same section when no licence is known: it names only what it holds. */
  sourceOnlyTitle?: string;
  current: string;
  currentIn: (source: string) => string;
}>;

export type HappierCapabilityListingRowProps = Readonly<{
  kind: 'version' | 'source' | 'link' | 'license';
  title: string;
  subtitle?: string;
  onPress?: () => void;
  testID?: string;
}>;

export type HappierCapabilityListingSectionsHost = Readonly<{
  Group: ComponentType<Readonly<{ title: string; testID: string; children: ReactNode }>>;
  Row: ComponentType<HappierCapabilityListingRowProps>;
}>;

export type HappierCapabilityListingSectionsProps = Readonly<{
  facts: HappierCapabilityListingFacts;
  testID: string;
  labels: HappierCapabilityListingSectionsLabels;
  host: HappierCapabilityListingSectionsHost;
  onOpenExternal: (url: string) => void;
}>;

function webLink(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function linkLabel(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  return `${parsed.host.replace(/^www\./, '')}${path}`;
}

/** The same optional closing sections in an Add detail, a standalone listing and plugin-authored pages. */
export function HappierCapabilityListingSections(props: HappierCapabilityListingSectionsProps): ReactElement {
  const { Group, Row } = props.host;
  const { version, versionNote, sourceTitle, license } = props.facts;
  const link = webLink(props.facts.links?.repository) ?? webLink(props.facts.links?.website);
  const hasSource = Boolean(sourceTitle) || link !== null || Boolean(license);
  return (
    <>
      {version ? (
        <Group testID={`${props.testID}.versions`} title={props.labels.versionsTitle}>
          <Row kind="version" title={version}
            subtitle={versionNote || (sourceTitle ? props.labels.currentIn(sourceTitle) : props.labels.current)} />
        </Group>
      ) : null}
      {hasSource ? (
        <Group testID={`${props.testID}.source`} title={license ? props.labels.sourceTitle : props.labels.sourceOnlyTitle ?? props.labels.sourceTitle}>
          {sourceTitle ? <Row kind="source" title={sourceTitle} /> : null}
          {link ? (
            <Row kind="link" testID={`${props.testID}.source.link`} title={linkLabel(link)}
              {...(license ? { subtitle: license } : {})} onPress={() => props.onOpenExternal(link)} />
          ) : license ? <Row kind="license" title={license} /> : null}
        </Group>
      ) : null}
    </>
  );
}
