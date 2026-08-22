/**
 * The current newest / flagship Claude model id this plugin defaults to.
 *
 * The Claude plugin is the canonical owner of Claude Agent policy, so the id
 * lives here rather than in a host workspace package. It previously sat in
 * `@happier-dev/protocol` to be shared with the OpenCode and Pi plugins; both
 * now pin their own replacement/startup model the same way they already pin
 * every other model in those tables, which leaves this plugin as the only
 * consumer, so the reach into a host workspace package the public plugin
 * toolchain does not bind for an external author is no longer needed.
 *
 * `CLAUDE_STATIC_MODELS` states the same id independently as a catalog row;
 * `models.test.ts` is what keeps the two in agreement.
 */
export const CLAUDE_FLAGSHIP_MODEL_ID = 'claude-opus-5';
