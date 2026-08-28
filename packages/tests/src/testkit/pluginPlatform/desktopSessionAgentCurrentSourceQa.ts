import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentManagedStackSessionAgentIdentity,
  attestCurrentManagedStackPluginUi,
  prepareCurrentManagedStackSessionAgentFixture,
  resolveCurrentManagedStackPluginUiContext,
} from './currentManagedStackPluginUiQa';
import { runSessionAgentMcpQa } from '../../../../../apps/ui/scripts/qa/tauriSessionAgentMcpQa.mjs';

function required(value: string | undefined, code: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(code);
  return normalized;
}

export type DesktopSessionAgentJourneyResult = Readonly<{
  kind: 'observed';
  artifactRoot: string;
}>;

export type DesktopSessionAgentJourneyBlocker = Readonly<{
  kind: 'blocked';
  code:
    | 'desktop_session_agent_driver_unavailable';
  detail: string;
}>;

/**
 * Truthful exit classification for the desktop loaded row. A green journey
 * proves the real Tauri client drove the exact qualified external Agent;
 * anything else names its blocker instead of passing vacuously.
 */
export function resolveDesktopSessionAgentExitCode(result: Readonly<{
  journey: DesktopSessionAgentJourneyResult | DesktopSessionAgentJourneyBlocker;
  identityAsserted: boolean;
}>): number {
  if (result.journey.kind !== 'observed') return 2;
  return result.identityAsserted ? 0 : 2;
}

function isDriverUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Unable to resolve a connected Tauri app identifier')
    || message.includes('no tauri app found');
}

/**
 * Loaded external Session Agent QA for the real Tauri desktop client on the
 * current managed Stack. The canonical current-source Session Agent fixture
 * owns the whole source lifecycle; this row only proves the desktop client
 * selects and drives the exact qualified identity on real loaded bytes.
 */
export async function runDesktopSessionAgentCurrentSourceQa(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopSessionAgentJourneyResult | DesktopSessionAgentJourneyBlocker> {
  const appIdentifier = required(
    env.HAPPIER_STACK_TAURI_IDENTIFIER,
    'desktop_session_agent_app_identifier_missing',
  );
  const context = await resolveCurrentManagedStackPluginUiContext({ env });
  await attestCurrentManagedStackPluginUi({ context });
  const fixture = await prepareCurrentManagedStackSessionAgentFixture({
    context,
    rowId: `desktop-${Date.now()}`,
  });
  try {
    await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'active' });
    const journey = await runSessionAgentMcpQa({
      env: {
        ...env,
        HAPPIER_STACK_TAURI_IDENTIFIER: appIdentifier,
        HAPPIER_TAURI_MCP_APP_IDENTIFIER: appIdentifier,
      },
      config: Object.freeze({
        appIdentifier,
        route: '/new',
        qualifiedAgentId: fixture.qualifiedAgentId,
        pluginId: fixture.pluginId,
        agentLocalId: fixture.agentLocalId,
        prompt: 'Run the deterministic check for the current-source desktop row.',
        cancelPrompt: 'Cancel this deterministic check for the current-source desktop row.',
        assistantText: fixture.assistantText,
        reasoningText: fixture.reasoningText,
        selectorTimeoutMs: 120_000,
        confirmationTimeoutMs: 120_000,
        assistantTimeoutMs: 180_000,
        scriptTimeoutMs: 30_000,
        selectors: fixture.selectors,
      }),
    }).then(({ artifactRoot }): DesktopSessionAgentJourneyResult => ({ kind: 'observed', artifactRoot }))
      .catch((error: unknown): DesktopSessionAgentJourneyResult | DesktopSessionAgentJourneyBlocker => {
        if (isDriverUnavailableError(error)) {
          return {
            kind: 'blocked',
            code: 'desktop_session_agent_driver_unavailable',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      });
    if (journey.kind !== 'observed') return journey;
    await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'active' });
    return journey;
  } finally {
    await fixture.cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopSessionAgentCurrentSourceQa()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = resolveDesktopSessionAgentExitCode({
        journey: result,
        identityAsserted: result.kind === 'observed',
      });
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
