/**
 * MCP servers resolution (CLI/runtime)
 *
 * Wraps the protocol resolver with a Node-specific path normalizer so
 * machine/workspace bindings behave consistently under symlinks.
 */

import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import {
  resolveEffectiveServersV1,
  type McpServersSettingsV1,
  type ResolveEffectiveServersV1Result,
} from '@happier-dev/protocol';

function createRealpathNormalizer(): (value: string) => string {
  const cache = new Map<string, string>();

  return (value: string) => {
    const resolved = resolvePath(value);
    const cached = cache.get(resolved);
    if (cached) return cached;

    let normalized = resolved;
    try {
      normalized = realpathSync(resolved);
    } catch {
      // keep resolved
    }

    cache.set(resolved, normalized);
    return normalized;
  };
}

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

