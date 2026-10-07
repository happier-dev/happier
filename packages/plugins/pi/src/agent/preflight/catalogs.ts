import type { AgentPreflightSessionControlsCommandResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';

const PI_COMMAND_CATALOG_MARKER = 'happier-pi-command-catalog';

/** Pi's public extension API owns extension, template and slash-skill membership. */
export function buildPiCommandCatalogDiscoveryExtensionSource(): string {
  return `
export default function happierCommandCatalogDiscovery(pi) {
  const emit = (result) => process.stderr.write(JSON.stringify({type:${JSON.stringify(PI_COMMAND_CATALOG_MARKER)}, ...result}) + "\\n");
  pi.on("session_start", () => {
    try {
      if (typeof pi.getCommands !== "function") {
        emit({error:"native-command-catalog-unavailable"}); return;
      }
      const commands = pi.getCommands();
      if (!Array.isArray(commands)) {
        emit({error:"invalid-native-command-catalog"}); return;
      }
      emit({commands});
    } catch { emit({error:"native-command-catalog-unavailable"}); }
  });
}
`;
}

export function parsePiPreflightCommandCatalog(result: AgentPreflightSessionControlsCommandResultV1): Readonly<{
  commands: unknown[];
  skills: null;
}> {
  if (!result.ok || result.exitCode !== 0) throw new Error('Pi native command catalog unavailable');
  let commands: unknown[] | undefined;
  for (const line of result.stderr.split('\n')) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const observation = value as Record<string, unknown>;
    if (observation.type !== PI_COMMAND_CATALOG_MARKER) continue;
    if ('error' in observation || !Array.isArray(observation.commands)) {
      throw new Error('Pi native command catalog unavailable');
    }
    commands = observation.commands;
  }
  // Native extension failures can still exit successfully. Absence is not an observed empty list.
  if (!commands) throw new Error('Pi native command catalog unavailable');
  return { commands, skills: null };
}
