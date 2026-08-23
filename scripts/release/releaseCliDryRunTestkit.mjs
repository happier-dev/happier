import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RELEASE_CLI_DRY_RUN_TIMEOUT_MS = 90_000;

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

export function createReleaseCliDryRunEnv(baseEnv = process.env, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-release-cli-dry-run-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const diffPaths =
    Array.isArray(options.diffPaths) && options.diffPaths.length > 0
      ? options.diffPaths
      : [
          'apps/ui/sources/app.tsx',
          'apps/server/sources/app.ts',
          'apps/website/app/page.tsx',
          'apps/docs/content/docs/release.mdx',
          'apps/cli/src/index.ts',
          'apps/stack/src/index.ts',
          'packages/protocol/src/features/catalog.ts',
        ];

  writeExecutable(
    path.join(binDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "ls-remote" ]; then',
      '  if [ "$#" = 3 ] && [ "${3:-}" = "refs/heads/dev" ]; then',
      '    printf "%s\\t%s\\n" "2222222222222222222222222222222222222222" "refs/heads/dev"',
      '    exit 0',
      '  fi',
      '  if [ "$#" = 3 ] && [ "${3:-}" = "refs/heads/preview" ]; then',
      '    printf "%s\\t%s\\n" "3333333333333333333333333333333333333333" "refs/heads/preview"',
      '    exit 0',
      '  fi',
      '  printf "%s\\t%s\\n" \\',
      '    "1111111111111111111111111111111111111111" "refs/heads/main" \\',
      '    "2222222222222222222222222222222222222222" "refs/heads/dev" \\',
      '    "3333333333333333333333333333333333333333" "refs/heads/preview" \\',
      '    "4444444444444444444444444444444444444444" "refs/tags/cli-v0.2.0" \\',
      '    "5555555555555555555555555555555555555555" "refs/tags/stack-v0.2.0" \\',
      '    "6666666666666666666666666666666666666666" "refs/tags/server-v0.2.0" \\',
      '    "7777777777777777777777777777777777777777" "refs/tags/ui-web-v0.2.0" \\',
      '    "8888888888888888888888888888888888888888" "refs/tags/plugin-sdk-v0.1.0" \\',
      '    "9999999999999999999999999999999999999999" "refs/tags/sdk-v0.1.0"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "fetch" ]; then',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "cat-file" ] && [[ "${2:-}" == --batch-check=* ]]; then',
      '  while IFS= read -r object_id; do',
      '    [ -n "$object_id" ] && printf "%s commit\\n" "1111111111111111111111111111111111111111"',
      '  done',
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
      'if [ "${1:-}" = "tag" ] && [ "${2:-}" = "--merged" ] && [ "${4:-}" = "--list" ]; then',
      '  case "${5:-}" in',
      '    ui-web-v*) printf "%s\\n" "ui-web-v0.2.0" "ui-web-v0.2.1-preview.1.1" "ui-web-v0.2.1-dev.1.1" ;;',
      '    cli-v*) printf "%s\\n" "cli-v0.2.0" "cli-v0.2.1-preview.1.1" "cli-v0.2.1-dev.1.1" ;;',
      '    stack-v*) printf "%s\\n" "stack-v0.2.0" "stack-v0.2.1-preview.1.1" "stack-v0.2.1-dev.1.1" ;;',
      '    server-v*) printf "%s\\n" "server-v0.2.0" "server-v0.2.1-preview.1.1" "server-v0.2.1-dev.1.1" ;;',
      '    plugin-sdk-v*) printf "%s\\n" "plugin-sdk-v0.1.0" "plugin-sdk-v0.1.0-preview.1.1" "plugin-sdk-v0.1.0-dev.1.1" ;;',
      '    sdk-v*) printf "%s\\n" "sdk-v0.1.0" "sdk-v0.1.0-preview.1.1" "sdk-v0.1.0-dev.1.1" ;;',
      '    *) echo "unexpected git tag args: $*" >&2; exit 1 ;;',
      '  esac',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "rev-list" ] && [ "${2:-}" = "--parents" ]; then',
      '  printf "%s %s %s %s %s %s %s\\n" "${3:-}" "4444444444444444444444444444444444444444" "5555555555555555555555555555555555555555" "6666666666666666666666666666666666666666" "7777777777777777777777777777777777777777" "8888888888888888888888888888888888888888" "9999999999999999999999999999999999999999"',
      '  printf "%s\\n" "4444444444444444444444444444444444444444" "5555555555555555555555555555555555555555" "6666666666666666666666666666666666666666" "7777777777777777777777777777777777777777" "8888888888888888888888888888888888888888" "9999999999999999999999999999999999999999"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "rev-list" ] && [ "${2:-}" = "-n" ] && [ "${3:-}" = "1" ]; then',
      '  printf "%s-commit\\n" "${4:-unknown}"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "rev-list" ] && [ "${2:-}" = "--count" ]; then',
      '  case "${3:-}" in',
      '    *dev.1.1-commit..*) printf "0\\n" ;;',
      '    *preview.1.1-commit..*) printf "1\\n" ;;',
      '    *0.2.0-commit..*) printf "2\\n" ;;',
      '    *) printf "3\\n" ;;',
      '  esac',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "diff" ] && [ "${2:-}" = "--name-only" ]; then',
      `  printf "%s\\n" ${diffPaths.map((value) => JSON.stringify(value)).join(' ')}`,
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
