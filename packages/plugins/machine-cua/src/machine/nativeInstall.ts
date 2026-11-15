// Official cua-sdk-v0.3.0 GitHub release API digests; cd-cua-sdk.yml packages
// only cua (cua.exe on Windows) at the archive root. Keep system discovery first.
export const CUA_CLI_ARCHIVE_SOURCE = {
    kind: 'pinnedArchive', installId: 'dep.cua-cli', version: '0.3.0',
    assetsByPlatform: {
        'darwin-arm64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.3.0/cua-cli-0.3.0-darwin-arm64.tar.gz',
            sha256: '3dec79903b729c6e158e9e40c86a4a66b18159d326d1eb5231cca381b086f271', executableSubpath: 'cua' },
        'darwin-x64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.3.0/cua-cli-0.3.0-darwin-x64.tar.gz',
            sha256: 'f56368cc92ec9d01f38fd052068c825acb1e75f8a0f618dcad9d3eec344f1548', executableSubpath: 'cua' },
        'linux-arm64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.3.0/cua-cli-0.3.0-linux-arm64.tar.gz',
            sha256: '0637fd30a4a68b39d6649858f3d78709cef82133783857b05e1ea816a610f4c1', executableSubpath: 'cua' },
        'linux-x64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.3.0/cua-cli-0.3.0-linux-x64.tar.gz',
            sha256: '57597d4f6c29fbd2e13d59fe523fb8b7cfcf4c87a1714ad13a70aa971fc5132a', executableSubpath: 'cua' },
        'win32-arm64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.3.0/cua-cli-0.3.0-windows-arm64.zip',
            sha256: '935ad97157511cbcf2b864107e087a90a1ecd992721bc99bf8937c0f1ff3f79d', executableSubpath: 'cua.exe' },
        'win32-x64': { archiveUrl: 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.3.0/cua-cli-0.3.0-windows-x64.zip',
            sha256: '893b5c7bc8489bf78df34426338f860b92859ba4c36cecfd93e7b64039b962a6', executableSubpath: 'cua.exe' },
    },
} as const;
