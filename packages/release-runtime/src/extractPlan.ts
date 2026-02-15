export type PlannedCommand = Readonly<{ cmd: string; args: string[] }>;

export function planArchiveExtraction(params: Readonly<{
  archiveName: string;
  archivePath: string;
  destDir: string;
  os: 'linux' | 'darwin' | 'windows';
}>): Readonly<{ requiredCommand: 'tar' | 'powershell'; command: PlannedCommand }> {
  const name = String(params.archiveName ?? '').trim();
  const archivePath = String(params.archivePath ?? '').trim();
  const destDir = String(params.destDir ?? '').trim();
  const os = String(params.os ?? '').trim().toLowerCase();

  if (!name) throw new Error('[extract] archiveName is required');
  if (!archivePath) throw new Error('[extract] archivePath is required');
  if (!destDir) throw new Error('[extract] destDir is required');
  if (os !== 'linux' && os !== 'darwin' && os !== 'windows') {
    throw new Error(`[extract] unsupported os: ${os}`);
  }

  if (name.toLowerCase().endsWith('.zip')) {
    if (os !== 'windows') {
      throw new Error(`[extract] .zip archives are supported only on windows (got ${os})`);
    }
    const command = `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${destDir}" -Force`;
    return {
      requiredCommand: 'powershell',
      command: {
        cmd: 'powershell',
        args: ['-NoProfile', '-Command', command],
      },
    };
  }

  if (name.toLowerCase().endsWith('.tar.gz')) {
    return {
      requiredCommand: 'tar',
      command: {
        cmd: 'tar',
        args: ['-xzf', archivePath, '-C', destDir],
      },
    };
  }

  throw new Error(`[extract] unsupported archive extension: ${name}`);
}

