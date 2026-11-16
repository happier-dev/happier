// Official cua-sdk-v0.27.5 GitHub release API digests. The CLI and its native
// sidecars sit at the archive root. Keep system discovery first.
export const CUA_CLI_ARCHIVE_SOURCE = {
    kind: 'pinnedArchive', installId: 'dep.cua-cli', version: '0.27.5',
    assetsByPlatform: {
        'darwin-arm64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.27.5/cua-cli-0.27.5-darwin-arm64.tar.gz',
            sha256: 'aec50acb4b8f6f58422c7bad77c3d895593100654fd56405fa0f0e273c699e6f', executableSubpath: 'cua' },
        'darwin-x64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.27.5/cua-cli-0.27.5-darwin-x64.tar.gz',
            sha256: '235c0647d7eab0f41ac5f76a76a4608a0b4fbf5a089401b7f855540da4973e96', executableSubpath: 'cua' },
        'linux-arm64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.27.5/cua-cli-0.27.5-linux-arm64.tar.gz',
            sha256: 'f0e71e2d2083bd49923637b8204535ab51d28dc8bf03ef0a7888392afb145364', executableSubpath: 'cua' },
        'linux-x64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.27.5/cua-cli-0.27.5-linux-x64.tar.gz',
            sha256: '25cd89f45a20f4e9f3468397f214a305d8e9d6c0652f80b7da4c5a430e57b75c', executableSubpath: 'cua' },
        'win32-arm64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.27.5/cua-cli-0.27.5-windows-arm64.zip',
            sha256: '2333e3b738ce9e811ca382c6521d64722fb63ca7eea027fc4ce720034e8ffd23', executableSubpath: 'cua.exe' },
        'win32-x64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.27.5/cua-cli-0.27.5-windows-x64.zip',
            sha256: '50ae31c0ec3ec2118952b6d1168f533da57dfef263628d409064b862c100578a', executableSubpath: 'cua.exe' },
    },
} as const;
