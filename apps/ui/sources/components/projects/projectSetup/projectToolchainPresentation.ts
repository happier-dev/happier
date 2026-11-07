import type {
  ProjectCommandSourceV1,
  ProjectManifestV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { t } from '@/text';

import { describeProjectToolchain, describeProjectTool } from './projectScriptPresentation';

/**
 * Plan 24 copy for a Project's native environment (Mise, Devbox, devenv, Flox, Nix flake). The one
 * place that decides which words an environment state uses; surfaces pass the selected environment's
 * name and read the sentence back. The host environment has no state of its own to describe.
 */

/** "devenv", "Nix flake": the selected native environment as people read it; null for the host. */
export function nativeToolchainNameFor(
  manifest: Pick<ProjectManifestV1, 'toolchain'> | null | undefined,
): string | null {
  const toolchain = manifest?.toolchain;
  return toolchain && toolchain.kind !== 'host'
    ? describeProjectToolchain(toolchain).title
    : null;
}

/** The plan's phrases are sentence fragments or sentences; the refusal reads as two sentences. */
const sentence = (text: string) => (text.endsWith('.') ? text : `${text}.`);

/** The producer's typed refusals while preparing the native environment (never an evaluation failure of a script). */
const PREPARATION_FAILED = new Set([
  'native_toolchain_failed',
  'native_toolchain_invalid',
  'native_toolchain_termination_incomplete',
]);

/**
 * What a Run that never reached the native environment says, or null when the code is not an
 * environment-preparation refusal (the row then keeps its generic refusal). Failure never falls back to
 * the host, and the sentence says so.
 */
export function describeNativeToolchainRefusal(
  code: string,
  toolchainName: string | null,
): string | null {
  if (!toolchainName) return null;
  const reason =
    code === 'native_tool_unavailable'
      ? t('projects.scripts.toolchain.unavailable', { tool: toolchainName })
      : PREPARATION_FAILED.has(code)
        ? t('projects.scripts.toolchain.failed')
        : null;
  return reason
    ? [reason, t('projects.scripts.toolchain.noFallback')].map(sentence).join(' ')
    : null;
}

/**
 * The sentence a failed Run reads as. A missing tool is the environment's only when the script runs
 * inside it as a literal command or through the environment's own tool; another native source's
 * missing runner keeps the generic refusal rather than blaming the wrong tool.
 */
export function describeScriptToolchainRefusal(
  code: string | null,
  manifest: Pick<ProjectManifestV1, 'toolchain'>,
  source: ProjectCommandSourceV1,
): string | null {
  const name = nativeToolchainNameFor(manifest);
  if (!code || !name) return null;
  const inside = source.kind === 'command' || (source.kind === 'native' && describeProjectTool(source.tool) === name);
  return inside ? describeNativeToolchainRefusal(code, name) : null;
}
