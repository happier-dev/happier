/**
 * TEST-ONLY. Reads the RELEASED tree off disk so the guards can check this
 * site's claims against the build people can actually install.
 *
 * DO NOT IMPORT THIS FROM A COMPONENT. It touches `node:fs`; importing it from
 * anything the client bundle reaches will break the build, which is the second
 * best outcome after not doing it.
 *
 * WHY IT PARSES SOURCE RATHER THAN IMPORTING IT
 * ---------------------------------------------
 * The released tree is a separate checkout with its own workspace, its own
 * `@happier-dev/protocol` and its own `.js`-suffixed ESM imports. Wiring
 * vitest to resolve all of that would make this site's test run depend on a
 * second install being present and healthy. Reading four well-known constants
 * out of the source text does not, and the shapes being read are stable
 * hand-written literals, not generated soup.
 *
 * WHEN THE RELEASED TREE IS NOT THERE
 * -----------------------------------
 * Every reader returns null and the caller decides. The guards treat null as
 * "cannot check, say so loudly" rather than as a pass — a green tick that means
 * nothing was checked is how the last set of false claims got published.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
    SHIPPED_CLI_RUNTIME_SOURCE,
    SHIPPED_MANIFEST_SOURCE,
    SHIPPED_TREE_DEFAULT_RELATIVE_PATH,
    SHIPPED_TREE_ENV_VAR,
    SHIPPED_AGENT_IDS_SOURCE,
} from './availability';

/** Absolute path to the released checkout, or null if it is not on this machine. */
export function resolveShippedTreeRoot(): string | null {
    const fromEnv = process.env[SHIPPED_TREE_ENV_VAR];
    const candidate = fromEnv
        ? path.resolve(fromEnv)
        : path.resolve(__dirname, SHIPPED_TREE_DEFAULT_RELATIVE_PATH);
    if (!existsSync(path.join(candidate, SHIPPED_AGENT_IDS_SOURCE))) return null;
    return candidate;
}

function readShippedFile(relativePath: string): string | null {
    const root = resolveShippedTreeRoot();
    if (!root) return null;
    const file = path.join(root, relativePath);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8');
}

/**
 * `AGENT_IDS` from the released packages/agents/src/types.ts.
 *
 * This is THE registry the site is allowed to speak in the present tense about.
 */
export function readShippedAgentIds(): string[] | null {
    const source = readShippedFile(SHIPPED_AGENT_IDS_SOURCE);
    if (!source) return null;
    const match = source.match(/export const AGENT_IDS\s*=\s*\[([^\]]*)\]/);
    if (!match) throw new Error(`AGENT_IDS not found in ${SHIPPED_AGENT_IDS_SOURCE}`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Slice one agent's entry out of an object literal keyed by agent id.
 *
 * Anchored on indentation because both files are hand-formatted with a
 * consistent indent, and because indentation is what distinguishes a top-level
 * `localControl` from the `localControl: null` inside a runtime-kind override.
 */
function agentBlock(source: string, id: string, indent: number): string | null {
    const pad = ' '.repeat(indent);
    const opener = `\n${pad}${id}: {`;
    const start = source.indexOf(opener);
    if (start === -1) return null;
    const closer = `\n${pad}}`;
    const end = source.indexOf(closer, start + opener.length);
    if (end === -1) return null;
    return source.slice(start, end);
}

/** Fields at exactly one indent level inside the agent block. */
function fieldIn(block: string, indent: number, field: string): string | null {
    const pad = ' '.repeat(indent);
    const match = block.match(new RegExp(`\\n${pad}${field}:\\s*(.+)`));
    return match ? match[1].trim() : null;
}

export type ShippedCliFacts = {
    binaryName: string | null;
    docsUrl: string | null;
    installGuideUrl: string | null;
    managedKind: 'managed_package' | 'github_release_binary' | null;
    /** npm package name or GitHub repo, whichever the managed spec carries. */
    managedSource: string | null;
    manualInstallKind: string | null;
};

/** PROVIDER_CLI_RUNTIME_SPECS from the released providerCliRuntime.ts. */
export function readShippedCliFacts(id: string): ShippedCliFacts | null {
    const source = readShippedFile(SHIPPED_CLI_RUNTIME_SOURCE);
    if (!source) return null;
    const block = agentBlock(source, id, 2);
    if (!block) throw new Error(`no PROVIDER_CLI_RUNTIME_SPECS entry for '${id}'`);

    const quoted = (field: string) => {
        const raw = fieldIn(block, 4, field);
        if (!raw) return null;
        const match = raw.match(/'([^']*)'/);
        return match ? match[1] : null;
    };

    const managedKind = /kind:\s*'managed_package'/.test(block)
        ? ('managed_package' as const)
        : /kind:\s*'github_release_binary'/.test(block)
          ? ('github_release_binary' as const)
          : null;

    const managedSource =
        managedKind === 'managed_package'
            ? (block.match(/packageName:\s*'([^']+)'/)?.[1] ?? null)
            : managedKind === 'github_release_binary'
              ? (block.match(/githubRepo:\s*'([^']+)'/)?.[1] ?? null)
              : null;

    return {
        binaryName: quoted('binaryName'),
        docsUrl: quoted('docsUrl'),
        installGuideUrl: quoted('installGuideUrl'),
        managedKind,
        managedSource,
        manualInstallKind: quoted('manualInstallKind'),
    };
}

