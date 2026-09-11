import type { CommandSuiteEntry } from './runCommandSuite.ts';

export type SharedPackageTestMode = 'local' | 'ci';

export interface SharedPackageTestCommand extends CommandSuiteEntry {
  /** The command remains mandatory in CI, whose workflow provisions its external prerequisite. */
  requiresCiProvisioning?: true;
}

/**
 * Canonical command inventory for package-level tests that do not own a dedicated CI job.
 * The executor, test-wiring classifier, and workflow parity checks all consume this list.
 */
export const SHARED_PACKAGE_TEST_COMMANDS = [
  { id: 'privacy-kit:test', args: ['workspace', 'privacy-kit', 'test'] },
  {
    id: 'privacy-kit:bun',
    args: ['workspace', 'privacy-kit', 'test:runtime:bun'],
    requiresCiProvisioning: true,
  },
  { id: 'protocol', args: ['workspace', '@happier-dev/protocol', 'test'] },
  { id: 'peer-mediation', args: ['workspace', '@happier-dev/peer-mediation', 'test'] },
  { id: 'peer-transport', args: ['workspace', '@happier-dev/peer-transport', 'test'] },
  { id: 'transfers', args: ['workspace', '@happier-dev/transfers', 'test'] },
  { id: 'voice-modelpacks', args: ['workspace', '@happier-dev/voice-modelpacks', 'test'] },
  { id: 'terminal-native', args: ['workspace', '@happier-dev/terminal-native', 'test'] },
  { id: 'sherpa-native', args: ['workspace', '@happier-dev/sherpa-native', 'test'] },
  { id: 'agents', args: ['workspace', '@happier-dev/agents', 'test'] },
  { id: 'cli-common', args: ['workspace', '@happier-dev/cli-common', 'test'] },
  { id: 'release-runtime', args: ['workspace', '@happier-dev/release-runtime', 'test'] },
  { id: 'support', args: ['workspace', '@happier-dev/support', 'test'] },
  { id: 'connection-supervisor', args: ['workspace', '@happier-dev/connection-supervisor', 'test'] },
  { id: 'bootstrap', args: ['workspace', '@happier-dev/bootstrap', 'test'] },
  { id: 'channels-protocol:build', args: ['workspace', '@happier-dev/channels-protocol', 'build'] },
  { id: 'channels-protocol:test', args: ['workspace', '@happier-dev/channels-protocol', 'test'] },
  { id: 'triage-protocol', args: ['workspace', '@happier-dev/triage-protocol', 'test'] },
  { id: 'triage-sources', args: ['workspace', '@happier-dev/triage-sources', 'test'] },
  { id: 'ssh-native', args: ['workspace', '@happier-dev/ssh-native', 'test'] },
  { id: 'audio-stream-native', args: ['workspace', '@happier-dev/audio-stream-native', 'test'] },
  { id: 'desktop', args: ['workspace', '@happier-dev/desktop', 'test'] },
  { id: 'desktop-native', args: ['workspace', '@happier-dev/desktop-native', 'test'] },
  { id: 'iroh-native', args: ['workspace', '@happier-dev/iroh-native', 'test'] },
  { id: 'docs:test', args: ['workspace', 'docs', 'test'] },
  { id: 'docs:content', args: ['workspace', 'docs', 'check:content'] },
  {
    id: 'website',
    args: ['workspace', '@happier-dev/website', 'test'],
    requiresCiProvisioning: true,
  },
  { id: 'test-harness', args: ['workspace', '@happier-dev/tests', 'test:scripts:self'] },
  { id: 'relay-server', args: ['--cwd', 'packages/relay-server', 'test'] },
] as const satisfies readonly SharedPackageTestCommand[];

export function selectSharedPackageTestCommands(
  mode: SharedPackageTestMode,
): readonly SharedPackageTestCommand[] {
  if (mode === 'ci') return SHARED_PACKAGE_TEST_COMMANDS;
  return SHARED_PACKAGE_TEST_COMMANDS.filter((command) => !('requiresCiProvisioning' in command));
}
