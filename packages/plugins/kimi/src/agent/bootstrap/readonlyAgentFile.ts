import { writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/runtime/tempTextFile';

export function buildKimiReadOnlyAgentFileContent(): string {
  return (
    `version: 1\n` +
    `agent:\n` +
    `  extend: default\n` +
    `  name: happier-read-only\n` +
    `  exclude_tools:\n` +
    `    - "kimi_cli.tools.shell:Shell"\n` +
    `    - "kimi_cli.tools.file:WriteFile"\n` +
    `    - "kimi_cli.tools.file:StrReplaceFile"\n`
  );
}

export function ensureKimiReadOnlyAgentFile(): string {
  return writeSecureTempTextFileSync({
    prefix: 'happier-kimi-readonly-agent',
    suffix: '.yaml',
    contents: buildKimiReadOnlyAgentFileContent(),
  });
}
