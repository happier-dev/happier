import { writeKnownHostsTextSync } from '../../ssh/knownHosts.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import {
  hostTokenContains,
  parseKnownHostsText,
  resolveSshKnownHostTrust,
  type ResolvedSshHostTrust,
} from './sshHostTrustResolution.js';

export {
  extractFirstScannedSshKnownHostLine,
  parseSshKnownHostLine,
  resolveSshKnownHostTrust,
  type ParsedSshKnownHostLine,
  type ResolvedSshHostTrust,
} from './sshHostTrustResolution.js';

/** Commit the observed trust decision against current contents, never its pre-prompt snapshot. */
export function persistSshKnownHostTrust(params: Readonly<{
  knownHostsPath: string | undefined;
  trust: Exclude<ResolvedSshHostTrust, { status: 'rejected' }>;
  trustedHostKey?: string;
}>): void {
  writeKnownHostsTextSync(params.knownHostsPath, currentText => {
    const approved = params.trust;
    // Seeding helpers can append a second key for the same host. Inspect every
    // matching line so a new conflict cannot hide behind the original first entry.
    if (approved.status === 'prompt' && parseKnownHostsText(currentText).some(entry =>
      entry.keyType === approved.scanned.keyType && hostTokenContains(entry.host, approved.scanned.host)
      && entry.key !== approved.scanned.key && entry.fingerprint !== approved.existingFingerprint)) {
      throw new SystemTaskExecutionError('trusted_host_key_mismatch', 'Saved SSH host trust changed while approval was pending. Verify the host again.');
    }
    const current = resolveSshKnownHostTrust({
      knownHostsText: currentText,
      scannedHostKeyLine: params.trust.scanned.line,
      trustedHostKey: params.trustedHostKey,
    });
    if (current.status === 'rejected') {
      throw new SystemTaskExecutionError(
        current.reason === 'invalidTrustedHostKey' ? 'invalid_trusted_host_key' : 'trusted_host_key_mismatch',
        current.message,
      );
    }
    if (current.status === 'prompt' && (params.trust.status !== 'prompt'
      || current.promptKind !== params.trust.promptKind
      || current.existingFingerprint !== params.trust.existingFingerprint)) {
      throw new SystemTaskExecutionError('trusted_host_key_mismatch', 'Saved SSH host trust changed while approval was pending. Verify the host again.');
    }
    return current.nextKnownHostsText;
  });
}
