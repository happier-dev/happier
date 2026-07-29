import { open } from 'node:fs/promises';

type DurableFileHandle = Readonly<{
  sync(): Promise<void>;
  close(): Promise<void>;
}>;

type OpenFile = (path: string, flags: 'r' | 'r+') => Promise<DurableFileHandle>;

export async function flushFileDurably(
  path: string,
  options: Readonly<{
    platform?: NodeJS.Platform;
    openFile?: OpenFile;
  }> = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const handle = await (options.openFile ?? open)(path, platform === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function flushDirectoryDurably(
  path: string,
  options: Readonly<{
    platform?: NodeJS.Platform;
    openFile?: OpenFile;
  }> = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return;
  await flushFileDurably(path, { ...options, platform });
}
