function admittedWebUrl(raw: string | undefined): URL | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function gitlabRawDiffEvidenceUrlV1(webUrl: string | undefined): string | null {
  const admitted = admittedWebUrl(webUrl);
  if (admitted === null) return null;
  admitted.pathname = `${admitted.pathname.replace(/\/$/, '')}.diff`;
  admitted.search = '';
  admitted.hash = '';
  return admitted.toString();
}

export function gitlabChangesEvidenceUrlV1(webUrl: string | undefined): string | null {
  const admitted = admittedWebUrl(webUrl);
  if (admitted === null) return null;
  admitted.pathname = `${admitted.pathname.replace(/\/$/, '')}/diffs`;
  admitted.search = '';
  admitted.hash = '';
  return admitted.toString();
}
