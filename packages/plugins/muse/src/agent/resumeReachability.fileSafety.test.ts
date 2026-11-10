import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDeclaredResumeFileReachability } from '@/daemon/connectedServices/stateSharing/verifyDeclaredResumeFileReachability';

const stateSharingDescriptor = {
  providerId: 'muse', providerSupportStatus: 'supported',
  config: { supported: false, modes: ['isolated'], entries: [] },
  state: { supported: true, modes: ['shared'], entries: [{ path: 'sessions', mode: 'linked' }],
    symlinkUnavailableDegradePolicy: 'block_continuity' },
  authIsolation: { mode: 'materialized_home', secretEntries: [] },
} as const;

describe('resume proof and file-import authority', () => {
  it.each(['file', 'native_session'] as const)('keeps %s evidence distinct after a real declared-file lookup', async proof => {
    const directory = await mkdtemp(join(tmpdir(), 'resume-file-authority-'));
    const selectedFile = join(directory, 'sessions', 'selected.json');
    try {
      await mkdir(join(directory, 'sessions'));
      await writeFile(selectedFile, '{}');
      const result = await verifyDeclaredResumeFileReachability({
        targetMaterializedRoot: directory, stateSharingDescriptor, vendorResumeId: 'selected',
        // Authored Plugin correlation is input to the real filesystem owner.
        // Its declared native proof must not authorize copying the located file.
        verifyResumeReachable: async input => {
          const found = await input.sessionFiles.verifyDeclaredPaths({ paths: [{ path: 'sessions/selected.json', kind: 'file' }] });
          if (!found.found) return { ok: false, reason: 'selected_file_missing' };
          return proof === 'native_session' ? { ok: true, proof: 'native_session' } : { ok: true };
        },
      });
      if (proof === 'file') expect(result).toEqual({ ok: true, resolvedPath: selectedFile, requiredPaths: [selectedFile] });
      else expect(result).toEqual({ ok: false, reason: 'resume_session_file_not_found' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
