// Official v2.2.1 SHA256SUMS; retain the archive root so limactl can find its
// adjacent share/lima guest agents and templates. QEMU stays a separate tool.
export const limaArchiveSource = {
  kind: 'pinnedArchive', installId: 'dep.lima', version: '2.2.1',
  assetsByPlatform: {
    'darwin-arm64': {
      archiveUrl: 'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz',
      sha256: '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e', executableSubpath: 'bin/limactl',
    },
    'darwin-x64': {
      archiveUrl: 'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-x86_64.tar.gz',
      sha256: '6b776e4bc41f358e6ee01fefcc78e2eb26f11635a0fcff632234af77a566c6c4', executableSubpath: 'bin/limactl',
    },
    'linux-arm64': {
      archiveUrl: 'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Linux-aarch64.tar.gz',
      sha256: 'fbcf4d127936666aa2cf6013b663c250431f2a59394757b404070f8d6a160e10', executableSubpath: 'bin/limactl',
    },
    'linux-x64': {
      archiveUrl: 'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Linux-x86_64.tar.gz',
      sha256: 'b391ac7fcac2b2a5a1628107756463188ded4d18d3104a40a66a8bb6fec01bcb', executableSubpath: 'bin/limactl',
    },
  },
} as const;
