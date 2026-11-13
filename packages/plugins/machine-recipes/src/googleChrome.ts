import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { packageSelection } from './packageSelection.js';

const packages = packageSelection({
  apt: [{ name: 'google-chrome-stable' }],
  dnf: [{ name: 'google-chrome-stable' }],
  brew: [{ name: 'google-chrome', kind: 'cask' }],
  winget: [{ name: 'Google.Chrome', source: 'winget', scope: 'user' }],
});

/** Bot-owned Chrome. Happier Browser retains its own managed Chromium. */
export const googleChrome: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Google Chrome', software: true, icon: 'browser',
  description: 'The browser, for agents that test sites and take screenshots.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...packages,
  // Google publishes Chrome outside the distribution repositories. Share the
  // package owner's manager selection; removing Chrome retains vendor trust.
  // Vendor source/key: chromium chrome/installer/linux/common/{apt,rpm}.include and
  // https://www.google.com/linuxrepositories/ (verified 2026-11-13).
  steps: packages.steps.flatMap<MachineRecipeV1['steps'][number]>(step => step.kind === 'package' && step.manager === 'apt' ? [{
    id: 'chrome-apt-prerequisites', kind: 'package', manager: 'apt', when: step.when,
    packages: [{ name: 'ca-certificates' }, { name: 'curl' }, { name: 'gpg' }],
  }, {
    id: 'chrome-apt-source', kind: 'packageSource', manager: 'apt', when: step.when,
    path: '/etc/apt/sources.list.d/google-chrome.sources', keyPath: '/usr/share/keyrings/google-chrome.gpg',
    url: 'https://dl.google.com/linux/chrome-stable/deb/', suite: 'stable', components: ['main'], architectures: ['amd64', 'arm64'],
    keyUrl: 'https://dl.google.com/linux/linux_signing_key.pub',
    keyFingerprint: 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796',
  }, step] : step.kind === 'package' && step.manager === 'dnf' ? [{
    id: 'chrome-dnf-prerequisites', kind: 'package', manager: 'dnf', when: step.when,
    packages: [{ name: 'ca-certificates' }, { name: 'curl' }, { name: 'gnupg2' }],
  }, {
    id: 'chrome-dnf-source', kind: 'packageSource', manager: 'dnf', when: step.when,
    path: '/etc/yum.repos.d/google-chrome.repo', keyPath: '/etc/pki/rpm-gpg/google-chrome.asc',
    repositoryId: 'google-chrome', url: 'https://dl.google.com/linux/chrome/rpm/stable/$basearch',
    architectures: ['x86_64', 'aarch64'], keyUrl: 'https://dl.google.com/linux/linux_signing_key.pub',
    keyFingerprint: 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796',
  }, step] : [step]),
};
