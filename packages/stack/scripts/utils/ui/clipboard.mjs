import { commandExists } from '../proc/commands.mjs';
import { run } from '../proc/proc.mjs';

export async function clipboardAvailable() {
  if (process.platform === 'darwin') {
    return await commandExists('pbcopy');
  }
  if (process.platform === 'linux') {
    return (await commandExists('wl-copy')) || (await commandExists('xclip'));
  }
  return false;
}

export async function copyTextToClipboard(text) {
  const s = String(text ?? '');
  if (!s) return { ok: false, reason: 'empty' };

  if (process.platform === 'darwin') {
    if (!(await commandExists('pbcopy'))) return { ok: false, reason: 'pbcopy not found' };
    await run('pbcopy', [], { input: s });
    return { ok: true };
  }

  if (process.platform === 'linux') {
    if (await commandExists('wl-copy')) {
      await run('wl-copy', [], { input: s });
      return { ok: true };
    }
    if (await commandExists('xclip')) {
      await run('xclip', ['-selection', 'clipboard'], { input: s });
      return { ok: true };
    }
    return { ok: false, reason: 'no clipboard tool found' };
  }

  return { ok: false, reason: `unsupported platform: ${process.platform}` };
}

