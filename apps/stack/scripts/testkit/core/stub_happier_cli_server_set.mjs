/**
 * Source fragment that gives a stub Happier CLI script a `server set` implementation.
 *
 * The fragment expects `args` (the CLI argv slice) to be in scope and runs inside an ESM script,
 * so it may use top-level `await`. It persists the profile the way the real CLI profile writer does
 * (`apps/cli/src/server/serverProfiles.ts`): the active profile switches to the requested id,
 * unrelated profile fields survive, the settings schema is stamped to the supported version, and a
 * `localServerUrl` equal to `serverUrl` is not written because the CLI collapses that split.
 * Keep it aligned with that writer; stack reconciliation checks read the persisted shape.
 *
 * - `ignoreServerSet`: exit successfully without touching settings, like a legacy CLI that does not
 *   understand the stack profile flags.
 * - `callLogFileName`: when set, append each `server set` argv as one JSON line to this file inside
 *   the CLI home before handling the command.
 */
export function buildStubHappierServerSetSource({ ignoreServerSet = false, callLogFileName = null } = {}) {
  return `
if (args[0] === 'server' && args[1] === 'set') {
  const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const home = process.env.HAPPIER_HOME_DIR || process.env.HAPPIER_STACK_CLI_HOME_DIR;
  if (!home) process.exit(2);
  mkdirSync(home, { recursive: true });
  ${callLogFileName ? `appendFileSync(join(home, ${JSON.stringify(callLogFileName)}), JSON.stringify(args) + '\\n');` : ''}
  ${ignoreServerSet ? 'process.exit(0);' : ''}
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? String(args[index + 1] || '') : '';
  };
  const serverId = value('--server-id');
  const serverUrl = value('--server-url');
  const localServerUrl = value('--local-server-url');
  const settingsPath = join(home, 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {};
  const { localServerUrl: previousLocalServerUrl, ...current } = settings.servers?.[serverId] ?? {};
  settings.schemaVersion = Math.max(Number(settings.schemaVersion || 0), 6);
  settings.activeServerId = serverId;
  settings.servers = {
    ...(settings.servers ?? {}),
    [serverId]: {
      ...current,
      id: serverId,
      serverUrl,
      ...(localServerUrl && localServerUrl !== serverUrl ? { localServerUrl } : {}),
      webappUrl: value('--webapp-url'),
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n', 'utf-8');
  process.exit(0);
}
`;
}
