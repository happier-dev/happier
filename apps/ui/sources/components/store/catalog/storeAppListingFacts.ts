/** A catalog pin is a commit or a content digest: it names the template catalog's state, which no one can act on. */
const CATALOG_PIN = /^(?:sha\d+:)?[0-9a-f]{7,}$/i;

/**
 * What an App's listing says about its version and source. A template catalog's index is where the listing came from,
 * not the App's own project: it is named as the source rather than linked as though it were the App.
 */
export function appListingCatalogFacts(input: Readonly<{
  version?: string | null;
  repository?: string | null;
  catalog?: Readonly<{ title: string; url?: string }> | null;
}>) {
  const version = input.version && !CATALOG_PIN.test(input.version) ? input.version : null;
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
