/**
 * SHIPPED, UPCOMING, ABSENT — the only three states this site is allowed to
 * talk in, and the registry it measures them against.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 * ------------------------------
 * The guard on /agents used to import
 * `../../../../packages/agents/src/generated/agentIds`. That path resolves
 * INSIDE this repository — the unreleased tree. So the test that was supposed
 * to stop the site claiming things the product cannot do was reading the very
 * registry that is ahead of the product, and four agents that exist only here
 * (antigravity, ohMyPi, coderabbit, deepsec) sailed through it. The same leak
 * put two unreleased voice modes into the FAQ.
 *
 * The fix is not a ban on mentioning unreleased work. It is three states:
 *
 *   SHIPPED   in the published release. Present tense is allowed. This is the
 *             only state that may appear in a capability table, a support
 *             matrix, or a sentence of the form "Happier runs X".
 *   UPCOMING  in this repository and not in the release. Must be named as not
 *             yet available and tied to the upcoming version. Never in a table,
 *             never in the present tense, never counted in "13 agents".
 *   ABSENT    in neither. Does not appear at all.
 *
 * WHERE THE SHIPPED SET COMES FROM
 * --------------------------------
 * `SHIPPED_AGENT_IDS` below is transcribed from the released tree:
 *
 *   happier-dev/happier @ v0.2 — packages/agents/src/types.ts, `AGENT_IDS`
 *
 * It is transcribed rather than imported because a marketing site that only
 * builds when a second checkout happens to sit beside it is a worse thing than
 * a transcription. The transcription cannot rot silently: availability.test.ts
 * re-reads that file from the released tree and fails if the two disagree. When
 * the released tree is not on the machine, the test says so loudly instead of
 * passing quietly.
 *
 * Set HAPPIER_SHIPPED_TREE to point the cross-check at a checkout that is not
 * in the default sibling location.
 */

/** The two states a thing on this site may be in. ABSENT has no representation. */
export type Availability = 'shipped' | 'upcoming';

/** The version unreleased work is attributed to, in the one place it is written. */
export const UPCOMING_RELEASE = 'v0.3';

/**
 * The label that has to travel with anything UPCOMING.
 *
 * Exported as a constant so the guard can assert the rendered page contains it,
 * rather than trusting whoever adds the next entry to remember the sentence.
 */
export const UPCOMING_LABEL = `Not available yet — in the upcoming ${UPCOMING_RELEASE}`;

/**
 * Where the released tree sits relative to this repository, and the env var
 * that overrides it. Plain strings on purpose: this module is bundled for the
 * browser, so it must never import `node:fs`. The filesystem work lives in
 * availability.test.ts.
 */
export const SHIPPED_TREE_ENV_VAR = 'HAPPIER_SHIPPED_TREE';
export const SHIPPED_TREE_DEFAULT_RELATIVE_PATH = '../../../../../remote-dev';
export const SHIPPED_AGENT_IDS_SOURCE = 'packages/agents/src/types.ts';
export const SHIPPED_MANIFEST_SOURCE = 'packages/agents/src/manifest.ts';
export const SHIPPED_CLI_RUNTIME_SOURCE = 'packages/agents/src/providers/providerCliRuntime.ts';

/**
 * AGENT_IDS as the released build declares it.
 *
 * Order preserved from the source so a diff against it reads cleanly.
 */
export const SHIPPED_AGENT_IDS = [
    'claude',
    'codex',
    'opencode',
    'gemini',
    'auggie',
    'qwen',
    'kimi',
    'kilo',
    'kiro',
    'customAcp',
    'pi',
    'copilot',
    'cursor',
    'grok',
] as const;

export type ShippedAgentId = (typeof SHIPPED_AGENT_IDS)[number];

const SHIPPED_AGENT_ID_SET: ReadonlySet<string> = new Set(SHIPPED_AGENT_IDS);

export function isShippedAgentId(id: string): id is ShippedAgentId {
    return SHIPPED_AGENT_ID_SET.has(id);
}
