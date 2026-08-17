/**
 * TEST-ONLY. The mirror of shippedTree.ts, pointing at the UNRELEASED tree.
 *
 * DO NOT IMPORT THIS FROM A COMPONENT. It touches `node:fs`; importing it from
 * anything the client bundle reaches will break the build.
 *
 * UPCOMING is defined as the unreleased registry minus the shipped one, so the
 * guard in availability.test.ts has to see both. It read the shipped tree off
 * disk already, but reached the unreleased one through a static relative
 * import — which only resolves when this site sits inside the unreleased
 * checkout. Once the site is promoted into the release tree to be built, that
 * import points at a file which is not there and the whole build fails on a
 * typecheck, not on anything about the site.
 *
 * So: same treatment as the released tree. Parse the one constant out of the
 * source text, return null when the tree is not on this machine, and let the
 * caller decide. availability.test.ts treats null the way agents.test.ts does —
 * one test says loudly that the check did not happen, and the rest stand down
 * rather than passing on an empty comparison.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
    UNRELEASED_AGENT_IDS_SOURCE,
    UNRELEASED_TREE_ENV_VAR,
    UNRELEASED_TREE_LOCAL_RELATIVE_PATH,
    UNRELEASED_TREE_SIBLING_RELATIVE_PATH,
} from './availability';

/**
 * Absolute path to the unreleased checkout, or null if it is not on this
 * machine.
 *
 * Order matters. The local repository is tried first so that in the unreleased
 * checkout the answer is "this one" and no sibling is required; the sibling is
 * tried second so that in the release checkout the answer is the `dev` tree
 * beside it. An explicit env var overrides both.
 */
export function resolveUnreleasedTreeRoot(): string | null {
    const fromEnv = process.env[UNRELEASED_TREE_ENV_VAR];
    const candidates = fromEnv
        ? [path.resolve(fromEnv)]
        : [
              path.resolve(__dirname, UNRELEASED_TREE_LOCAL_RELATIVE_PATH),
              path.resolve(__dirname, UNRELEASED_TREE_SIBLING_RELATIVE_PATH),
          ];

    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, UNRELEASED_AGENT_IDS_SOURCE))) return candidate;
    }
    return null;
}

/**
 * `AGENT_IDS` from the unreleased packages/agents/src/generated/agentIds.ts.
 *
 * Never the authority for what the site may claim — that is SHIPPED_AGENT_IDS.
 * This set exists only so UPCOMING can be computed rather than hand-asserted.
 */
export function readUnreleasedAgentIds(): string[] | null {
    const root = resolveUnreleasedTreeRoot();
    if (!root) return null;
    const file = path.join(root, UNRELEASED_AGENT_IDS_SOURCE);
    if (!existsSync(file)) return null;
    const source = readFileSync(file, 'utf8');
    const match = source.match(/export const AGENT_IDS\s*=\s*Object\.freeze\(\[([^\]]*)\]/);
    if (!match) throw new Error(`AGENT_IDS not found in ${UNRELEASED_AGENT_IDS_SOURCE}`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
