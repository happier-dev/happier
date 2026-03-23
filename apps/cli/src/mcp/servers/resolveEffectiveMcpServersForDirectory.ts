/**
 * MCP servers resolution (CLI/runtime)
 *
 * Wraps the protocol resolver with a Node-specific path normalizer so
 * machine/workspace bindings behave consistently under symlinks.
 */

import {
  resolveEffectiveServersV1,
  type McpServersSettingsV1,
  type ResolveEffectiveServersV1Result,
} from '@happier-dev/protocol';
import { createRealpathNormalizer } from './createRealpathNormalizer';

export function resolveEffectiveMcpServersForDirectory(params: Readonly<{
  settings: McpServersSettingsV1;
  machineId: string;
  directory: string;
}>): ResolveEffectiveServersV1Result {
  const normalizePath = createRealpathNormalizer();
  return resolveEffectiveServersV1(params.settings, {
    machineId: params.machineId,
    directory: params.directory,
    normalizePath,
  });
}
