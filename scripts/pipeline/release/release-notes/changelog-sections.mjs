/**
 * Canonical section boundaries for both bundled history and release projections.
 * Section bodies remain verbatim so the release projector can read its metadata.
 */
export function parseChangelogSections(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const headers = [];
  for (const [index, line] of lines.entries()) {
    const match = /^## (Release|Version) (\S+) - (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (match) {
      headers.push({ index, kind: match[1], id: match[2], title: `${match[1]} ${match[2]}`, date: match[3] });
    } else if (/^## (?:Release|Version)\s/.test(line)) {
      throw new Error(`Invalid changelog release heading: ${line}`);
    }
  }
  return headers.map(({ index, ...header }, position) => ({
    ...header,
    markdown: lines.slice(index + 1, headers[position + 1]?.index).join('\n').replace(/^\n+|\n+$/g, ''),
  }));
}

export function stripChangelogComments(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}