export type ShippedManifestFacts = {
    cliSubcommand: string | null;
    /** null where the agent declares no `localControl` at all. */
    localControl: { supported: boolean; topology: string | null; attachStrategy: string | null } | null;
    /** Empty where `connectedServices` is null. */
    connectedServiceIds: string[];
    toolsDelivery: string | null;
    /**
     * `runtimeInput.terminalPromptInjectionSupported`, false where the agent
     * declares no `runtimeInput` at all — which is how the released tree reads
     * it too (packages/agents/src/runtimeInput.ts:4-12 falls back to an
     * all-false record).
     *
     * This is the fact under the Claude Unified copy: whether a prompt can be
     * typed into a live vendor terminal instead of handed to a runner.
     */
    terminalPromptInjection: boolean;
};

/** AGENTS_CORE from the released manifest.ts. */
export function readShippedManifestFacts(id: string): ShippedManifestFacts | null {
    const source = readShippedFile(SHIPPED_MANIFEST_SOURCE);
    if (!source) return null;
    const block = agentBlock(source, id, 4);
    if (!block) throw new Error(`no AGENTS_CORE entry for '${id}'`);

    const localControlRaw = fieldIn(block, 8, 'localControl');
    const localControl = localControlRaw && localControlRaw.startsWith('{')
        ? {
              supported: /supported:\s*true/.test(localControlRaw),
              topology: localControlRaw.match(/topology:\s*'([^']+)'/)?.[1] ?? null,
              attachStrategy: localControlRaw.match(/attachStrategy:\s*'([^']+)'/)?.[1] ?? null,
          }
        : null;

    // `supportedServiceIds` sits inside `connectedServices`, which is `null` for
    // the eight agents that consume no stored credential.
    const servicesStart = block.indexOf('\n        connectedServices: {');
    let connectedServiceIds: string[] = [];
    if (servicesStart !== -1) {
        const listMatch = block
            .slice(servicesStart)
            .match(/supportedServiceIds:\s*\[([^\]]*)\]/);
        if (listMatch) {
            connectedServiceIds = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
        }
    }

    // `runtimeInput` is a multi-line object, so it is matched as a block rather
    // than through fieldIn(), which reads a single line.
    const runtimeInput = block.match(/\n {8}runtimeInput:\s*\{([^}]*)\}/)?.[1] ?? '';

    return {
        cliSubcommand: fieldIn(block, 8, 'cliSubcommand')?.match(/'([^']+)'/)?.[1] ?? null,
        localControl,
        connectedServiceIds,
        toolsDelivery: fieldIn(block, 8, 'tools')?.match(/delivery:\s*'([^']+)'/)?.[1] ?? null,
        terminalPromptInjection: /terminalPromptInjectionSupported:\s*true/.test(runtimeInput),
    };
}
