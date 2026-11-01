import { InstallableDependencyDescriptorSchema } from '../descriptor.js';
import type { PinnedArchiveInstallableAsset } from '../sourceKind.js';

export const COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY = 'computer-agent-desktop';
export const COMPUTER_AGENT_DESKTOP_DEP_ID = 'dep.computer-agent-desktop';
export const COMPUTER_AGENT_DESKTOP_VERSION = '1.0.2';

// Official Apache-2.0 native v1.0.2 archives. Retain their complete payload,
// including the macOS helper and Linux clipboard owner; no npm launcher.
function asset(target: string, sha256: string, executableSubpath = 'agent-desktop'): PinnedArchiveInstallableAsset {
  return {
    archiveUrl: `https://github.com/vercel-labs/agent-desktop/releases/download/v${COMPUTER_AGENT_DESKTOP_VERSION}/agent-desktop-v${COMPUTER_AGENT_DESKTOP_VERSION}-${target}.tar.gz`,
    sha256,
    executableSubpath,
  };
}

export const COMPUTER_AGENT_DESKTOP_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY,
  key: COMPUTER_AGENT_DESKTOP_INSTALLABLE_KEY,
  kind: 'dep', version: '1', capabilityId: COMPUTER_AGENT_DESKTOP_DEP_ID,
  display: { name: 'Agent Desktop' },
  description: 'Pinned native desktop accessibility, screen capture and computer input driver.',
  source: { kind: 'pinned_archive', version: COMPUTER_AGENT_DESKTOP_VERSION, assetsByPlatform: {
    'darwin-arm64': asset('aarch64-apple-darwin', '7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19'),
    'darwin-x64': asset('x86_64-apple-darwin', '8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121'),
    'linux-arm64': asset('aarch64-unknown-linux-gnu', '864cb782e0afc8bf0df19622016b24bdbd1a83fc7749f784ee82aa49a7f845eb'),
    'linux-x64': asset('x86_64-unknown-linux-gnu', 'ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4'),
    'win32-arm64': asset('aarch64-pc-windows-msvc', 'a0ecd6e17e60a0bcfbb45533a72f2d3a7a73508769588273ef08b0477d2b9687', 'agent-desktop.exe'),
    'win32-x64': asset('x86_64-pc-windows-msvc', '2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222', 'agent-desktop.exe'),
  } },
  binary: { commands: ['agent-desktop'], systemFirst: false, managedFallback: true },
  defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' },
  consent: { install: 'required', update: 'required' },
});
