/**
 * Bun keeps `/*!` legal comments in a compiled bundle and has no option to drop
 * them. One character above U+007F anywhere in the bundle makes the embedded
 * source two-byte (UTF-16) for the whole executable: the server binary measured
 * 209 MB instead of 159 MB, and about 9 MiB more RSS at cold, from two legal
 * comments in dependencies. Escaping inside a comment changes no program text.
 */
const LEGAL_COMMENT = /\/\*![\s\S]*?\*\//g;
const NON_ASCII = /[^\x00-\x7f]/;

export function escapeLegalCommentsToAscii(text) {
  if (!text.includes('/*!') || !NON_ASCII.test(text)) return null;
  let changed = false;
  const escaped = text.replace(LEGAL_COMMENT, (comment) => {
    if (!NON_ASCII.test(comment)) return comment;
    changed = true;
    return comment.replace(/[^\x00-\x7f]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
  });
  return changed ? escaped : null;
}

const LOADERS = { js: 'js', cjs: 'js', mjs: 'js', jsx: 'jsx', ts: 'ts', cts: 'ts', mts: 'ts', tsx: 'tsx' };

/** Bun.build plugin: rewrites only files whose legal comments hold non-ASCII; every other file loads natively. */
export function createAsciiLegalCommentsPlugin() {
  return {
    name: 'ascii-legal-comments',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        if (args.namespace && args.namespace !== 'file') return undefined;
        const contents = escapeLegalCommentsToAscii(await Bun.file(args.path).text());
        if (contents === null) return undefined;
        return { contents, loader: LOADERS[args.path.slice(args.path.lastIndexOf('.') + 1)] ?? 'js' };
      });
    },
  };
}
