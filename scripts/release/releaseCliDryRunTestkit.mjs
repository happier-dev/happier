import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RELEASE_CLI_DRY_RUN_TIMEOUT_MS = 90_000;

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

export function createReleaseCliDryRunEnv(baseEnv = process.env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-release-cli-dry-run-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  writeExecutable(
    path.join(binDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "fetch" ]; then',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "--abbrev-ref" ] && [ "${3:-}" = "HEAD" ]; then',
      '  printf "dev\\n"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "rev-parse" ]; then',
      '  case "${2:-}" in',
      '    HEAD|origin/dev) printf "dev-sha\\n" ;;',
      '    origin/main) printf "main-sha\\n" ;;',
      '    origin/preview) printf "preview-sha\\n" ;;',
      '    origin/deploy/preview/ui) printf "deploy-preview-ui-sha\\n" ;;',
      '    origin/deploy/preview/server) printf "deploy-preview-server-sha\\n" ;;',
      '    origin/deploy/preview/website) printf "deploy-preview-website-sha\\n" ;;',
      '    origin/deploy/preview/docs) printf "deploy-preview-docs-sha\\n" ;;',
      '    *) echo "unexpected git rev-parse args: $*" >&2; exit 1 ;;',
      '  esac',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "merge-base" ]; then',
      '  printf "main-sha\\n"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "rev-list" ] && [ "${2:-}" = "--count" ]; then',
      '  printf "3\\n"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "diff" ] && [ "${2:-}" = "--name-only" ]; then',
      '  printf "%s\\n" "apps/ui/sources/app.tsx" "apps/server/sources/app.ts" "apps/website/app/page.tsx" "apps/docs/content/docs/release.mdx" "apps/cli/src/index.ts" "apps/stack/src/index.ts" "packages/protocol/src/features/catalog.ts"',
      '  exit 0',
      'fi',
      'echo "unexpected git args: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  return {
    env: {
      ...baseEnv,
      PATH: `${binDir}:${baseEnv.PATH ?? ''}`,
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
