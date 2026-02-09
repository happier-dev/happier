import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');
const sourcesRoot = path.join(repoRoot, 'apps/ui/sources');

const forbidden = [
  "@/-zen",
  "@/-session",
  "@/components/session/",
  "@/sync/permissions",
  "@/sync/profiles",
  "@/sync/pending",
  "@/sync/models",
  "@/sync/messages",
  "@/sync/server",
  "@/sync/activeServerSwitch",
  "@/sync/multiServer",
  "@/sync/terminalSettings",
  "@/sync/windowsRemoteSessionConsole",
  "@/sync/capabilitiesProtocol",
  "@/sync/buildSendMessageMeta",
  "@/sync/unread",
  "@/sync/typesMessage",
  "@/sync/typesMessageMeta",
  "@/sync/secretBindings",
  "@/sync/localSettings",
  "@/sync/debugSettings",
  "@/sync/secretSettings",
  "@/sync/purchases",
  "@/sync/revenueCat",
  "@/sync/prompt",
  "@/sync/feedTypes",
  "@/sync/friendTypes",
  "@/sync/sharingTypes",
  "@/sync/suggestionFile",
  "@/sync/suggestionCommands",
  "@/sync/appConfig",
  "@/sync/artifactTypes",
  "@/sync/describeEffectiveModelMode",
  "@/sync/describeEffectivePermissionMode",
  "@/sync/controlledByUserTransitions",
  "@/sync/changesPlanner",
  "@/sync/changesApplier",
  "@/sync/socketReconnectViaChanges",
  "@/sync/connectionManager",
  "@/sync/concurrentSessionCache",
  "@/sync/projectManager",
  "@/components/tools/views",
  "@/components/tools/knownTools",
  "@/components/tools/utils"
];

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    if (ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx|mts|cts|js|jsx)$/.test(ent.name)) out.push(full);
  }
}

const files: string[] = [];
walk(sourcesRoot, files);

const violations: string[] = [];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = file.replace(`${repoRoot}/`, '');
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const token of forbidden) {
      if (line.includes(token)) {
        violations.push(`${rel}:${idx + 1}: contains '${token}'`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error('Forbidden import/path references found:');
  for (const v of violations) console.error(v);
  process.exit(1);
}

console.log('No forbidden import/path references found.');
