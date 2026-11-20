import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import { parseDocument } from 'yaml';

/** A catalog pin identifies template content rather than an App release. */
const CATALOG_PIN = /^(?:sha\d+:)?[0-9a-f]{7,}$/i;

/**
 * What an App's listing says about its version and source. A template catalog's index is where the listing came from,
 * not the App's own project: it is named as the source rather than linked as though it were the App.
 */
export function appListingCatalogFacts(input: Readonly<{
  version?: string | null;
  appVersion?: string | null;
  repository?: string | null;
  catalog?: Readonly<{ title: string; url?: string }> | null;
}>) {
  const version = input.version && input.version !== '0.0.0' && !CATALOG_PIN.test(input.version)
    ? input.version : input.appVersion ?? null;
  const repository = input.repository && input.repository !== input.catalog?.url ? input.repository : null;
  return { version, repository, sourceTitle: input.catalog?.title ?? null };
}

/** The identity header holds one sentence at two lines; a summary that wouldn't fit reads in full in the body instead. */
const PURPOSE_FITS = 110;

export function appListingProse(input: Readonly<{ summary?: string | null; about?: string | null }>) {
  const summary = input.summary?.trim() || null;
  const fits = summary !== null && summary.length <= PURPOSE_FITS;
  const about = input.about?.trim() || null;
  return { purpose: fits ? summary : null, about: fits && about === summary ? null : about ?? (fits ? null : summary) };
}

/** Read the explicit tag of the main service; catalog pins and digest-only references have no display tag. */
export function appListingImageTag(compose: DeploymentTemplateV1['compose']): string | null {
  const service = compose.primaryService ?? (compose.services.length === 1 ? compose.services[0] : undefined);
  if (!service) return null;
  const document = parseDocument(compose.document);
  if (document.errors.length > 0) return null;
  const image = document.getIn(['services', service, 'image']);
  if (typeof image !== 'string' || image.includes('$')) return null;
  const name = image.split('@', 1)[0]!;
  const colon = name.lastIndexOf(':');
  if (colon <= name.lastIndexOf('/')) return null;
  const tag = name.slice(colon + 1);
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag) ? tag : null;
}
