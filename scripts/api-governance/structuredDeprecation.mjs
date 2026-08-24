const STRUCTURED_DEPRECATION = /^(?<replacement>[\s\S]+?);\s*remove when\s+(?<removalCondition>[\s\S]+?)$/u;

function tagCommentText(comment) {
  if (typeof comment === 'string') return comment;
  if (Array.isArray(comment)) {
    return comment.map((part) => (
      typeof part === 'string' ? part : part.text
    )).join('');
  }
  return '';
}

/**
 * Parses the one public structured deprecation spelling already emitted by
 * the Plugin SDK source owner. Every generated public-package inventory uses
 * these two fields instead of retaining unstructured JSDoc prose.
 *
 * @param {readonly { tagName?: { text?: unknown }, comment?: unknown }[]} tags
 * @param {string} owner
 */
export function parseStructuredDeprecationTags(tags, owner) {
  const deprecatedTags = tags.filter((tag) => tag.tagName?.text === 'deprecated');
  if (deprecatedTags.length === 0) return Object.freeze({});
  if (deprecatedTags.length > 1) {
    throw new Error(
      `${owner} must document at most one deprecation as "@deprecated <replacement>; remove when <condition>"`,
    );
  }
  const match = STRUCTURED_DEPRECATION.exec(tagCommentText(deprecatedTags[0].comment).trim());
  const replacement = match?.groups?.replacement?.trim();
  const removalCondition = match?.groups?.removalCondition?.trim();
  if (!replacement || !removalCondition) {
    throw new Error(
      `${owner} must document a deprecation as "@deprecated <replacement>; remove when <condition>"`,
    );
  }
  return Object.freeze({ replacement, removalCondition });
}

/** @param {{ replacement: string, removalCondition: string }} deprecation */
export function formatStructuredDeprecation(deprecation) {
  return `@deprecated ${deprecation.replacement}; remove when ${deprecation.removalCondition}`;
}
