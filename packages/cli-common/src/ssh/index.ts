export { safeBashSingleQuote } from './shellQuote.js';
export { SSH_PASSWORD_ENV, ensureSshAskpassScriptPath, buildSshAskpassEnv } from './sshAskpass.js';
export {
  SshKnownHostsStore,
  normalizeKnownHostsText,
  readKnownHostsText,
  readKnownHostsTextSync,
  readKnownHostsTextSyncWithFs,
  writeKnownHostsText,
  writeKnownHostsTextSync,
  writeKnownHostsTextSyncWithFs,
  type SshKnownHostRememberResult,
  type SshKnownHostStatus,
} from './knownHosts.js';
export {
  buildOpenScpCommand,
  buildOpenSshCommand,
  buildSshKeyscanInvocation,
  parseJsonLinesBestEffort,
  redactSshText,
  type OpenSshAuth,
  type OpenSshKnownHostsMode,
} from './openSshTransport.js';

export {
  copyLocalDirectoryToRemoteSync,
  runOpenSshPosixShellCommandSync,
  runOpenSshRemoteCommandSync,
  runRemoteJsonSync,
  runRemoteTextSync,
  sshKeyscanSync,
  type OpenSshCommandResult,
} from './openSshRunner.js';
