import assert from 'node:assert/strict';
import test from 'node:test';

import { renderNativeExecutionProjection } from './native_execution_projection.mjs';

test('native execution projection contains all POSIX targets and marks automatic command eligibility', () => {
  const output = renderNativeExecutionProjection({
    version: 2,
    targets: [
      {
        name: 'mac', platform: 'posix', ssh: 'mac-host', sshConfigFile: "/tmp/it's.conf",
        repoDir: '/repo path', cliHomeDir: '/home', remotePath: ['/opt/bin', '/usr/bin'],
      },
      {
        name: 'windows', platform: 'windows', ssh: 'win-host',
        repoDir: 'C:/repo', cliHomeDir: 'C:/home', remotePath: [],
      },
    ],
    runtimePlacement: {
      server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' },
    },
    commandExecution: {
      mode: 'auto', targets: ['mac', 'windows'], includeLocal: false, fallback: 'local',
      loadProbeTtlMs: 15000, unavailableProbeTtlMs: 120000,
    },
  });

  assert.match(output, /^HSTACK_EXEC_PROJECTION_VERSION='2'$/m);
  assert.match(output, /^command_mode='auto'$/m);
  assert.match(output, /^dependency_direct_commands='node npm npx pnpm tsc vitest yarn'$/m);
  assert.match(output, /^dependency_corepack_subcommands='npm pnpm yarn'$/m);
  assert.match(output, /^primary_only_direct_commands='git'$/m);
  assert.match(output, /^source_search_direct_commands='find grep rg'$/m);
  assert.match(output, /^validation_direct_commands='tsc vitest'$/m);
  assert.match(output, /^validation_script_families='build check lint test typecheck vitest'$/m);
  assert.match(output, /^execution_provenance_schema_version='1'$/m);
  assert.match(output, /^execution_provenance_filename='provenance\.jsonl'$/m);
  assert.match(output, /^target_count='1'$/m);
  assert.match(output, /^target_1_name='mac'$/m);
  assert.match(output, /^target_1_automatic='1'$/m);
  assert.match(output, /^target_1_ssh_config='\/tmp\/it'"'"'s\.conf'$/m);
  assert.match(output, /^target_1_repo_dir='\/repo path'$/m);
  assert.doesNotMatch(output, /win-host|C:\/repo/);
});

test('native execution projection retains an exact-only POSIX target under local command placement', () => {
  const output = renderNativeExecutionProjection({
    version: 3,
    targets: [{
      name: 'mac-host', platform: 'posix', ssh: 'mac-host',
      repoDir: '/repo', cliHomeDir: '/home', remotePath: ['/usr/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  });

  assert.match(output, /^command_mode='local'$/m);
  assert.match(output, /^target_count='1'$/m);
  assert.match(output, /^target_1_name='mac-host'$/m);
  assert.match(output, /^target_1_sync_name='happier-mac--host'$/m);
  assert.match(output, /^target_1_automatic='0'$/m);
});
