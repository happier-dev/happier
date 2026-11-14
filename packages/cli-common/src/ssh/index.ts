export {
  discoverConfiguredSshHosts,
  type DiscoverConfiguredSshHostsFs,
  type DiscoverConfiguredSshHostsOptions,
  type DiscoveredSshHost,
  type DiscoveredSshHostSource,
} from './discoverConfiguredSshHosts.js';
export { safeBashSingleQuote } from './shellQuote.js';
export { SSH_PASSWORD_ENV, ensureSshAskpassScriptPath, buildSshAskpassEnv } from './sshAskpass.js';
export {
  SshKnownHostsStore,
  resolveDefaultKnownHostsPath,
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
  closeOpenSshLocalPortForward,
  openSshLocalPortForward,
  withOpenSshLocalPortForward,
  type CloseOpenSshLocalPortForwardRequest,
  type OpenSshLocalPortForwardDeps,
  type OpenSshLocalPortForwardHandle,
  type OpenSshLocalPortForwardRequest,
} from './openSshLocalPortForward.js';

export {
  OpenSshExecutionError,
  runOpenSshRemoteCommand,
  transferOpenSshFile,
  copyLocalDirectoryToRemoteSync,
  sshKeyscanSync,
  type OpenSshCommandResult,
  type OpenSshExecutionErrorCode,
} from './openSshRunner.js';
